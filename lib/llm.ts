/**
 * LLM 客户端：多提供商调用与降级
 *
 * 调用流程：
 *   1. 候选 provider 优先级：activeProvider -> working=true -> 未测试但有 Key/无需Key
 *   2. 按 provider.protocol 走对应协议（openai/gemini）
 *   3. 失败则更新本地 working=false 并尝试下一个 provider
 *
 * testProvider() / refreshProviderStatuses() 用于定时健康检查
 * （"定时收集保存在本地"——结果写回 .llm-config.json）。
 */

import { readConfig, updateConfigSafely, setActiveProvider } from "./llm-config";
import {
  LLM_PROVIDERS,
  type LLMProvider,
  GROQ_PROVIDER_IDS,
  GEMINI_PROVIDER_IDS,
  QWEN_PROVIDER_IDS,
  PREFERRED_ACTIVE_ORDER,
} from "./llm-providers";
import { saveCachedModels, getCachedModels } from "./db/llm-model-cache";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  text: string;
  providerId: string;
  providerName: string;
  model: string;
}

/**
 * 判断错误是否为瞬时错误（rate limit / 服务端错误 / 超时 / 网络）。
 * 瞬时错误应设置冷却期，到期后自动重试，而不是永久标记 working=false。
 */
function isTransientError(msg: string): boolean {
  return /429|HTTP 5\d\d|超时|timeout|abort|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|rate.?limit|temporarily/i.test(
    msg
  );
}

/**
 * 判断错误是否为永久错误（Key 无效 / 模型不存在 / 鉴权失败）。
 * 这类错误不会因重试而消失，应直接标记 working=false 跳过。
 * 注意：额度耗尽（HTTP 403 "Free quota exhausted" 等）不是永久错误，
 * 应走冷却/跳过逻辑，故此处排除 isQuotaExhausted 命中的情况。
 */
function isPermanentError(msg: string): boolean {
  if (isQuotaExhausted(msg)) return false;
  return /HTTP 401|HTTP 403|HTTP 404|invalid api key|unauthorized|forbidden|not found|模型不存在/i.test(
    msg
  );
}

/** 根据错误类型返回冷却时长（毫秒） */
function getCooldownMs(msg: string): number {
  // 429 限流：5 分钟（OpenRouter 免费层共享配额，需较长时间恢复）
  if (/429|rate.?limit/i.test(msg)) return 5 * 60 * 1000;
  // 5xx 服务端错误：30 秒后重试
  if (/HTTP 5\d\d/i.test(msg)) return 30 * 1000;
  // 超时 / 网络：1 分钟后重试
  if (/超时|timeout|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)) return 60 * 1000;
  // 默认：2 分钟
  return 2 * 60 * 1000;
}

/** 备用链路单 provider 子超时（毫秒）。主模型额度/限流为快速失败（非 50s 拖死），剩余时间足够兜底一个或多个模型，同时严守 Vercel 60s 函数上限。 */
const FALLBACK_TIMEOUT_MS = 30_000;

/**
 * 判断错误是否为「免费额度耗尽」（区别于普通限流）。
 * 百炼额度耗尽通常返回 HTTP 429，报文含余额/额度/quota/insufficient 等字眼；
 * 也覆盖模型在所选站点不存在（404 / not found）的情况——同样应跳过该模型兜底。
 * 这类错误短期内不会因重试恢复，应跳过该模型、切换到同家族其他模型或其他家族。
 */
function isQuotaExhausted(msg: string): boolean {
  return /余额|额度|balance|quota|insufficient|free.{0,6}quota|exhausted|资源.*不足|account.*limit|exceeded/i.test(
    msg
  );
}

/**
 * 单个 provider 调用的子超时（毫秒）。
 *
 * ⚠️ 必须小于 Vercel 函数的 maxDuration（stock-report 路由设为 60s，
 * 也是 Hobby 计划硬上限）。否则 Vercel 会先杀掉整个函数，我们的子超时
 * 根本来不及触发，前端只会收到"连接被掐断"的网络错误而非正常 502。
 *
 * 这里取 50s，给函数留出 ~10s 余量；某 provider 单次生成超过 50s 即 abort，
 * 调用方 catch 后返回清晰的报错信息（而非静默超时）。
 */
const PROVIDER_TIMEOUT_MS = 50_000;

