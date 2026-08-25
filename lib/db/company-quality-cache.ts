import { getPrisma } from "./prisma";
import type { CompanyQuality } from "@/lib/company-quality";
import { cacheKeyOf } from "@/lib/quality-ticker";

export interface QualityStatus {
  scored: boolean;
  totalScore?: number;
  level?: string;
}

const TABLE = "CompanyQualityCache";

/**
 * 写入/覆盖一条质地打分缓存。
 * 未配置 DB（本地开发）时静默降级，不阻塞主流程。
 */
export async function upsertQuality(
  ticker: string,
  name: string | null,
  data: CompanyQuality
): Promise<void> {
  const key = cacheKeyOf(ticker);
  if (!key) return;
  const prisma = getPrisma();
  if (!prisma) return;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${TABLE}" ("id","ticker","name","dataJson","totalScore","level","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,now(),now())
       ON CONFLICT ("ticker") DO UPDATE SET
         "name"=EXCLUDED."name",
         "dataJson"=EXCLUDED."dataJson",
         "totalScore"=EXCLUDED."totalScore",
         "level"=EXCLUDED."level",
         "updatedAt"=now()`,
      `cqc_${key}`,
      key,
      name,
      JSON.stringify(data),
      data.totalScore ?? null,
      data.level ?? null
    );
  } catch (e) {
    console.error("[company-quality-cache] upsert failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * 读取缓存（非 refresh 时优先返回，省去重抓同花顺）。
 * 返回完整 CompanyQuality + evaluatedAt（缓存写入时间）。无 DB / 未命中返回 null。
 */
export async function getQuality(
  ticker: string
): Promise<(CompanyQuality & { evaluatedAt: string }) | null> {
  const key = cacheKeyOf(ticker);
  if (!key) return null;
  const prisma = getPrisma();
  if (!prisma) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ dataJson: string; name: string | null; updatedAt: Date }>
    >(`SELECT "dataJson","name","updatedAt" FROM "${TABLE}" WHERE "ticker"=$1 LIMIT 1`, key);
    const row = rows[0];
    if (!row) return null;
    const data = JSON.parse(row.dataJson) as CompanyQuality;
    return { ...data, evaluatedAt: row.updatedAt.toISOString() };
  } catch (e) {
    console.error("[company-quality-cache] get failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 批量查询哪些 ticker 已打过分（供收藏 / 热榜列表徽章）。
 * 返回以「6 位裸码」为键的 status map；未配 DB 时全部 scored:false。
 */
export async function getQualityStatus(
  tickers: string[]
): Promise<Record<string, QualityStatus>> {
  const out: Record<string, QualityStatus> = {};
  for (const t of tickers) {
    const k = cacheKeyOf(t);
    if (k) out[k] = { scored: false };
  }
  const keys = Object.keys(out);
  if (keys.length === 0) return out;
  const prisma = getPrisma();
  if (!prisma) return out;
  try {
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(",");
    const rows = await prisma.$queryRawUnsafe<
      Array<{ ticker: string; totalScore: number | null; level: string | null }>
    >(
      `SELECT "ticker","totalScore","level" FROM "${TABLE}" WHERE "ticker" IN (${placeholders})`,
      ...keys
    );
    for (const r of rows) {
      out[r.ticker] = {
        scored: true,
        totalScore: r.totalScore ?? undefined,
        level: r.level ?? undefined,
      };
    }
  } catch (e) {
    console.error("[company-quality-cache] status failed:", e instanceof Error ? e.message : e);
  }
  return out;
}
