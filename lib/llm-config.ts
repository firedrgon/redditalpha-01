/**
 * 本地 LLM 配置管理
 *
 * 配置文件路径：项目根目录 .llm-config.json
 * 该文件保存：
 *   - 各提供商的 API Key（用户输入）
 *   - 各提供商的健康检查状态（定时测试后更新）
 *   - 当前活跃提供商
 *
 * "定时收集保存在本地"：通过 refreshProviderStatuses() 周期性测试哪些
 * 提供商可用，把结果写回本地文件，避免每次调用都重新探测。
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

/** 读取本地配置文件，不存在则返回默认配置 */
export async function readConfig(): Promise<LLMConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LLMConfig>;
    // 合并默认值，确保新增的 provider 也能出现
    const merged: LLMConfig = {
      providers: { ...DEFAULT_CONFIG.providers, ...(parsed.providers || {}) },
      activeProvider: parsed.activeProvider ?? null,
      updatedAt: parsed.updatedAt ?? 0,
    };
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  }
}

/** 写入本地配置文件 */
export async function writeConfig(config: LLMConfig): Promise<void> {
  const data: LLMConfig = { ...config, updatedAt: Date.now() };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
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
    status.working = null; // 重置 working 状态，待下次测试
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
      // working=true 或未测试但有 key（needsKey=false 也可）都允许
      if (!p.needsKey || s.apiKey) return p;
    }
    return null;
  };

  // 1. activeProvider
  const picked = tryPick(config.activeProvider);
  if (picked) {
    return { provider: picked, status: config.providers[picked.id] };
  }

  // 2. 已通过测试 working=true 的
  for (const p of sorted) {
    const s = config.providers[p.id];
    if (!s || !s.enabled) continue;
    if (s.working === true && (!p.needsKey || s.apiKey)) {
      return { provider: p, status: s };
    }
  }

  // 3. 未测试但有 Key 或无需 Key 的
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
