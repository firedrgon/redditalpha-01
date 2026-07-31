import { getPrisma } from "./prisma";

const LLM_CONFIG_KEY = "llm_config";

/**
 * 带重试的数据库读取：吸收 serverless 冷启动时 Postgres 连接池未热身的瞬时失败。
 * 否则 readConfig 会把异常吞成 null → 退回空配置 → 活跃模型被环境变量兜底成 gemini，
 * 表现为「redeploy 后活跃模型变回 gemini」。
 */
async function readRowWithRetry(key: string, retries = 3): Promise<string | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const prisma = getPrisma();
    if (!prisma) return null; // 未配置 DB（dev 降级），直接返回
    try {
      const row = await prisma.appSetting.findUnique({ where: { key } });
      return row ? row.value : null;
    } catch (err) {
      lastErr = err;
      // 末次失败不再等待
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.warn(`[app-settings] 读取 key=${key} 失败（已重试 ${retries} 次）：${msg}`);
  return null;
}

export async function getAppSetting<T>(key: string): Promise<T | null> {
  const raw = await readRowWithRetry(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setAppSetting(
  key: string,
  value: unknown
): Promise<boolean> {
  const prisma = getPrisma();
  if (!prisma) return false; // DB 未配置（dev 模式），调用方降级

  // DB 已配置时必须写入成功，失败则抛错让调用方感知。
  // 否则用户操作（测试/设活跃/启用）的结果不会持久化，下次读取仍是旧数据。
  const json = JSON.stringify(value);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: json },
    update: { value: json },
  });
  return true;
}

export async function getLLMConfigFromDB<T>(): Promise<T | null> {
  return getAppSetting<T>(LLM_CONFIG_KEY);
}

export async function saveLLMConfigToDB(config: unknown): Promise<boolean> {
  return setAppSetting(LLM_CONFIG_KEY, config);
}
