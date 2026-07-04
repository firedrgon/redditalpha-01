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
import { LLM_PROVIDERS, type LLMProvider } from "./llm-providers";

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
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<LLMResponse> {
  const config = await readConfig();

  // 候选 provider 优先级
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
  options: { temperature?: number; maxTokens?: number }
): Promise<string> {
  switch (provider.protocol) {
    case "openai":
      return callOpenAICompatible(provider, apiKey, messages, options);
    case "gemini":
      return callGemini(provider, apiKey, messages, options);
    case "huggingface":
      return callHuggingFace(provider, apiKey, messages);
    case "duckduckgo":
      return callDuckDuckGo(provider, messages);
    default:
      throw new Error(`未知协议：${provider.protocol}`);
  }
}

/** OpenAI 兼容协议（Groq / OpenRouter / Together 等） */
async function callOpenAICompatible(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number }
): Promise<string> {
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
      max_tokens: options.maxTokens ?? 1024,
    }),
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

/** Google Gemini 协议 */
async function callGemini(
  provider: LLMProvider,
  apiKey: string,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number }
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
      maxOutputTokens: options.maxTokens ?? 1024,
    },
  };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  messages: LLMMessage[]
): Promise<string> {
  // HuggingFace 已提供 OpenAI 兼容的 chat 端点
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
      max_tokens: 1024,
    }),
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
  messages: LLMMessage[]
): Promise<string> {
  // 第一步：获取 x-vqd-4 token
  const statusRes = await fetch(
    "https://duckduckgo.com/duckchat/v1/status",
    {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "x-vqd-accept": "1",
      },
    }
  );
  if (!statusRes.ok) {
    throw new Error(`DuckDuckGo status HTTP ${statusRes.status}`);
  }
  const token = statusRes.headers.get("x-vqd-4");
  if (!token) throw new Error("DuckDuckGo 未返回 x-vqd-4 token");

  // 第二步：发起对话
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
