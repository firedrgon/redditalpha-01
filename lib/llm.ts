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

import { readConfig, writeConfig } from "./llm-config";
import {
  LLM_PROVIDERS,
  type LLMProvider,
  OPENROUTER_PROVIDER_IDS,
  GROQ_PROVIDER_IDS,
  GEMINI_PROVIDER_IDS,
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
    const text = await callProviderWithTimeout(provider, status.apiKey, messages, options);
    status.working = true;
    status.lastTested = now;
    status.lastError = null;
    status.cooldownUntil = null;
    // 运行时状态更新写入 DB 失败不应中断 LLM 调用本身
    try {
      await writeConfig(config);
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
    status.lastTested = now;
    status.lastError = lastErr.message;
    const msg = lastErr.message;

    if (isPermanentError(msg)) {
      status.working = false;
      status.cooldownUntil = null;
    } else if (isTransientError(msg)) {
      status.working = null;
      status.cooldownUntil = now + getCooldownMs(msg);
      // OpenRouter / Groq 系列共享配额：联动冷却同系列模型
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
      status.working = null;
      status.cooldownUntil = now + 2 * 60 * 1000;
    }
    // 运行时状态更新写入 DB 失败不应影响错误抛出
    try {
      await writeConfig(config);
    } catch (writeErr) {
      console.error("[llm] writeConfig 失败（错误状态更新）:", writeErr instanceof Error ? writeErr.message : String(writeErr));
    }

    throw new Error(
      `活跃模型 ${provider.name} 调用失败：${lastErr.message}。请在 ⚙ 设置中切换其他模型后重试。`
    );
  }
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
    const text = await callProvider(
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
  status.working = result.ok;
  status.lastTested = Date.now();
  status.lastError = result.error ?? null;
  status.cooldownUntil = null;
  await writeConfig(config);

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
    await refreshOpenRouterModels();
  } catch {
  }
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

interface OpenRouterModelInfo {
  id: string;
  name: string;
  slug: string;
  contextLength: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutputs: boolean;
  createdAt: number;
}

/**
 * 从 OpenRouter API 获取最新免费模型列表，并按财务分析适配度评分排序。
 * 返回前5个最适合财务分析的免费模型。
 */
export async function fetchOpenRouterFreeModels(): Promise<OpenRouterModelInfo[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "User-Agent": "Reddit-Alpha/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const models = data?.data ?? [];

    const free = models.filter((m: Record<string, unknown>) => {
      const pricing = m.pricing as Record<string, unknown> | undefined;
      return pricing?.prompt === "0" && pricing?.completion === "0";
    });

    const excludeKeywords = /content-safety|code|audio|whisper|tts|vision|vl$|clip|lyria|laguna|poolside|cohere\/north/i;

    const scored = free
      .filter((m: Record<string, unknown>) => {
        const id = String(m.id ?? "");
        if (excludeKeywords.test(id)) return false;
        const modalities = (m.architecture as Record<string, unknown>)?.input_modalities as string[] | undefined;
        return !modalities || modalities.length === 0 || modalities.every((mod) => mod === "text");
      })
      .map((m: Record<string, unknown>) => {
        const id = String(m.id ?? "");
        const supportedParams = (m.supported_parameters as string[]) ?? [];
        const supportedFeatures = (m.supported_features as string[]) ?? [];
        const allFeatures = [...supportedParams, ...supportedFeatures];
        return {
          id: id,
          name: String(m.name ?? id),
          slug: id,
          contextLength: Number(m.context_length ?? 0),
          supportsTools: allFeatures.includes("tools") || allFeatures.includes("function_calling"),
          supportsReasoning: allFeatures.includes("reasoning"),
          supportsStructuredOutputs: allFeatures.includes("structured_outputs") || allFeatures.includes("json_mode"),
          createdAt: Number(m.created ?? 0),
        };
      });

    const now = Date.now() / 1000;
    return scored
      .map((model: OpenRouterModelInfo) => {
        const daysOld = Math.floor((now - model.createdAt) / (24 * 3600));
        const recencyScore = Math.max(0, 365 - daysOld) * 10;
        return {
          ...model,
          score:
            model.contextLength * 0.5 +
            (model.supportsTools ? 2000 : 0) +
            (model.supportsReasoning ? 1500 : 0) +
            (model.supportsStructuredOutputs ? 1000 : 0) +
            recencyScore,
        };
      })
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, 5)
      .map((m: OpenRouterModelInfo & { score: number }) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        contextLength: m.contextLength,
        supportsTools: m.supportsTools,
        supportsReasoning: m.supportsReasoning,
        supportsStructuredOutputs: m.supportsStructuredOutputs,
        createdAt: m.createdAt,
      }));
  } catch {
    return [];
  }
}

