import { getPrisma } from "./prisma";

const LLM_CONFIG_KEY = "llm_config";

export async function getAppSetting<T>(key: string): Promise<T | null> {
  const prisma = getPrisma();
  if (!prisma) return null;

  try {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    if (!row) return null;
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function setAppSetting(
  key: string,
  value: unknown
): Promise<boolean> {
  const prisma = getPrisma();
  if (!prisma) return false;

  try {
    const json = JSON.stringify(value);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: json },
      update: { value: json },
    });
    return true;
  } catch {
    return false;
  }
}

export async function getLLMConfigFromDB<T>(): Promise<T | null> {
  return getAppSetting<T>(LLM_CONFIG_KEY);
}

export async function saveLLMConfigToDB(config: unknown): Promise<boolean> {
  return setAppSetting(LLM_CONFIG_KEY, config);
}
