/**
 * ETF 估值评估结果落库（与 EtfTrend.date 对应，按 date+code 唯一）。
 *
 * 为什么落库：估值原本每次请求实时抓东方财富计算、仅存于 per-instance 内存缓存。
 * 落库后 → 计算一次、跨 serverless 实例共享、筛选稳定可复现、限流时也不至于整批变 null。
 *
 * 所有 DB 访问 best-effort 容错：DB 不可用时静默跳过（调用方继续走内存/实时计算），
 * 绝不因落库失败而中断评估主流程。
 */

import { getPrisma } from "@/lib/db/prisma";
import type { EnrichedEtfTrendItem } from "./etf-evaluate-runner";

/**
 * 批量 upsert 某日全部 ETF 的估值评估结果。
 * itemJson 直接存完整 EnrichedEtfTrendItem（含基础 item + evaluation + fundData），
 * 以便无网络时也能原样重建；其余字段为反范式副本，便于按分位/评级查询。
 */
export async function saveEtfValuations(
  date: string,
  items: EnrichedEtfTrendItem[]
): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) return;
  try {
    await prisma.$transaction(async (tx) => {
      for (const it of items) {
        const v = it.fundData?.valuation;
        const q = it.fundData?.quality;
        const row = {
          date,
          code: it.code,
          itemJson: JSON.parse(JSON.stringify(it)),
          grade: it.evaluation.grade,
          totalScore:
            it.evaluation.totalScore != null
              ? Math.round(it.evaluation.totalScore)
              : null,
          valuationGrade: it.evaluation.valuation.grade,
          valuationScore:
            it.evaluation.valuation.score != null
              ? Math.round(it.evaluation.valuation.score)
              : null,
          qualityGrade: it.evaluation.quality.grade,
          qualityScore:
            it.evaluation.quality.score != null
              ? Math.round(it.evaluation.quality.score)
              : null,
          pePercentile: v?.indexPePercentile ?? null,
          pbPercentile: v?.indexPbPercentile ?? null,
          proxy: v?.proxy ?? false,
          scaleYi: q?.scaleYi ?? null,
          feeRatePct: q?.feeRatePct ?? null,
          trackingErrorPct: q?.trackingErrorPct ?? null,
          dividendYieldPct: v?.dividendYieldPct ?? null,
        };
        await tx.etfValuation.upsert({
          where: { date_code: { date, code: it.code } },
          create: row,
          update: row,
        });
      }
    });
  } catch (err) {
    console.warn(
      "[etf-valuation-db] 保存估值失败(非致命):",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * 读取某日已落库的估值评估结果，原样重建为 EnrichedEtfTrendItem[]。
 * 命中且非空则直接复用（不再抓东方财富），规避限流导致的整批 null。
 * DB 不可用或当日无数据返回 null（调用方回退到实时计算）。
 */
export async function loadEtfValuations(
  date: string
): Promise<EnrichedEtfTrendItem[] | null> {
  const prisma = getPrisma();
  if (!prisma) return null;
  try {
    const rows = await prisma.etfValuation.findMany({
      where: { date },
      orderBy: { totalScore: "desc" },
    });
    if (!rows || rows.length === 0) return null;
    return rows.map(
      (r) => r.itemJson as unknown as EnrichedEtfTrendItem
    );
  } catch (err) {
    console.warn(
      "[etf-valuation-db] 读取估值失败(非致命):",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