/**
 * 中国大陆 API 的 provider（部署在海外节点如 Vercel 默认区域时可能网络不可达/超时）。
 * 注意：通义千问/百炼已改用国际站端点（dashscope-intl，新加坡），海外可直连，
 * 故 qwen-* 不再列入此名单（其超时不再是 GFW 阻断，无需中国特色报错）。
 */
const CN_PROVIDER_IDS = [
  "zhipu-1",
  "zhipu-2",
  "kimi-1",
  "doubao-1",
];

/**
 * 解析原始 API Key 字符串为 key 池。
 * 支持用逗号 / 分号 / 换行 / 空格分隔多个 key，便于同一 provider 配置多个 key 轮询：
 * 成倍放大免费额度，并在单个 key 限流时自动切换到下一个。
 */
function parseKeyPool(apiKeyRaw: string | undefined): string[] {
  return (apiKeyRaw ?? "")
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** 多 key 轮询游标（模块级，同实例内尽量均匀分配请求到不同 key） */
let keyCursor = 0;
/** 每 key 瞬时错误冷却（内存，仅用于同实例内跳过已知限流的 key；冷启动会重置，不影响正确性） */
const keyCooldowns = new Map<string, Map<string, number>>();

/**
 * 用 key 池调用 provider：
 * - 轮询选取当前未冷却的 key；
 * - 遇到限流(429)/瞬时错误自动换下一个 key 重试；
 * - 全部 key 失败后抛出，由调用方决定是否冷却整个 provider。
 */
async function callWithKeyPool(
  provider: LLMProvider,
  apiKeyRaw: string | undefined,
  messages: LLMMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
): Promise<string> {
  const pool = parseKeyPool(apiKeyRaw);
  if (pool.length === 0) {
    throw new Error(`活跃模型 ${provider.name} 未配置 API Key。`);
  }

  const now = Date.now();
  let cds = keyCooldowns.get(provider.id);
  if (!cds) {
    cds = new Map<string, number>();
    keyCooldowns.set(provider.id, cds);
  }

  // 选起始 key：从游标起找第一个未冷却的 key
  let start = 0;
  for (let i = 0; i < pool.length; i++) {
    const idx = (keyCursor + i) % pool.length;
    const cd = cds.get(pool[idx]);
    if (!cd || cd <= now) {
      start = idx;
      break;
    }
  }

  let lastErr: Error | null = null;
  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const key = pool[idx];
    try {
      const text = await callProviderWithTimeout(provider, key, messages, options);
      keyCursor = (idx + 1) % pool.length;
      return text;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastErr = e;
      // 限流：记录该 key 冷却，避免短期内重复打满同一 key
      if (/429|rate.?limit/i.test(e.message)) {
        cds.set(key, now + getCooldownMs(e.message));
      }
      // 继续尝试下一个 key
    }
  }

  throw new Error(
    `${provider.name} 全部 ${pool.length} 个 Key 均调用失败：${lastErr?.message ?? "无可用 Key"}`
  );
}


/**
 * 按字符估算 token 数（偏保守，用于防止 413 低估）。
 * CJK 字符按 ~2 token/字高估（中文 tokenizer 通常 1.3–2 token/字），
 * ASCII 按 ~4 字符/token 估算。高估只会让 max_tokens 偏小（报告略短），
 * 低估则可能导致请求超窗被拒（413），故宁高勿低。
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0x3000 && code <= 0x30ff) || // CJK 标点 / 假名
      (code >= 0xff00 && code <= 0xffef) // 全角字符
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.ceil(cjk * 2 + ascii / 4);
}

/**
 * 已知小窗口 / Agent 模型的上下文窗口兜底表（按 model slug 精确匹配）。
 * 这些模型经 API 返回的 context_window 不一定可靠，或 Agent 内部会额外
 * 拼接系统提示/工具定义，故直接用确定的窗口值，避免 413。
 */
const MODEL_CONTEXT_OVERRIDES: Record<string, number> = {
  "compound-beta": 128_000,
  "compound-beta-mini": 32_000,
};

/** 未知模型时的保守兜底窗口（够大，不会误伤 Gemini/DeepSeek 等长窗口模型） */
const SAFE_CONTEXT_WINDOW = 128_000;

/**
 * 把请求的 maxTokens 钳制在模型上下文窗口内：
 *   max_tokens ≤ context_window − 估计 prompt token − 余量(headroom)
 * 余量给模型内部开销（系统提示/工具定义等）留空间；compound 类 Agent 模型
 * 额外多留，因其会在请求外再拼入工具与检索上下文。
 * 返回至少为 256，避免模型完全无输出空间。
 */
