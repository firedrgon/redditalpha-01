/**
 * LLM 配置管理
 *
 * 数据库为唯一持久化存储，每次读写都直连 DB，不使用内存缓存。
 *
 * 优先级（高 → 低）：
 *   1. 环境变量 LLM_API_KEY_<PROVIDER_ID> （serverless / 只读文件系统场景，叠加在 DB 配置之上）
 *   2. 数据库 AppSetting（Vercel 等无持久化文件系统）
 *   3. 本地配置文件 .llm-config.json（开发环境，DB 未配置时降级）
 *   4. 默认配置
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
import { getCachedModels } from "./db/llm-model-cache";

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
  model?: string; // 定时刷新时更新的 model slug，用于持久化
}

export interface LLMConfig {
  providers: Record<string, ProviderStatus>;
  activeProvider: string | null;
  updatedAt: number;
  dynamicOpenRouterModels?: Array<{ id: string; name: string; slug: string }>;
  dynamicGeminiModels?: Array<{ id: string; name: string; slug: string }>;
  dynamicGroqModels?: Array<{ id: string; name: string; slug: string }>;
}

const DEFAULT_CONFIG: LLMConfig = {
  providers: Object.fromEntries(
    LLM_PROVIDERS.map((p) => [
      p.id,
      {
        id: p.id,
        apiKey: "",
        keySource: "none" as const,
        enabled: true,
        lastTested: null,
        working: null,
        lastError: null,
      },
    ])
  ),
  activeProvider: null,
  updatedAt: 0,
};

// 注：此前版本有模块级 memoryConfig 内存缓存，导致「DB 已更新但页面仍显示旧数据」。
// 已移除：每次 readConfig 都直连 DB，保证数据实时性。

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
    ["GROQ_API_KEY", "groq-1"],
    ["GEMINI_API_KEY", "gemini-1"],
    ["GOOGLE_API_KEY", "gemini-1"],
  ];
  for (const [alias, providerId] of aliases) {
    const v = process.env[alias];
    if (v && v.trim() && !out[providerId]) out[providerId] = v.trim();
  }
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim() || process.env.LLM_API_KEY_OPENROUTER_FREE?.trim();
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

function migrateOldProviderIds(providers: Record<string, ProviderStatus>): Record<string, ProviderStatus> {
  const migrations: Record<string, string> = {
    "gemini": "gemini-1",
    "gemini-2.0": "gemini-2",
    "groq": "groq-1",
    "groq-qwen3-32b": "groq-2",
    "groq-gpt-oss-120b": "groq-3",
    "duckduckgo": "groq-1", // DuckDuckGo 已移除，映射到 groq-1 作为兜底
  };
  const result = { ...providers };
  for (const [oldId, newId] of Object.entries(migrations)) {
    if (result[oldId] && !result[newId]) {
      result[newId] = { ...result[oldId], id: newId };
    }
    delete result[oldId];
  }
  return result;
}

/** 迁移旧的 activeProvider ID 到新的 ID */
function migrateActiveProvider(activeProvider: string | null | undefined): string | null {
  if (!activeProvider) return null;
  const migrations: Record<string, string | null> = {
    "gemini": "gemini-1",
    "gemini-2.0": "gemini-2",
    "groq": "groq-1",
    "groq-qwen3-32b": "groq-2",
    "groq-gpt-oss-120b": "groq-3",
    "duckduckgo": null, // DuckDuckGo 已移除
  };
  if (activeProvider in migrations) return migrations[activeProvider];
  return activeProvider;
}

function mergeStoredConfig(parsed: Partial<LLMConfig>): LLMConfig {
  const migratedProviders = migrateOldProviderIds(parsed.providers || {});
  const migratedActive = migrateActiveProvider(parsed.activeProvider);
  // 如果迁移后的 activeProvider 不存在于 LLM_PROVIDERS 中，置为 null
  const validActive = migratedActive && LLM_PROVIDERS.find((p) => p.id === migratedActive)
    ? migratedActive
    : null;
  return {
    providers: { ...DEFAULT_CONFIG.providers, ...migratedProviders },
    activeProvider: validActive,
    updatedAt: parsed.updatedAt ?? 0,
    dynamicOpenRouterModels: parsed.dynamicOpenRouterModels,
    dynamicGeminiModels: parsed.dynamicGeminiModels,
    dynamicGroqModels: parsed.dynamicGroqModels,
  };
}

