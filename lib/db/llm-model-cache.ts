/**
 * LLM 动态模型缓存：数据库读写
 *
 * 每天定时刷新的模型列表保存在 LlmModelCache 表中，
 * 启动时从数据库查询并应用到内存中的 LLM_PROVIDERS。
 */

import { getPrisma } from "./prisma";

export interface CachedModel {
  platform: string;
  providerId: string;
  modelSlug: string;
  modelName: string;
  sortOrder: number;
}

/**
 * 保存某个平台的模型列表到数据库（覆盖式）
 */
export async function saveCachedModels(
  platform: string,
  models: Array<{ providerId: string; modelSlug: string; modelName: string }>
): Promise<boolean> {
  const prisma = getPrisma();
  if (!prisma) return false;

  try {
    // 先删除该平台的旧记录
    await prisma.llmModelCache.deleteMany({
      where: { platform },
    });
    // 批量插入新记录
    if (models.length === 0) return true;
    await prisma.llmModelCache.createMany({
      data: models.map((m, index) => ({
        platform,
        providerId: m.providerId,
        modelSlug: m.modelSlug,
        modelName: m.modelName,
        sortOrder: index,
      })),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 从数据库读取所有缓存的模型，按平台和排序顺序返回
 */
export async function getCachedModels(): Promise<CachedModel[]> {
  const prisma = getPrisma();
  if (!prisma) return [];

  try {
    const rows = await prisma.llmModelCache.findMany({
      orderBy: [{ platform: "asc" }, { sortOrder: "asc" }],
    });
    return rows.map((r) => ({
      platform: r.platform,
      providerId: r.providerId,
      modelSlug: r.modelSlug,
      modelName: r.modelName,
      sortOrder: r.sortOrder,
    }));
  } catch {
    return [];
  }
}

/**
 * 从数据库读取某个平台的缓存模型
 */
export async function getCachedModelsByPlatform(
  platform: string
): Promise<CachedModel[]> {
  const prisma = getPrisma();
  if (!prisma) return [];

  try {
    const rows = await prisma.llmModelCache.findMany({
      where: { platform },
      orderBy: { sortOrder: "asc" },
    });
    return rows.map((r) => ({
      platform: r.platform,
      providerId: r.providerId,
      modelSlug: r.modelSlug,
      modelName: r.modelName,
      sortOrder: r.sortOrder,
    }));
  } catch {
    return [];
  }
}