function resolveMaxTokens(
  provider: LLMProvider,
  messages: LLMMessage[],
  requested: number
): number {
  const modelLower = provider.model.toLowerCase();
  const ctx =
    MODEL_CONTEXT_OVERRIDES[modelLower] ??
    (provider.contextWindow && provider.contextWindow > 0
      ? provider.contextWindow
      : SAFE_CONTEXT_WINDOW);

  let promptTokens = 0;
  for (const m of messages) promptTokens += estimateTokens(m.content || "");

  let headroom = 1024;
  if (modelLower.includes("compound")) headroom += 4000;

  const maxAllowed = Math.floor(ctx - promptTokens - headroom);
  // TPM 倒推的单次输出硬性上限（仅部分模型设置，如 Groq gpt-oss-120b TPM=8000）
  const outCap = provider.maxOutputTokens && provider.maxOutputTokens > 0
    ? provider.maxOutputTokens
    : Infinity;
  // 上限 12000 防止极小值；下限 256 保证至少有一点输出（Gemini/gpt-oss 支持 32K~65K 输出）
  return Math.max(256, Math.min(requested, maxAllowed, 12000, outCap));
}

/**
 * 包装 callProvider，加上单 provider 子超时。
 * 子超时触发时 abort 当前 fetch 并抛出超时错误，由调用方 catch 后 fallback。
 * 外部 signal（总超时）触发时也会联动 abort。
 */
