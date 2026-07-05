/**
 * LLM 客户端：多提供商调用与降级
 *
 * 调用流程：
 *   1. 候选 provider 优先级：activeProvider -> working=true -> 未测试但有 Key/无需Key
 *   2. 按 provider.protocol 走对应协议（openai/gemini/huggingface/duckduckgo）
 *   3. 失败则更新本地 working=false 并尝试下一个 provider
 *
 * testProvider() / refreshProviderStatuses() 用于定时健康检查
 * （"定时收集保存在本地"——结果写回 .llm-config.json）。
 */

import { readConfig, writeConfig } from "./llm-config";
import { LLM_PROVIDERS, type LLMProvider, OPENROUTER_PROVIDER_IDS } from "./llm-providers";

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
 * 调用 LLM 完成对话
 * @throws Error 当所有 provider 均不可用时
 */
export async function chatCompletion(
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<LLMResponse> {
  const config = await readConfig();

  const candidates: LLMProvider[] = [];
  const active = config.activeProvider
    ? LLM_PROVIDERS.find((p) => p.id === config.activeProvider)
    : null;
  if (active) candidates.push(active);
  for (const p of LLM_PROVIDERS) {
    if (candidates.find((c) => c.id === p.id)) continue;
    candidates.push(p);
  }

  let lastErr: Error | null = null;

  for (const provider of candidates) {
    const status = config.providers[provider.id];
    if (!status || !status.enabled) continue;
    if (provider.needsKey && !status.apiKey) continue;
    if (status.working === false) continue;

    try {
      const text = await callProvider(provider, status.apiKey, messages, options);
      status.working = true;
      status.lastTested = Date.now();
      status.lastError = null;
      await writeConfig(config);

      return {
        text,
        providerId: provider.id,
        providerName: provider.name,
        model: provider.model,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      status.working = false;
      status.lastTested = Date.now();
      status.lastError = lastErr.message;
      await writeConfig(config);
    }
  }

  throw new Error(
    `所有 LLM 提供商均不可用${lastErr ? `（最后错误：${lastErr.message}）` : ""}。请在 LLM 设置中配置 API Key。`
  );
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
    case "huggingface":
      return callHuggingFace(provider, apiKey, messages, options);
    case "duckduckgo":
      return callDuckDuckGo(provider, messages, options);
    default:
      throw new Error(`未知协议：${provider.protocol}`);
  }
}

/** OpenAI 兼容协议（Groq / OpenRouter / Together 等） */
async function callOpenAICompatible(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
): Promise<string> {
  // 推理模型（reasoning）会先在 reasoning_content / reasoning 字段输出思维链，
  // 最终 content 才是答案。这类模型生成较慢、token 较多，需要更大 maxTokens。
  // Nemotron 3 Ultra 550B / DeepSeek R1 / GPT-OSS 等均属推理模型。
  const isReasoningModel =
    provider.model.includes("deepseek-r1") ||
    provider.model.includes("nemotron") ||
    provider.model.includes("gpt-oss");
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
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`${provider.name} 返回内容为空`);
  return text as string;
}

/** HuggingFace Inference API（OpenAI 兼容端点） */
async function callHuggingFace(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  const url = `${provider.endpoint}/${provider.model}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: 0.3,
      max_tokens: 3072,
    }),
    signal: options.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${provider.name} HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider.name} 返回内容为空`);
  return text as string;
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
    const text = await callProvider(
      provider,
      status.apiKey,
      [{ role: "user", content: "请回复 OK。" }],
      { maxTokens: 16 }
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
  // 先检查并更新 OpenRouter provider 的 model slug 为最新可用的免费模型
  try {
    await refreshOpenRouterModels();
  } catch {
    // 模型刷新失败不影响后续测试
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

    const result = await testProvider(provider.id);
    status.working = result.ok;
    status.lastTested = Date.now();
    status.lastError = result.error ?? null;
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
    // 检查当前 model slug 是否仍在可用列表中
    if (availableSlugs.includes(provider.model)) continue;
    // 当前 model 不可用，按优先级替换
    // 优先选择与 provider 名称/用途最匹配的模型
    const preferredMatch = (() => {
      if (provider.id.includes("nemotron")) return freeModels.find((m) => m.id.includes("nemotron-ultra"));
      if (provider.id.includes("qwen")) return freeModels.find((m) => m.id.includes("qwen"));
      if (provider.id.includes("gpt-oss")) return freeModels.find((m) => m.id.includes("gpt-oss"));
      if (provider.id.includes("hermes")) return freeModels.find((m) => m.id.includes("hermes") || m.id.includes("llama-3.3"));
      if (provider.id.includes("llama")) return freeModels.find((m) => m.id.includes("llama"));
      return null;
    })();
    const replacement = preferredMatch ?? freeModels[0];
    if (replacement && replacement.id !== provider.model) {
      const oldModel = provider.model;
      provider.model = replacement.id;
      provider.name = `OpenRouter · ${replacement.name.replace(/\s*\(free\)\s*/i, "").trim()}`;
      updated.push({ providerId: provider.id, oldModel, newModel: replacement.id });
    }
  }

  return { updated, availableModels: availableSlugs };
}