interface GroqModelInfo {
  id: string;
  name: string;
  slug: string;
  contextLength: number;
  createdAt: number;
}

/**
 * 获取 Groq 当前可用的模型列表，按财务分析适配度评分排序，返回前3个。
 * 调用 OpenAI 兼容的 /openai/v1/models 接口，需要 API Key。
 */
export async function fetchGroqModels(apiKey: string): Promise<GroqModelInfo[]> {
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
    const excludeKeywords = /whisper|guard|tts|safety|vision|audio|moderation|embedding|preview-tool/i;

    const scored = models
      .filter((m: Record<string, unknown>) => {
        const id = String(m.id ?? "");
        return !excludeKeywords.test(id);
      })
      .map((m: Record<string, unknown>) => ({
        id: String(m.id ?? ""),
        name: String(m.id ?? ""),
        slug: String(m.id ?? ""),
        contextLength: Number(m.context_window ?? m.context_length ?? 0),
        createdAt: Number(m.created ?? 0),
      }));

    const now = Date.now() / 1000;
    return scored
      .map((model: GroqModelInfo) => {
        const daysOld = Math.floor((now - model.createdAt) / (24 * 3600));
        const recencyScore = Math.max(0, 365 - daysOld) * 10;
        return {
          ...model,
          score: model.contextLength * 0.5 + recencyScore,
        };
      })
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, 3)
      .map((m: GroqModelInfo & { score: number }) => ({
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

    const scored = models
      .filter((m: Record<string, unknown>) => {
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
 * 动态刷新 OpenRouter 免费模型：获取前5个评分最高的模型，直接替换所有 OpenRouter provider。
 * 同时测试每个 provider 的可用性。
 */
export async function refreshOpenRouterModels(): Promise<{
  updated: Array<{ providerId: string; oldModel: string; newModel: string }>;
  availableModels: string[];
  testResults: Array<{ providerId: string; working: boolean; error?: string }>;
}> {
  const freeModels = await fetchOpenRouterFreeModels();
  if (freeModels.length === 0) return { updated: [], availableModels: [], testResults: [] };

  const availableSlugs = freeModels.map((m) => m.slug);
  const updated: Array<{ providerId: string; oldModel: string; newModel: string }> = [];
  const dbModels: Array<{ providerId: string; modelSlug: string; modelName: string }> = [];

  for (let i = 0; i < OPENROUTER_PROVIDER_IDS.length; i++) {
    const providerId = OPENROUTER_PROVIDER_IDS[i];
    const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
    const model = freeModels[i];
    if (!provider || !model) continue;

    const oldModel = provider.model;
    const newModelSlug = `${model.slug}:free`;
    const newModelName = `OpenRouter · ${model.name.replace(/\s*\(free\)\s*/i, "").trim()}`;
    if (oldModel !== newModelSlug) {
      provider.model = newModelSlug;
      provider.name = newModelName;
      updated.push({ providerId, oldModel, newModel: newModelSlug });
    }
    dbModels.push({ providerId, modelSlug: newModelSlug, modelName: newModelName });
  }

  await saveCachedModels("openrouter", dbModels);

  const config = await readConfig();
  const testResults: Array<{ providerId: string; working: boolean; error?: string }> = [];
  let openrouterKey = "";
  for (const id of OPENROUTER_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      openrouterKey = s.apiKey.trim();
      break;
    }
  }

  if (openrouterKey) {
    for (const providerId of OPENROUTER_PROVIDER_IDS) {
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
 * 动态刷新 Groq 模型：获取前3个评分最高的模型，直接替换所有 Groq provider。
 * 同时测试每个 provider 的可用性。
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
    dbModels.push({ providerId, modelSlug: newModelSlug, modelName: newModelName });
  }

  await saveCachedModels("groq", dbModels);

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
    dbModels.push({ providerId, modelSlug: newModelSlug, modelName: newModelName });
  }

  await saveCachedModels("gemini", dbModels);

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
