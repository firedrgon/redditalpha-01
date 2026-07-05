/**
 * LLM 配置管理
 *
 * 优先级（高 → 低）：
 *   1. 环境变量 LLM_API_KEY_<PROVIDER_ID> （serverless / 只读文件系统场景）
 *   2. 数据库 AppSetting（Vercel 等无持久化文件系统）
 *   3. 本地配置文件 .llm-config.json（开发环境）
 *   4. 内存副本（写入失败时降级使用）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getLLMConfigFromDB, saveLLMConfigToDB } from "./db/app-settings";
import {
  LLM_PROVIDERS,
  OPENROUTER_PROVIDER_IDS,
  GEMINI_PROVIDER_IDS,
  GROQ_PROVIDER_IDS,
  PREFERRED_ACTIVE_ORDER,
  type LLMProvider,
} from "./llm-providers";

const CONFIG_FILE = path.join(process.cwd(), ".llm-config.json");

export interface ProviderStatus {
  id: string;
  apiKey: string; // 用户配置的 Key（空字符串表示未配置）
  keySource: "env" | "local" | "none"; // Key 来源：环境变量 / 本地配置 / 无
  enabled: boolean; // 是否启用
  lastTested: number | null; // 上次测试时间戳
  working: boolean | null; // 是否可用（null=未测试 / 瞬时失败冷却中）
  lastError?: string | null;
  /**
   * 瞬时错误（429 / 5xx / 超时 / 网络）冷却结束时间戳。
   * 期间 chatCompletion 跳过此 provider；过期后自动重试（working 保持 null）。
   * 永久错误（401 / 403 / 404）不设置此字段，直接 working=false。
   */
  cooldownUntil?: number | null;
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
        keySource: "none" as const,
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
  ];
  for (const [alias, providerId] of aliases) {
    const v = process.env[alias];
    if (v && v.trim() && !out[providerId]) out[providerId] = v.trim();
  }
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    for (const id of OPENROUTER_PROVIDER_IDS) {
      if (!out[id]) out[id] = openRouterKey;
    }
  }
  const geminiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (geminiKey) {
    for (const id of GEMINI_PROVIDER_IDS) {
      if (!out[id]) out[id] = geminiKey;
    }
  }
  return out;
}

/** OpenRouter 系列共用同一 Key（UI 保存到任一 provider 即可） */
function applySharedOpenRouterKeys(config: LLMConfig): void {
  let sharedKey = "";
  let sharedSource: ProviderStatus["keySource"] | null = null;
  for (const id of OPENROUTER_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      sharedKey = s.apiKey.trim();
      sharedSource = s.keySource;
      break;
    }
  }
  if (!sharedKey) return;
  for (const id of OPENROUTER_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s && !s.apiKey?.trim()) {
      s.apiKey = sharedKey;
      if (sharedSource === "env") s.keySource = "env";
      else if (sharedSource === "local") s.keySource = "local";
    }
  }
}

/** Gemini 系列共用同一 Key（UI 保存到任一 provider 即可） */
function applySharedGeminiKeys(config: LLMConfig): void {
  let sharedKey = "";
  let sharedSource: ProviderStatus["keySource"] | null = null;
  for (const id of GEMINI_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      sharedKey = s.apiKey.trim();
      sharedSource = s.keySource;
      break;
    }
  }
  if (!sharedKey) return;
  for (const id of GEMINI_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s && !s.apiKey?.trim()) {
      s.apiKey = sharedKey;
      if (sharedSource === "env") s.keySource = "env";
      else if (sharedSource === "local") s.keySource = "local";
    }
  }
}

/** Groq 系列共用同一 Key（GROQ_API_KEY，UI 保存到任一 provider 即可） */
function applySharedGroqKeys(config: LLMConfig): void {
  let sharedKey = "";
  let sharedSource: ProviderStatus["keySource"] | null = null;
  for (const id of GROQ_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      sharedKey = s.apiKey.trim();
      sharedSource = s.keySource;
      break;
    }
  }
  if (!sharedKey) return;
  for (const id of GROQ_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s && !s.apiKey?.trim()) {
      s.apiKey = sharedKey;
      if (sharedSource === "env") s.keySource = "env";
      else if (sharedSource === "local") s.keySource = "local";
    }
  }
}