async function applyPersistedModels(config: LLMConfig): Promise<void> {
  // 从数据库读取动态模型缓存
  const cachedModels = await getCachedModels();
  if (cachedModels.length > 0) {
    for (const cached of cachedModels) {
      const provider = LLM_PROVIDERS.find((p) => p.id === cached.providerId);
      if (provider) {
        provider.model = cached.modelSlug;
        provider.name = cached.modelName;
      }
    }
  }

  // 兼容旧配置：如果数据库没有缓存，尝试从 config JSON 中读取（迁移期过渡）
  if (cachedModels.length === 0) {
    if (config.dynamicOpenRouterModels) {
      for (let i = 0; i < OPENROUTER_PROVIDER_IDS.length; i++) {
        const providerId = OPENROUTER_PROVIDER_IDS[i];
        const modelInfo = config.dynamicOpenRouterModels[i];
        const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
        if (provider && modelInfo) {
          provider.model = `${modelInfo.slug}:free`;
          provider.name = `OpenRouter · ${modelInfo.name.replace(/\s*\(free\)\s*/i, "").trim()}`;
        }
      }
    }
    if (config.dynamicGeminiModels) {
      for (let i = 0; i < GEMINI_PROVIDER_IDS.length; i++) {
        const providerId = GEMINI_PROVIDER_IDS[i];
        const modelInfo = config.dynamicGeminiModels[i];
        const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
        if (provider && modelInfo) {
          provider.model = modelInfo.slug;
          provider.name = `Google Gemini · ${modelInfo.name.trim()}`;
        }
      }
    }
    if (config.dynamicGroqModels) {
      for (let i = 0; i < GROQ_PROVIDER_IDS.length; i++) {
        const providerId = GROQ_PROVIDER_IDS[i];
        const modelInfo = config.dynamicGroqModels[i];
        const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
        if (provider && modelInfo) {
          provider.model = modelInfo.slug;
          const readableName = modelInfo.name
            .replace(/^openai\//, "")
            .replace(/^qwen\//, "")
            .replace(/^meta-llama\//, "")
            .replace(/-instruct$/, "")
            .replace(/-versatile$/, "")
            .replace(/-turbo$/, "")
            .replace(/-/g, " ")
            .replace(/\b(\w)/g, (c) => c.toUpperCase())
            .trim();
          provider.name = `Groq · ${readableName || modelInfo.id}`;
        }
      }
    }
  }

  // 应用 provider 级别的 model 覆盖（向后兼容）
  for (const [id, status] of Object.entries(config.providers)) {
    if (status.model) {
      const provider = LLM_PROVIDERS.find((p) => p.id === id);
      if (provider) {
        provider.model = status.model;
      }
    }
  }
}

/** 读取配置：数据库 → 文件 → 默认值，最后叠加环境变量 */
export async function readConfig(): Promise<LLMConfig> {
  let config: LLMConfig;
  let isFreshConfig = false;

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
  await applyPersistedModels(config);
  applySharedOpenRouterKeys(config);
  applySharedGeminiKeys(config);
  applySharedGroqKeys(config);
  applyEnvKeys(config, isFreshConfig);
  return config;
}

/** 写入配置：数据库为主（失败时抛错），本地文件为开发降级（失败时忽略） */
export async function writeConfig(config: LLMConfig): Promise<void> {
  const data: LLMConfig = { ...config, updatedAt: Date.now() };
  // DB 已配置时必须写入成功，否则用户操作（测试/设活跃/启用）的结果不会持久化，
  // 下次读取仍是旧数据。
  const saved = await saveLLMConfigToDB(data);
  if (!saved) {
    // DB 未配置（dev 模式）：降级写本地文件
    try {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // 文件也不可写，静默忽略（开发环境无持久化）
    }
    return;
  }
  // DB 写入成功后，同步写本地文件（兼容本地开发场景）
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("EROFS") && !msg.includes("read-only")) {
      // 文件写入失败不影响主流程，DB 已是 source of truth
    }
  }
}

/**
 * 安全更新配置：重新读取最新配置，应用修改器，再写回。
 *
 * 用于 LLM 调用/测试等耗时操作后的状态写回。
 * 避免直接写回操作开始时读取的旧 config，覆盖用户在此期间
 * 切换的 activeProvider 等其他配置。
 *
 * 场景：用户触发分析 → chatCompletion 读取 config（activeProvider=A）
 *   → LLM 调用 30-45s → 用户切换到 B → LLM 完成 → 如果直接写回旧 config
 *   会把 activeProvider 覆盖回 A。本函数在写回前重新读取，保证不覆盖。
 */
export async function updateConfigSafely(
  modifier: (config: LLMConfig) => void
): Promise<void> {
  const config = await readConfig();
  modifier(config);
  await writeConfig(config);
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