async function callProviderWithTimeout(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
): Promise<string> {
  const controller = new AbortController();
  // 外部 signal 联动：总超时触发时也取消当前 provider 调用
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  );
  try {
    return await callProvider(provider, apiKey, messages, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    // 区分：子超时 vs 外部 signal 触发 vs 其他错误
    if (controller.signal.aborted && !options.signal?.aborted) {
      if (CN_PROVIDER_IDS.includes(provider.id)) {
        throw new Error(
          `${provider.name} 单次调用超时 (${PROVIDER_TIMEOUT_MS}ms)：该模型 API 位于中国大陆，` +
            `当前部署节点（如 Vercel 海外区域）可能网络受限无法访问。建议改用 Gemini / OpenRouter / Groq，` +
            `或将应用部署到中国大陆/香港节点后重试。`
        );
      }
      throw new Error(`${provider.name} 单次调用超时 (${PROVIDER_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 LLM 完成对话
 * @throws Error 当所有 provider 均不可用时
 */
export async function chatCompletion(
  messages: LLMMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  } = {}
): Promise<LLMResponse> {
  const config = await readConfig();

  // 只使用活跃模型，失败直接报错，不遍历其他模型
  const provider = config.activeProvider
    ? LLM_PROVIDERS.find((p) => p.id === config.activeProvider)
    : null;

  if (!provider) {
    throw new Error("未设置活跃 LLM 模型，请在 ⚙ 设置中选择一个模型。");
  }

  const status = config.providers[provider.id];
  if (!status) {
    throw new Error(`活跃模型 ${provider.name} 配置缺失。`);
  }
  if (!status.enabled) {
    throw new Error(`活跃模型 ${provider.name} 已禁用，请在 ⚙ 设置中启用。`);
  }
  if (provider.needsKey && !status.apiKey) {
    throw new Error(`活跃模型 ${provider.name} 未配置 API Key。`);
  }
  if (!provider.model) {
    throw new Error(`活跃模型 ${provider.name} 模型未初始化，请先刷新模型列表。`);
  }

  const now = Date.now();

  // 冷却中：直接报错，告知用户等待或切换
  if (status.cooldownUntil && status.cooldownUntil > now) {
    const remainSec = Math.ceil((status.cooldownUntil - now) / 1000);
    throw new Error(
      `活跃模型 ${provider.name} 冷却中（剩余 ${remainSec} 秒），请等待冷却结束后重试，或在 ⚙ 设置中切换其他模型。`
    );
  }

  // 永久失败：直接报错
  if (status.working === false) {
    throw new Error(
      `活跃模型 ${provider.name} 不可用（${status.lastError ?? "未知错误"}），请在 ⚙ 设置中切换其他模型或重新测试。`
    );
  }

  try {
    const text = await callWithKeyPool(provider, status.apiKey, messages, options);
    // 重新读取最新配置后再更新运行时状态。
    // LLM 调用可能耗时 30-45s，期间用户可能切换了 activeProvider，
    // 如果直接写回旧 config 会覆盖用户的切换操作。
    try {
      await updateConfigSafely((freshConfig) => {
        const s = freshConfig.providers[provider.id];
        if (s) {
          s.working = true;
          s.lastTested = now;
          s.lastError = null;
          s.cooldownUntil = null;
        }
      });
    } catch (writeErr) {
      console.error("[llm] writeConfig 失败（运行时状态更新）:", writeErr instanceof Error ? writeErr.message : String(writeErr));
    }

    return {
      text,
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
    };
  } catch (err) {
    const lastErr = err instanceof Error ? err : new Error(String(err));
    const msg = lastErr.message;

    // 重新读取最新配置后再更新运行时状态。
    // LLM 调用可能耗时 30-45s，期间用户可能切换了 activeProvider，
    // 如果直接写回旧 config 会覆盖用户的切换操作。
    try {
      await updateConfigSafely((freshConfig) => {
        const freshStatus = freshConfig.providers[provider.id];
        if (!freshStatus) return;
        freshStatus.lastTested = now;
        freshStatus.lastError = msg;

        if (isPermanentError(msg)) {
          freshStatus.working = false;
          freshStatus.cooldownUntil = null;
        } else if (isTransientError(msg)) {
          freshStatus.working = null;
          freshStatus.cooldownUntil = now + getCooldownMs(msg);
          // Groq 系列共享配额：联动冷却同系列模型
          if (
            /429|rate.?limit/i.test(msg) &&
            GROQ_PROVIDER_IDS.includes(
              provider.id as (typeof GROQ_PROVIDER_IDS)[number]
            )
          ) {
            for (const id of GROQ_PROVIDER_IDS) {
              if (id === provider.id) continue;
              const s = freshConfig.providers[id];
              if (s && s.enabled && s.apiKey) {
                s.cooldownUntil = now + getCooldownMs(msg);
                s.working = null;
              }
            }
          }
        } else {
          freshStatus.working = null;
          freshStatus.cooldownUntil = now + 2 * 60 * 1000;
        }
      });
    } catch (writeErr) {
      console.error("[llm] writeConfig 失败（错误状态更新）:", writeErr instanceof Error ? writeErr.message : String(writeErr));
    }

    // 免费额度耗尽 / 限流 / 模型不存在：尝试备用链路
    // （同家族其他 Qwen 模型额度独立、优先；再兜底到其他家族 Gemini/DeepSeek/Groq/OpenRouter）
    const shouldFallback =
      isQuotaExhausted(msg) ||
      /429|rate.?limit|HTTP 404|not found|模型不存在|无此模型/i.test(msg);
    if (shouldFallback) {
      try {
        const fallbackResp = await tryFallbackChain(provider.id, messages, options);
        if (fallbackResp) return fallbackResp;
      } catch (fbErr) {
        console.error(
          "[llm] 备用链路异常:",
          fbErr instanceof Error ? fbErr.message : String(fbErr)
        );
      }
    }

    throw new Error(
      `活跃模型 ${provider.name} 调用失败：${lastErr.message}。已尝试所有备用模型仍不可用，请在 ⚙ 设置中检查 Key 或切换模型。`
    );
  }
}

/**
 * 备用模型链路：活跃模型额度耗尽 / 限流 / 模型不存在时调用。
 *   1. 同家族（Qwen）其他模型：百炼各模型免费额度相互独立，优先尝试；
 *   2. 其他家族（按 PREFERRED_ACTIVE_ORDER）：Gemini / DeepSeek / Groq / OpenRouter 兜底。
 * 任一候选成功即返回其结果；全部失败返回 null（由调用方抛错）。
 * 候选选择会跳过：未启用、永久失败(working=false)、冷却中、无 Key、未初始化模型的 provider。
 */
async function tryFallbackChain(
  failedId: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
): Promise<LLMResponse | null> {
  const config = await readConfig();
  const now = Date.now();
  const candidates: LLMProvider[] = [];

  const pushIfUsable = (id: string) => {
    if (id === failedId) return;
    const p = LLM_PROVIDERS.find((x) => x.id === id);
    const s = p ? config.providers[id] : null;
    if (!p || !s || !s.enabled) return;
    if (s.working === false) return; // 永久失败
    if (s.cooldownUntil && s.cooldownUntil > now) return; // 冷却中
    if (p.needsKey && !s.apiKey) return;
    if (!p.model) return;
    candidates.push(p);
  };

  // 1) 同家族 Qwen：额度相互独立，优先尝试
  for (const id of QWEN_PROVIDER_IDS) pushIfUsable(id);
  // 2) 其他家族兜底（跳过已处理的 Qwen）
  for (const id of PREFERRED_ACTIVE_ORDER) {
    if ((QWEN_PROVIDER_IDS as readonly string[]).includes(id)) continue;
    pushIfUsable(id);
  }

  for (const cand of candidates) {
    const candStatus = config.providers[cand.id];
    if (!candStatus) continue;
    try {
      const text = await callWithKeyPool(cand, candStatus.apiKey, messages, {
        ...options,
        timeoutMs: FALLBACK_TIMEOUT_MS,
      });
      // 成功：标记该备用模型可用
      try {
        await updateConfigSafely((freshConfig) => {
          const s = freshConfig.providers[cand.id];
          if (s) {
            s.working = true;
            s.lastTested = Date.now();
            s.lastError = null;
            s.cooldownUntil = null;
          }
        });
      } catch {
        // 状态写回失败不影响返回结果
      }
      return {
        text,
        providerId: cand.id,
        providerName: cand.name,
        model: cand.model,
      };
    } catch (e2) {
      const m2 = e2 instanceof Error ? e2.message : String(e2);
      try {
        await updateConfigSafely((freshConfig) => {
          const s = freshConfig.providers[cand.id];
          if (!s) return;
          s.lastTested = Date.now();
          s.lastError = m2;
          if (isPermanentError(m2)) {
            s.working = false;
            s.cooldownUntil = null;
          } else if (isQuotaExhausted(m2) || /429|rate.?limit/i.test(m2)) {
            // 该备用模型额度也耗尽：冷却 5 分钟并跳过，继续下一个候选
            s.working = null;
            s.cooldownUntil = now + 5 * 60 * 1000;
          } else if (isTransientError(m2)) {
            s.working = null;
            s.cooldownUntil = now + getCooldownMs(m2);
          } else {
            s.working = null;
            s.cooldownUntil = now + 2 * 60 * 1000;
          }
        });
      } catch {
        // 状态写回失败不影响继续尝试下一个候选
      }
      // 继续下一个候选
    }
  }
  return null;
}

/** 单 provider 调用：根据协议分发 */
async function callProvider(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
): Promise<string> {
  switch (provider.protocol) {
    case "openai":
      return callOpenAICompatible(provider, apiKey, messages, options);
    case "gemini":
      return callGemini(provider, apiKey, messages, options);
    default:
      throw new Error(`未知协议：${provider.protocol}`);
  }
}

/** OpenAI 兼容协议（Groq / OpenRouter 等） */
async function callOpenAICompatible(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
): Promise<string> {
  // 推理模型（reasoning）会先在 reasoning_content / reasoning 字段输出思维链，
  // 最终 content 才是答案。这类模型生成较慢、token 较多，需要更大 maxTokens。
  // Nemotron 3 Ultra 550B / DeepSeek R1 / GPT-OSS 等均属推理模型。
  // 注意：模型 ID 大小写不统一（OpenRouter 用小写 deepseek-r1，
  // SiliconFlow 用大写 DeepSeek-R1），统一转小写比较。
  const modelLower = provider.model.toLowerCase();
  const isReasoningModel =
    modelLower.includes("deepseek-r1") ||
    modelLower.includes("nemotron") ||
    modelLower.includes("gpt-oss") ||
    modelLower === "openrouter/free";
  const defaultMaxTokens = isReasoningModel ? 4096 : 3072;
  const maxTokens = resolveMaxTokens(provider, messages, options.maxTokens ?? defaultMaxTokens);

  const res = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://reddit-alpha.local",
      "X-Title": "Reddit Alpha",
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: maxTokens,
    }),
    signal: options.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${provider.name} HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  let text = choice?.message?.content;

  if (isReasoningModel && !text) {
    text = choice?.message?.reasoning_content || choice?.message?.reasoning;
  }

  if (!text) throw new Error(`${provider.name} 返回内容为空`);
  return text as string;
}

/** Google Gemini 协议 */
async function callGemini(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
): Promise<string> {
  const url = `${provider.endpoint}/${provider.model}:generateContent?key=${apiKey}`;
  const systemMsg = messages.find((m) => m.role === "system");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const maxTokens = resolveMaxTokens(provider, messages, options.maxTokens ?? 3072);
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: maxTokens,
      // Gemini 3.x 默认开启 thinking（medium），thinking token 会计入 maxOutputTokens 预算，
      // 导致研报正文被挤出、内容不全。研报重格式组织而非深度推理，关闭思考让整个预算给正文。
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${provider.name} HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  // Gemini 2.5 等推理模型会先输出思考过程（parts 中带 thought:true），
  // 最终答案在后续 parts 中，需遍历拼接并跳过思考部分。
  const parts = data?.candidates?.[0]?.content?.parts;
  let text = "";
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part.thought === true) continue;
      if (typeof part.text === "string") text += part.text;
    }
  }
  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      throw new Error(
        `${provider.name} 返回内容为空（token 上限不足，推理模型需要更大 maxTokens）`
      );
    }
    throw new Error(`${provider.name} 返回内容为空`);
  }
  return text;
}

/**
 * 测试某个 provider 是否可用
 * 用于定时健康检查
 */
export async function testProvider(
  providerId: string
): Promise<{ ok: boolean; error?: string }> {
  const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { ok: false, error: "未知 provider" };

  const config = await readConfig();
  const status = config.providers[providerId];
  if (!status) return { ok: false, error: "provider 未在配置中" };
  if (provider.needsKey && !status.apiKey) {
    return { ok: false, error: "未配置 API Key" };
  }
  if (!provider.model) {
    return { ok: false, error: "模型未初始化，请先刷新模型列表" };
  }

  let result: { ok: boolean; error?: string };
  try {
    const modelLower = provider.model.toLowerCase();
    const isReasoningModel =
      modelLower.includes("gemini-2.5") ||
      modelLower.includes("gemini-3") ||
      modelLower.includes("deepseek-r1") ||
      modelLower.includes("nemotron") ||
      modelLower.includes("gpt-oss") ||
      modelLower.includes("hy3") ||
      modelLower === "openrouter/free";
    const text = await callWithKeyPool(
      provider,
      status.apiKey,
      [{ role: "user", content: "请回复 OK。" }],
      { maxTokens: isReasoningModel ? 1024 : 64 }
    );
    result = { ok: text.length > 0, error: undefined };
  } catch (err) {
    result = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 写回测试结果到配置
  // 重新读取最新配置后再更新状态，避免覆盖用户在测试期间切换的 activeProvider
  try {
    await updateConfigSafely((freshConfig) => {
      const freshStatus = freshConfig.providers[providerId];
      if (freshStatus) {
        freshStatus.working = result.ok;
        freshStatus.lastTested = Date.now();
        freshStatus.lastError = result.error ?? null;
        freshStatus.cooldownUntil = null;
      }
    });
  } catch (writeErr) {
    console.error("[llm] testProvider writeConfig 失败:", writeErr instanceof Error ? writeErr.message : String(writeErr));
  }

  return result;
}

/**
 * 测试所有已启用的 provider，把结果写回本地配置文件
 * 由 /api/llm-providers POST 触发，也可由定时任务调用
 */
export async function refreshProviderStatuses(): Promise<{
  results: Array<{ id: string; name: string; ok: boolean; error?: string }>;
}> {
  try {
    await refreshGroqModels();
  } catch {
  }
  try {
    await refreshGeminiModels();
  } catch {
  }

  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];

  for (const provider of LLM_PROVIDERS) {
    const config = await readConfig();
    const status = config.providers[provider.id];
    if (!status || !status.enabled) continue;
    if (provider.needsKey && !status.apiKey) {
      results.push({
        id: provider.id,
        name: provider.name,
        ok: false,
        error: "未配置 API Key",
      });
      continue;
    }

    const result = await testProvider(provider.id);
    results.push({
      id: provider.id,
      name: provider.name,
      ok: result.ok,
      error: result.error,
    });
  }

  return { results };
}

interface GroqModelInfo {
  id: string;
  name: string;
  slug: string;
  contextLength: number;
  createdAt: number;
}

/**
 * Groq 模型为静态固定（与 lib/llm-providers.ts 保持一致），
 * 直接返回固定数组，不再调用 API 评分/动态拉取，避免复杂度与意外覆盖槽位。
 */
export async function fetchGroqModels(_apiKey: string): Promise<GroqModelInfo[]> {
  return [
    { id: "openai/gpt-oss-120b", name: "openai/gpt-oss-120b", slug: "openai/gpt-oss-120b", contextLength: 131072, createdAt: 0 },
    { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b-versatile", slug: "llama-3.3-70b-versatile", contextLength: 131072, createdAt: 0 },
  ];
}

interface GeminiModelInfo {
  id: string;
  name: string;
  slug: string;
  contextLength: number;
  createdAt: number;
}

/**
 * 获取 Gemini 当前可用的模型列表，按财务分析适配度评分排序，返回前2个。
 * 调用 Google Gemini API /v1beta/models 接口，需要 API Key。
 */
export async function fetchGeminiModels(apiKey: string): Promise<GeminiModelInfo[]> {
  if (!apiKey?.trim()) return [];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      headers: { "User-Agent": "Reddit-Alpha/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const models = data?.models ?? [];

    const DEPRECATED = new Set([
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ]);
    const scored = models
      .filter((m: Record<string, unknown>) => {
        const id = String(m.name ?? "").replace(/^models\//, "");
        if (DEPRECATED.has(id)) return false;
        const supportedMethods = (m.supportedGenerationMethods as string[]) ?? [];
        return supportedMethods.includes("generateContent");
      })
      .map((m: Record<string, unknown>) => {
        const nameStr = String(m.name ?? "");
        return {
          id: nameStr,
          name: String(m.displayName ?? nameStr),
          slug: nameStr.replace(/^models\//, ""),
          contextLength: Number((m.inputTokenLimit as number) ?? 0),
          createdAt: Number(m.createTime ? new Date(String(m.createTime)).getTime() / 1000 : 0),
        };
      });

    const now = Date.now() / 1000;
    return scored
      .map((model: GeminiModelInfo) => {
        const daysOld = Math.floor((now - model.createdAt) / (24 * 3600));
        const recencyScore = Math.max(0, 365 - daysOld) * 10;
        return {
          ...model,
          score: model.contextLength * 0.5 + recencyScore,
        };
      })
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, 2)
      .map((m: GeminiModelInfo & { score: number }) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        contextLength: m.contextLength,
        createdAt: m.createdAt,
      }));
  } catch {
    return [];
  }
}

/**
 * 刷新 Groq 模型：用固定的模型（见 fetchGroqModels）同步所有 Groq provider 的
 * 模型标识与上下文窗口，并测试每个 provider 的可用性。
 */
export async function refreshGroqModels(): Promise<{
  updated: Array<{ providerId: string; oldModel: string; newModel: string }>;
  availableModels: string[];
  testResults: Array<{ providerId: string; working: boolean; error?: string }>;
}> {
  const config = await readConfig();
  let groqKey = "";
  for (const id of GROQ_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      groqKey = s.apiKey.trim();
      break;
    }
  }
  if (!groqKey) return { updated: [], availableModels: [], testResults: [] };

  const models = await fetchGroqModels(groqKey);
  if (models.length === 0) return { updated: [], availableModels: [], testResults: [] };

  const availableSlugs = models.map((m) => m.slug);
  const updated: Array<{ providerId: string; oldModel: string; newModel: string }> = [];
  const dbModels: Array<{ providerId: string; modelSlug: string; modelName: string }> = [];

  for (let i = 0; i < GROQ_PROVIDER_IDS.length; i++) {
    const providerId = GROQ_PROVIDER_IDS[i];
    const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
    const model = models[i];
    if (!provider || !model) continue;

    const oldModel = provider.model;
    const newModelSlug = model.slug;
    const readableName = model.name
      .replace(/^openai\//, "")
      .replace(/^qwen\//, "")
      .replace(/^meta-llama\//, "")
      .replace(/-instruct$/, "")
      .replace(/-versatile$/, "")
      .replace(/-turbo$/, "")
      .replace(/-/g, " ")
      .replace(/\b(\w)/g, (c) => c.toUpperCase())
      .trim();
    const newModelName = `Groq · ${readableName || model.id}`;
    if (oldModel !== newModelSlug) {
      provider.model = newModelSlug;
      provider.name = newModelName;
      updated.push({ providerId, oldModel, newModel: newModelSlug });
    }
    // 同步真实上下文窗口（compound 等小窗口模型的 413 防护依赖此值）
    if (model.contextLength && model.contextLength > 0) {
      provider.contextWindow = model.contextLength;
    }
    dbModels.push({ providerId, modelSlug: newModelSlug, modelName: newModelName });
  }

  await saveCachedModels("groq", dbModels);

  // 保持活跃模型稳定：刷新重排了槽位内的模型，
  // 根据用户锁定的 activeModelSlug 把 activeProvider 重新映射到正确的槽位并持久化。
  try {
    const cfg = await readConfig();
    const slug = cfg.activeModelSlug;
    if (slug && cfg.activeProvider) {
      const cur = LLM_PROVIDERS.find((p) => p.id === cfg.activeProvider);
      if (!cur || cur.model !== slug) {
        const targetSlot = GROQ_PROVIDER_IDS.find(
          (id) => LLM_PROVIDERS.find((p) => p.id === id)?.model === slug
        );
        if (targetSlot) await setActiveProvider(targetSlot, slug);
      }
    }
  } catch {
    // 重定位失败不影响刷新主流程
  }

  const testResults: Array<{ providerId: string; working: boolean; error?: string }> = [];
  if (groqKey) {
    for (const providerId of GROQ_PROVIDER_IDS) {
      const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
      if (!provider || !provider.model) continue;
      try {
        const result = await testProvider(providerId);
        testResults.push({ providerId, working: result.ok, error: result.error });
      } catch (err) {
        testResults.push({ providerId, working: false, error: String(err) });
      }
    }
  }

  return { updated, availableModels: availableSlugs, testResults };
}

/**
 * 动态刷新 Gemini 模型：获取前2个评分最高的模型，直接替换所有 Gemini provider。
 * 同时测试每个 provider 的可用性。
 */
export async function refreshGeminiModels(): Promise<{
  updated: Array<{ providerId: string; oldModel: string; newModel: string }>;
  availableModels: string[];
  testResults: Array<{ providerId: string; working: boolean; error?: string }>;
}> {
  const config = await readConfig();
  let geminiKey = "";
  for (const id of GEMINI_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      geminiKey = s.apiKey.trim();
      break;
    }
  }
  if (!geminiKey) return { updated: [], availableModels: [], testResults: [] };

  const models = await fetchGeminiModels(geminiKey);
  if (models.length === 0) return { updated: [], availableModels: [], testResults: [] };

  const availableSlugs = models.map((m) => m.slug);
  const updated: Array<{ providerId: string; oldModel: string; newModel: string }> = [];
  const dbModels: Array<{ providerId: string; modelSlug: string; modelName: string }> = [];

  for (let i = 0; i < GEMINI_PROVIDER_IDS.length; i++) {
    const providerId = GEMINI_PROVIDER_IDS[i];
    const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
    const model = models[i];
    if (!provider || !model) continue;

    const oldModel = provider.model;
    const newModelSlug = model.slug;
    const newModelName = `Google Gemini · ${model.name.trim()}`;
    if (oldModel !== newModelSlug) {
      provider.model = newModelSlug;
      provider.name = newModelName;
      updated.push({ providerId, oldModel, newModel: newModelSlug });
    }
    // 同步真实上下文窗口（compound 等小窗口模型的 413 防护依赖此值）
    if (model.contextLength && model.contextLength > 0) {
      provider.contextWindow = model.contextLength;
    }
    dbModels.push({ providerId, modelSlug: newModelSlug, modelName: newModelName });
  }

  await saveCachedModels("gemini", dbModels);

  // 保持活跃模型稳定：刷新重排了槽位内的模型，
  // 根据用户锁定的 activeModelSlug 把 activeProvider 重新映射到正确的槽位并持久化。
  try {
    const cfg = await readConfig();
    const slug = cfg.activeModelSlug;
    if (slug && cfg.activeProvider) {
      const cur = LLM_PROVIDERS.find((p) => p.id === cfg.activeProvider);
      if (!cur || cur.model !== slug) {
        const targetSlot = GEMINI_PROVIDER_IDS.find(
          (id) => LLM_PROVIDERS.find((p) => p.id === id)?.model === slug
        );
        if (targetSlot) await setActiveProvider(targetSlot, slug);
      }
    }
  } catch {
    // 重定位失败不影响刷新主流程
  }

  const testResults: Array<{ providerId: string; working: boolean; error?: string }> = [];
  if (geminiKey) {
    for (const providerId of GEMINI_PROVIDER_IDS) {
      const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
      if (!provider || !provider.model) continue;
      try {
        const result = await testProvider(providerId);
        testResults.push({ providerId, working: result.ok, error: result.error });
      } catch (err) {
        testResults.push({ providerId, working: false, error: String(err) });
      }
    }
  }

  return { updated, availableModels: availableSlugs, testResults };
}