/** 把环境变量中的 Key 注入到 config（环境变量优先级高于本地配置） */
function applyEnvKeys(config: LLMConfig, isFreshConfig = false): LLMConfig {
  const envKeys = readEnvKeys();
  for (const [id, key] of Object.entries(envKeys)) {
    const s = config.providers[id];
    if (s) {
      s.apiKey = key;
      s.keySource = "env";
      // 仅在首次初始化时自动启用有环境变量 Key 的 provider
      if (isFreshConfig) s.enabled = true;
    }
  }
  // 对没有环境变量覆盖的 provider，如果有本地 Key，标记为 local
  for (const id of Object.keys(config.providers)) {
    const s = config.providers[id];
    if (s && s.keySource !== "env" && s.apiKey && s.apiKey.trim()) {
      s.keySource = "local";
    } else if (s && !s.apiKey) {
      s.keySource = "none";
    }
  }
  if (!config.activeProvider) {
    const envActive = process.env.LLM_ACTIVE_PROVIDER?.trim();
    if (envActive && config.providers[envActive]) {
      config.activeProvider = envActive;
    } else if (Object.keys(envKeys).length > 0) {
      const preferred = PREFERRED_ACTIVE_ORDER.find((id) => envKeys[id]);
      config.activeProvider = preferred ?? Object.keys(envKeys)[0];
    }
  }
  return config;
}

function mergeStoredConfig(parsed: Partial<LLMConfig>): LLMConfig {
  return {
    providers: { ...DEFAULT_CONFIG.providers, ...(parsed.providers || {}) },
    activeProvider: parsed.activeProvider ?? null,
    updatedAt: parsed.updatedAt ?? 0,
  };
}

/** 读取配置：内存 → 数据库 → 文件 → 默认值，最后叠加环境变量 */
export async function readConfig(): Promise<LLMConfig> {
  let config: LLMConfig;
  let isFreshConfig = false;

  if (memoryConfig) {
    config = JSON.parse(JSON.stringify(memoryConfig)) as LLMConfig;
  } else {
    const fromDb = await getLLMConfigFromDB<Partial<LLMConfig>>();
    if (fromDb) {
      config = mergeStoredConfig(fromDb);
    } else {
      try {
        const raw = await fs.readFile(CONFIG_FILE, "utf-8");
        const parsed = JSON.parse(raw) as Partial<LLMConfig>;
        config = mergeStoredConfig(parsed);
      } catch {
        config = {
          ...DEFAULT_CONFIG,
          providers: { ...DEFAULT_CONFIG.providers },
        };
        isFreshConfig = true;
      }
    }
  }
  applySharedOpenRouterKeys(config);
  applySharedGeminiKeys(config);
  applySharedGroqKeys(config);
  applyEnvKeys(config, isFreshConfig);
  return config;
}

/** 写入配置：内存 + 数据库（可用时）+ 本地文件（可写时） */
export async function writeConfig(config: LLMConfig): Promise<void> {
  const data: LLMConfig = { ...config, updatedAt: Date.now() };
  memoryConfig = JSON.parse(JSON.stringify(data)) as LLMConfig;
  await saveLLMConfigToDB(data);
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("EROFS") && !msg.includes("read-only")) {
      throw err;
    }
  }
}

/** 更新某个 provider 的 API Key（仅本地配置，环境变量优先级更高） */
export async function setProviderKey(
  providerId: string,
  apiKey: string
): Promise<LLMConfig> {
  const config = await readConfig();
  const status = config.providers[providerId];
  if (status) {
    // 如果 Key 来自环境变量，本地写入不生效（下次 readConfig 会被环境变量覆盖）
    // 但仍写入本地配置，方便环境变量移除后使用
    status.apiKey = apiKey.trim();
    status.keySource = status.apiKey ? "local" : "none";
    status.enabled = status.apiKey !== "" || !getProviderById(providerId)?.needsKey;
    status.working = null;
    status.lastTested = null;
    status.cooldownUntil = null; // 重置 Key 时清除冷却
  }
  await writeConfig(config);
  // 重新读取（确保环境变量重新应用，keySource 正确）
  return await readConfig();
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
