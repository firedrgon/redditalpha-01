/**
 * LLM 客户端：多提供商调用与降级
 *
 * 调用流程：
 *   1. 候选 provider 优先级：activeProvider -> working=true -> 未测试但有 Key/无需Key
 *   2. 按 provider.protocol 走对应协议（openai/gemini/duckduckgo）
 *   3. 失败则更新本地 working=false 并尝试下一个 provider
 *
 * testProvider() / refreshProviderStatuses() 用于定时健康检查
 * （"定时收集保存在本地"——结果写回 .llm-config.json）。
 */

import { readConfig, writeConfig } from "./llm-config";
import {
  LLM_PROVIDERS,
  type LLMProvider,
  OPENROUTER_PROVIDER_IDS,
  GROQ_PROVIDER_IDS,
  PREFERRED_ACTIVE_ORDER,
} from "./llm-providers";

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
 */
function isPermanentError(msg: string): boolean {
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

/**
 * 单个 provider 调用的子超时（毫秒）。
 *
 * chatCompletion 外部总超时通常 45s，若某个 provider（尤其是 OpenRouter
 * 推理模型如 Nemotron 550B）单次生成就要 60s+，会吃掉全部预算导致后续
 * provider 没机会尝试。设置子超时后，单个 provider 超时即 fallback，
 * 总预算内可尝试 1-2 个 provider。
 */
const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * 包装 callProvider，加上单 provider 子超时。
 * 子超时触发时 abort 当前 fetch 并抛出超时错误，由调用方 catch 后 fallback。
 * 外部 signal（总超时）触发时也会联动 abort。
 */
async function callProviderWithTimeout(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
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
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await callProvider(provider, apiKey, messages, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    // 区分：子超时 vs 外部 signal 触发 vs 其他错误
    if (controller.signal.aborted && !options.signal?.aborted) {
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
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<LLMResponse> {
  const config = await readConfig();

  // 候选 provider 顺序：
  //   1. 用户指定的 activeProvider 最优先
  //   2. 其余按 PREFERRED_ACTIVE_ORDER（配额+质量综合优先）排序
  //   3. 不在 PREFERRED_ACTIVE_ORDER 中的（理论不应有）按声明顺序补在最后
  const candidates: LLMProvider[] = [];
  const active = config.activeProvider
    ? LLM_PROVIDERS.find((p) => p.id === config.activeProvider)
    : null;
  if (active) candidates.push(active);
  for (const id of PREFERRED_ACTIVE_ORDER) {
    if (candidates.find((c) => c.id === id)) continue;
    const p = LLM_PROVIDERS.find((x) => x.id === id);
    if (p) candidates.push(p);
  }
  for (const p of LLM_PROVIDERS) {
    if (candidates.find((c) => c.id === p.id)) continue;
    candidates.push(p);
  }

  const now = Date.now();
  let lastErr: Error | null = null;
  let skippedCooldown = 0; // 因冷却跳过的 provider 数
  let skippedNoKey = 0; // 因缺 Key 跳过的 provider 数
  let skippedDisabled = 0; // 因 disabled / working=false 跳过的 provider 数

  for (const provider of candidates) {
    const status = config.providers[provider.id];
    if (!status || !status.enabled) {
      skippedDisabled++;
      continue;
    }
    if (provider.needsKey && !status.apiKey) {
      skippedNoKey++;
      continue;
    }
    // 永久失败（401/403/404 等）：跳过
    if (status.working === false) {
      skippedDisabled++;
      continue;
    }
    // 瞬时失败冷却中：跳过
    if (status.cooldownUntil && status.cooldownUntil > now) {
      skippedCooldown++;
      continue;
    }

    try {
      const text = await callProviderWithTimeout(provider, status.apiKey, messages, options);
      status.working = true;
      status.lastTested = now;
      status.lastError = null;
      status.cooldownUntil = null;
      await writeConfig(config);

      return {
        text,
        providerId: provider.id,
        providerName: provider.name,
        model: provider.model,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      status.lastTested = now;
      status.lastError = lastErr.message;
      const msg = lastErr.message;

      if (isPermanentError(msg)) {
        // 永久错误（Key 无效 / 模型不存在）：标记为不可用
        status.working = false;
        status.cooldownUntil = null;
      } else if (isTransientError(msg)) {
        // 瞬时错误（429 / 5xx / 超时 / 网络）：设置冷却，到期自动重试
        status.working = null;
        status.cooldownUntil = now + getCooldownMs(msg);
        // OpenRouter 免费层共享每日配额：任一模型 429 时，给所有 OpenRouter
        // 模型设置冷却，避免短时间内逐个尝试都 429 浪费时间。
        if (
          /429|rate.?limit/i.test(msg) &&
          OPENROUTER_PROVIDER_IDS.includes(
            provider.id as (typeof OPENROUTER_PROVIDER_IDS)[number]
          )
        ) {
          for (const id of OPENROUTER_PROVIDER_IDS) {
            if (id === provider.id) continue;
            const s = config.providers[id];
            if (s && s.enabled && s.apiKey) {
              s.cooldownUntil = now + getCooldownMs(msg);
              s.working = null;
            }
          }
        }
        // Groq 系列共享同一 API Key 的速率配额（30 req/min, 14400/天）：
        // 任一 Groq 模型 429 时，联动冷却其他 Groq 模型，避免逐个尝试。
        if (
          /429|rate.?limit/i.test(msg) &&
          GROQ_PROVIDER_IDS.includes(
            provider.id as (typeof GROQ_PROVIDER_IDS)[number]
          )
        ) {
          for (const id of GROQ_PROVIDER_IDS) {
            if (id === provider.id) continue;
            const s = config.providers[id];
            if (s && s.enabled && s.apiKey) {
              s.cooldownUntil = now + getCooldownMs(msg);
              s.working = null;
            }
          }
        }
      } else {
        // 未知错误：保守起见也走冷却（2 分钟），不永久标记
        status.working = null;
        status.cooldownUntil = now + 2 * 60 * 1000;
      }
      await writeConfig(config);
    }
  }

  // 根据跳过原因生成更有帮助的错误消息
  const parts: string[] = [];
  if (lastErr) parts.push(`最后错误：${lastErr.message}`);
  if (skippedCooldown > 0) {
    parts.push(
      `${skippedCooldown} 个 provider 因瞬时错误冷却中（429/超时等，将自动恢复）`
    );
  }
  if (skippedNoKey > 0) {
    parts.push(`${skippedNoKey} 个 provider 未配置 API Key`);
  }
  if (skippedDisabled > 0) {
    parts.push(`${skippedDisabled} 个 provider 已禁用或永久不可用`);
  }

  // 给出针对性建议
  let hint = "请在 LLM 设置中配置 API Key。";
  if (lastErr && /429|rate.?limit/i.test(lastErr.message)) {
    hint =
      "免费层限流（OpenRouter 共享每日 50 次配额）。请在 ⚙ 设置中配置 Gemini 或 Groq 的免费 Key 作为主用，或等待冷却后重试。";
  } else if (skippedCooldown > 0 && skippedNoKey > 0) {
    hint =
      "部分 provider 限流冷却中且未配置 Key。建议在 ⚙ 设置中配置 Gemini 或 Groq Key 作为备用。";
  }

  throw new Error(`所有 LLM 提供商均不可用（${parts.join("；")}）。${hint}`);
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
    case "duckduckgo":
      return callDuckDuckGo(provider, messages, options);
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
      max_tokens: options.maxTokens ?? defaultMaxTokens,
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

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxTokens ?? 3072,
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

/** DuckDuckGo AI Chat（非官方，无需 Key） */
async function callDuckDuckGo(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  const statusRes = await fetch(
    "https://duckduckgo.com/duckchat/v1/status",
    {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "x-vqd-accept": "1",
      },
      signal: options.signal,
    }
  );
  if (!statusRes.ok) {
    throw new Error(`DuckDuckGo status HTTP ${statusRes.status}`);
  }
  const token = statusRes.headers.get("x-vqd-4");
  if (!token) throw new Error("DuckDuckGo 未返回 x-vqd-4 token");

  const res = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Content-Type": "application/json",
      "x-vqd-4": token,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : m.role,
        content: m.content,
      })),
    }),
    signal: options.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`DuckDuckGo chat HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  // DuckDuckGo 返回 SSE 流，按行解析 data: {...}
  const raw = await res.text();
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const json = JSON.parse(payload);
      if (json.message) chunks.push(json.message);
    } catch {
      // 跳过无法解析的行
    }
  }
  const text = chunks.join("");
  if (!text) throw new Error("DuckDuckGo 返回内容为空");
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

  try {
    // 推理模型（Gemini 2.5 / DeepSeek R1 / Nemotron / GPT-OSS）会先思考再回答，
    // 测试时需要更大 maxTokens，否则思考阶段就耗尽 token 导致无最终输出。
    // openrouter/free 会自动路由到未知模型，按推理模型处理以防 token 不足。
    const modelLower = provider.model.toLowerCase();
    const isReasoningModel =
      modelLower.includes("gemini-2.5") ||
      modelLower.includes("deepseek-r1") ||
      modelLower.includes("nemotron") ||
      modelLower.includes("gpt-oss") ||
      modelLower === "openrouter/free";
    const text = await callProvider(
      provider,
      status.apiKey,
      [{ role: "user", content: "请回复 OK。" }],
      { maxTokens: isReasoningModel ? 1024 : 64 }
    );
    return { ok: text.length > 0, error: undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 测试所有已启用的 provider，把结果写回本地配置文件
 * 由 /api/llm-providers POST 触发，也可由定时任务调用
 */
export async function refreshProviderStatuses(): Promise<{
  results: Array<{ id: string; name: string; ok: boolean; error?: string }>;
}> {
  try {
    await refreshOpenRouterModels();
  } catch {
  }
  try {
    await refreshGroqModels();
  } catch {
  }

  const config = await readConfig();
  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];

  for (const provider of LLM_PROVIDERS) {
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

    status.model = provider.model;

    const result = await testProvider(provider.id);
    status.working = result.ok;
    status.lastTested = Date.now();
    status.lastError = result.error ?? null;
    status.cooldownUntil = null;
    results.push({
      id: provider.id,
      name: provider.name,
      ok: result.ok,
      error: result.error,
    });
  }

  await writeConfig(config);
  return { results };
}

/**
 * 从 OpenRouter API 获取最新免费模型列表。
 * 返回适合股票分析的免费模型 slug（排除编码/内容安全/音频专用模型）。
 */
export async function fetchOpenRouterFreeModels(): Promise<
  Array<{ id: string; name: string; contextLength: number }>
> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "User-Agent": "Reddit-Alpha/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const models = data?.data ?? [];
    // 筛选免费模型
    const free = models.filter(
      (m: Record<string, unknown>) => {
        const pricing = m.pricing as Record<string, unknown> | undefined;
        return pricing?.prompt === "0" && pricing?.completion === "0";
      }
    );
    // 排除不适合分析的模型
    const excludeKeywords = /content-safety|code|audio|whisper|tts|vision|vl$|clip|lyria|laguna|poolside|cohere\/north/i;
    const suitable = free.filter((m: Record<string, unknown>) => {
      const id = String(m.id ?? "");
      return !excludeKeywords.test(id);
    });
    return suitable
      .map((m: Record<string, unknown>) => ({
        id: String(m.id ?? ""),
        name: String(m.name ?? ""),
        contextLength: Number(m.context_length ?? 0),
      }))
      .sort((a: { contextLength: number }, b: { contextLength: number }) => b.contextLength - a.contextLength);
  } catch {
    return [];
  }
}

/**
 * 检查并更新 OpenRouter provider 的 model slug 为最新可用的免费模型。
 * 在 refreshProviderStatuses 之前调用，确保 provider 用的是当前可用的模型。
 * 如果当前 model slug 仍然可用则不更新，不可用则替换为列表中最佳的。
 */
export async function refreshOpenRouterModels(): Promise<{
  updated: Array<{ providerId: string; oldModel: string; newModel: string }>;
  availableModels: string[];
}> {
  const freeModels = await fetchOpenRouterFreeModels();
  if (freeModels.length === 0) return { updated: [], availableModels: [] };

  const availableSlugs = freeModels.map((m) => m.id);
  const updated: Array<{ providerId: string; oldModel: string; newModel: string }> = [];

  for (const provider of LLM_PROVIDERS) {
    if (!OPENROUTER_PROVIDER_IDS.includes(provider.id as typeof OPENROUTER_PROVIDER_IDS[number])) continue;
    const currentModelWithoutFree = provider.model.replace(/:free$/, "");
    if (availableSlugs.includes(currentModelWithoutFree)) continue;
    const preferredMatch = (() => {
      if (provider.id.includes("nemotron")) return freeModels.find((m) => m.id.includes("nemotron-ultra"));
      if (provider.id.includes("qwen")) return freeModels.find((m) => m.id.includes("qwen"));
      if (provider.id.includes("gpt-oss")) return freeModels.find((m) => m.id.includes("gpt-oss"));
      if (provider.id.includes("hermes")) return freeModels.find((m) => m.id.includes("hermes") || m.id.includes("llama-3.3"));
      if (provider.id.includes("llama")) return freeModels.find((m) => m.id.includes("llama"));
      return null;
    })();
    const replacement = preferredMatch ?? freeModels[0];
    if (replacement && replacement.id !== currentModelWithoutFree) {
      const oldModel = provider.model;
      provider.model = replacement.id;
      provider.name = `OpenRouter · ${replacement.name.replace(/\s*\(free\)\s*/i, "").trim()}`;
      updated.push({ providerId: provider.id, oldModel, newModel: replacement.id });
    }
  }

  return { updated, availableModels: availableSlugs };
}

/**
 * 获取 Groq 当前可用的模型列表。
 * 调用 OpenAI 兼容的 /openai/v1/models 接口，需要 API Key。
 *
 * Groq 托管的均为开源模型（Llama / Qwen / GPT-OSS / DeepSeek 等），
 * 无付费/免费区分，但需排除不适合文本分析的模型（whisper / guard / tts 等）。
 */
export async function fetchGroqModels(
  apiKey: string
): Promise<Array<{ id: string; name: string; contextLength: number }>> {
  if (!apiKey?.trim()) return [];
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "Reddit-Alpha/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const models = data?.data ?? [];
    // 排除不适合文本分析的模型（音频 / 安全审查 / 多模态等）
    const excludeKeywords = /whisper|guard|tts|safety|vision|audio|moderation|embedding|preview-tool/i;
    const suitable = models.filter((m: Record<string, unknown>) => {
      const id = String(m.id ?? "");
      return !excludeKeywords.test(id);
    });
    return suitable
      .map((m: Record<string, unknown>) => ({
        id: String(m.id ?? ""),
        name: String(m.id ?? ""),
        contextLength: Number(m.context_window ?? m.context_length ?? 0),
      }))
      .sort((a: { contextLength: number }, b: { contextLength: number }) => b.contextLength - a.contextLength);
  } catch {
    return [];
  }
}

/**
 * 检查并更新 Groq provider 的 model slug 为最新可用的模型。
 * 在 refreshProviderStatuses 之前调用，确保 provider 用的是当前可用的模型。
 * 如果当前 model slug 仍然可用则不更新，不可用则按用途匹配替换。
 */
export async function refreshGroqModels(): Promise<{
  updated: Array<{ providerId: string; oldModel: string; newModel: string }>;
  availableModels: string[];
}> {
  // Groq 系列共享同一 API Key，从任一已配置 Key 的 provider 读取
  const config = await readConfig();
  let groqKey = "";
  for (const id of GROQ_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      groqKey = s.apiKey.trim();
      break;
    }
  }
  if (!groqKey) return { updated: [], availableModels: [] };

  const models = await fetchGroqModels(groqKey);
  if (models.length === 0) return { updated: [], availableModels: [] };

  const availableIds = models.map((m) => m.id);
  const updated: Array<{ providerId: string; oldModel: string; newModel: string }> = [];

  for (const provider of LLM_PROVIDERS) {
    if (!GROQ_PROVIDER_IDS.includes(provider.id as typeof GROQ_PROVIDER_IDS[number])) continue;
    // 检查当前 model 是否仍在可用列表中
    if (availableIds.includes(provider.model)) continue;
    // 当前 model 不可用，按 provider 用途匹配最接近的模型
    const preferredMatch = (() => {
      if (provider.id.includes("qwen")) return models.find((m) => m.id.includes("qwen"));
      if (provider.id.includes("gpt-oss")) return models.find((m) => m.id.includes("gpt-oss"));
      if (provider.id.includes("llama")) return models.find((m) => m.id.includes("llama"));
      return null;
    })();
    const replacement = preferredMatch ?? models[0];
    if (replacement && replacement.id !== provider.model) {
      const oldModel = provider.model;
      provider.model = replacement.id;
      provider.name = `Groq · ${replacement.id}`;
      updated.push({ providerId: provider.id, oldModel, newModel: replacement.id });
    }
  }

  return { updated, availableModels: availableIds };
}
