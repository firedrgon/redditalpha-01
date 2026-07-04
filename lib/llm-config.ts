/**
 * LLM 配置管理
 *
 * 优先级（高 → 低）：
 *   1. 环境变量 LLM_API_KEY_<PROVIDER_ID> （serverless / 只读文件系统场景）
 *   2. 本地配置文件 .llm-config.json（开发环境）
 *   3. 内存副本（写入失败时降级使用）
 *
 * "定时收集保存在本地"：
 *   - 本地可写时：写入 .llm-config.json
 *   - 只读文件系统时：仅更新内存副本（重启后丢失，但当前请求内仍可用）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { LLM_PROVIDERS, type LLMProvider } from "./llm-providers";

const CONFIG_FILE = path.join(process.cwd(), ".llm-config.json");

export interface ProviderStatus {
  id: string;
  apiKey: string; // 用户配置的 Key（空字符串表示未配置）
  enabled: boolean; // 是否启用
  lastTested: number | null; // 上次测试时间戳
  working: boolean | null; // 是否可用（null=未测试）
  lastError?: string | null;
}

export interface LLMConfig {
  providers: Record<string, ProviderStatus>;
  activeProvider: string | null; // 当前活跃提供商 id
  updatedAt: number;
}

const DEFAULT_CONFIG: LLMConfig = {
  providers: Object.fromEntries(
    LLM_PROVIDERS.map((p) => [
      p.id,
      {
        id: p.id,
        apiKey: "",
        enabled: p.needsKey ? false : true, // 不需要 Key 的默认启用
        lastTested: null,
        working: null,
        lastError: null,
      },
    ])
  ),
  activeProvider: null,
  updatedAt: 0,
};

// 内存降级副本：当文件不可写时使用
let memoryConfig: LLMConfig | null = null;

/** 从环境变量读取 API Key（serverless 场景） */
function readEnvKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of LLM_PROVIDERS) {
    const envKey = `LLM_API_KEY_${p.id.toUpperCase().replace(/-/g, "_")}`;
    const v = process.env[envKey];
    if (v && v.trim()) out[p.id] = v.trim();
  }
  // 兼容常用变量名
  const aliases: Array<[string, string]> = [
    ["GROQ_API_KEY", "groq"],
    ["GEMINI_API_KEY", "gemini"],
    ["GOOGLE_API_KEY", "gemini"],
    ["OPENROUTER_API_KEY", "openrouter-free"],
    ["HUGGINGFACE_API_KEY", "huggingface"],
    ["HF_API_KEY", "huggingface"],
    ["TOGETHER_API_KEY", "together"],
    ["TOGETHERAI_API_KEY", "together"],
  ];
  for (const [alias, providerId] of aliases) {
    const v = process.env[alias];
    if (v && v.trim() && !out[providerId]) out[providerId] = v.trim();
  }
  return out;
}

/** 把环境变量中的 Key 注入到 config */
function applyEnvKeys(config: LLMConfig): LLMConfig {
  const envKeys = readEnvKeys();
  for (const [id, key] of Object.entries(envKeys)) {
    const s = config.providers[id];
    if (s) {
      s.apiKey = key;
      if (!s.enabled) s.enabled = true;
      if (s.working === null) s.working = null; // 保持未测试状态
    }
  }
  if (!config.activeProvider && envKeys) {
    const firstId = Object.keys(envKeys)[0];
    if (firstId) config.activeProvider = firstId;
  }
  return config;
}

/** 读取配置：文件 → 内存 → 默认值，最后叠加环境变量 */
export async function readConfig(): Promise<LLMConfig> {
  let config: LLMConfig;
  if (memoryConfig) {
    config = JSON.parse(JSON.stringify(memoryConfig)) as LLMConfig;
  } else {
    try {
      const raw = await fs.readFile(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<LLMConfig>;
      config = {
        providers: { ...DEFAULT_CONFIG.providers, ...(parsed.providers || {}) },
        activeProvider: parsed.activeProvider ?? null,
        updatedAt: parsed.updatedAt ?? 0,
      };
    } catch {
      config = {
        ...DEFAULT_CONFIG,
        providers: { ...DEFAULT_CONFIG.providers },
      };
    }
  }
  // 叠加环境变量（每次读取都应用，因为环境变量随时可能变化）
  applyEnvKeys(config);
  return config;
}

/** 写入配置：文件可写则写文件，否则只更新内存副本 */
export async function writeConfig(config: LLMConfig): Promise<void> {
  const data: LLMConfig = { ...config, updatedAt: Date.now() };
  // 始终更新内存副本
  memoryConfig = JSON.parse(JSON.stringify(data)) as LLMConfig;
  // 尝试写文件（失败则降级到内存模式）
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    // 只读文件系统等：忽略错误，使用内存副本
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("EROFS") && !msg.includes("read-only")) {
      // 其他错误才抛出
      throw err;
    }
  }
}

/** 更新某个 provider 的 API Key */
export async function setProviderKey(
  providerId: string,
  apiKey: string
): Promise<LLMConfig> {
  const config = await readConfig();
  const status = config.providers[providerId];
  if (status) {
    status.apiKey = apiKey.trim();
    status.enabled = status.apiKey !== "" || !getProviderById(providerId)?.needsKey;
    status.working = null;
    status.lastTested = null;
  }
  await writeConfig(config);
  return config;
}

/** 启用/禁用 provider */
export async function setProviderEnabled(
  providerId: string,
  enabled: boolean
): Promise<LLMConfig> {
  const config = await readConfig();
  const status = config.providers[providerId];
  if (status) {
    status.enabled = enabled;
  }
  await writeConfig(config);
  return config;
}

/** 设置活跃 provider */
export async function setActiveProvider(
  providerId: string | null
): Promise<LLMConfig> {
  const config = await readConfig();
  config.activeProvider = providerId;
  await writeConfig(config);
  return config;
}

/**
 * 选择用于调用的 provider：
 *   1. 用户指定的 activeProvider（若可用）
 *   2. 第一个 enabled 且通过测试/或未测试但有 Key 的 provider
 *   3. 不需要 Key 的 provider
 */
export function pickProvider(
  config: LLMConfig,
  providers: LLMProvider[] = LLM_PROVIDERS
): { provider: LLMProvider; status: ProviderStatus } | null {
  const sorted = [...providers];

  const tryPick = (id: string | null): LLMProvider | null => {
    if (!id) return null;
    const p = providers.find((x) => x.id === id);
    const s = p ? config.providers[id] : null;
    if (p && s && s.enabled && (s.working === true || s.working === null)) {
      if (!p.needsKey || s.apiKey) return p;
    }
    return null;
  };

  const picked = tryPick(config.activeProvider);
  if (picked) {
    return { provider: picked, status: config.providers[picked.id] };
  }

  for (const p of sorted) {
    const s = config.providers[p.id];
    if (!s || !s.enabled) continue;
    if (s.working === true && (!p.needsKey || s.apiKey)) {
      return { provider: p, status: s };
    }
  }

  for (const p of sorted) {
    const s = config.providers[p.id];
    if (!s || !s.enabled) continue;
    if (s.working === null && (!p.needsKey || s.apiKey)) {
      return { provider: p, status: s };
    }
  }

  return null;
}

function getProviderById(id: string): LLMProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}
