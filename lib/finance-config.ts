/**
 * 财务数据源配置
 *
 * 优先级：
 *   1. 环境变量（serverless / 只读文件系统）
 *   2. 本地配置文件 .finance-config.json
 *   3. 内存副本（写入失败时降级）
 */

import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = path.join(process.cwd(), ".finance-config.json");

export interface FinanceConfig {
  fmpApiKey: string;
  avApiKey: string;
  tiingoApiKey: string;
  finnhubApiKey: string;
  updatedAt: number;
}

const DEFAULT_CONFIG: FinanceConfig = {
  fmpApiKey: "",
  avApiKey: "",
  tiingoApiKey: "",
  finnhubApiKey: "",
  updatedAt: 0,
};

let memoryConfig: FinanceConfig | null = null;

function applyEnvKey(config: FinanceConfig): FinanceConfig {
  const fmpEnv = process.env.FMP_API_KEY;
  if (fmpEnv && fmpEnv.trim()) {
    config.fmpApiKey = fmpEnv.trim();
  }
  const avEnv = process.env.AV_API_KEY;
  if (avEnv && avEnv.trim()) {
    config.avApiKey = avEnv.trim();
  }
  const tiingoEnv = process.env.TIINGO_API_KEY;
  if (tiingoEnv && tiingoEnv.trim()) {
    config.tiingoApiKey = tiingoEnv.trim();
  }
  const finnhubEnv = process.env.FINNHUB_API_KEY;
  if (finnhubEnv && finnhubEnv.trim()) {
    config.finnhubApiKey = finnhubEnv.trim();
  }
  return config;
}

export async function readFinanceConfig(): Promise<FinanceConfig> {
  let config: FinanceConfig;
  if (memoryConfig) {
    config = { ...memoryConfig };
  } else {
    try {
      const raw = await fs.readFile(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<FinanceConfig>;
      config = {
        fmpApiKey: parsed.fmpApiKey ?? "",
        avApiKey: parsed.avApiKey ?? "",
        tiingoApiKey: parsed.tiingoApiKey ?? "",
        finnhubApiKey: parsed.finnhubApiKey ?? "",
        updatedAt: parsed.updatedAt ?? 0,
      };
    } catch {
      config = { ...DEFAULT_CONFIG };
    }
  }
  applyEnvKey(config);
  return config;
}

export async function writeFinanceConfig(
  config: FinanceConfig
): Promise<void> {
  const data: FinanceConfig = { ...config, updatedAt: Date.now() };
  memoryConfig = { ...data };
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("EROFS") && !msg.includes("read-only")) {
      throw err;
    }
  }
}

export async function setFmpApiKey(apiKey: string): Promise<FinanceConfig> {
  const config = await readFinanceConfig();
  config.fmpApiKey = apiKey.trim();
  await writeFinanceConfig(config);
  return config;
}

export async function setAvApiKey(apiKey: string): Promise<FinanceConfig> {
  const config = await readFinanceConfig();
  config.avApiKey = apiKey.trim();
  await writeFinanceConfig(config);
  return config;
}

export async function setTiingoApiKey(apiKey: string): Promise<FinanceConfig> {
  const config = await readFinanceConfig();
  config.tiingoApiKey = apiKey.trim();
  await writeFinanceConfig(config);
  return config;
}

export async function setFinnhubApiKey(apiKey: string): Promise<FinanceConfig> {
  const config = await readFinanceConfig();
  config.finnhubApiKey = apiKey.trim();
  await writeFinanceConfig(config);
  return config;
}

export async function getFmpApiKey(): Promise<string> {
  const config = await readFinanceConfig();
  return config.fmpApiKey;
}

export async function getAvApiKey(): Promise<string> {
  const config = await readFinanceConfig();
  return config.avApiKey;
}

export async function getTiingoApiKey(): Promise<string> {
  const config = await readFinanceConfig();
  return config.tiingoApiKey;
}

export async function getFinnhubApiKey(): Promise<string> {
  const config = await readFinanceConfig();
  return config.finnhubApiKey;
}
