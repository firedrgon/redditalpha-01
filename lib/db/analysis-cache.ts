/**
 * 股票分析结果持久化（数据库为唯一存储，无文件缓存）
 *
 * 数据流：
 *  - 每次查询：从数据库读取该 ticker 的分析记录
 *  - 重新生成：拉取最新财务数据 + LLM 分析 → 写入数据库（upsert，每 ticker 仅一份）
 *
 * 降级：未配置数据库时（本地开发）使用内存 Map，重启后丢失，仅用于无 Postgres 时跑通流程。
 */

import { getPrisma } from "./prisma";
import type { AnalysisCache as PrismaAnalysisCache } from "@prisma/client";
import type { StockAnalysis } from "../analysis";

// 内存降级存储：仅在未配置数据库时使用
const memoryStore: Map<string, StockAnalysis> = new Map();

function mapAnalysis(row: PrismaAnalysisCache): StockAnalysis {
  return {
    ticker: row.ticker,
    name: row.name ?? undefined,
    metrics: JSON.parse(row.metrics),
    overallVerdict: row.overallVerdict as StockAnalysis["overallVerdict"],
    overallSummary: row.overallSummary,
    currentPrice: row.currentPrice,
    targetMeanPrice: row.targetMeanPrice,
    targetHighPrice: row.targetHighPrice,
    targetLowPrice: row.targetLowPrice,
    targetMedianPrice: row.targetMedianPrice,
    targetUpside: row.targetUpside,
    numberOfAnalysts: row.numberOfAnalysts,
    recommendationMean: row.recommendationMean,
    llmNarrative: row.llmNarrative ?? undefined,
    llmProvider: row.llmProvider ?? undefined,
    llmError: row.llmError ?? undefined,
    strategyIdsUsed: JSON.parse(row.strategyIdsUsed),
    dataSource: row.dataSource ?? undefined,
    warnings: row.warnings ? JSON.parse(row.warnings) : undefined,
    industryRank: row.industryRank ? JSON.parse(row.industryRank) : null,
    industry: row.industry ?? null,
    sector: row.sector ?? null,
    news: row.news ? JSON.parse(row.news) : undefined,
    technicalSignals: row.technicalSignals ? JSON.parse(row.technicalSignals) : null,
    fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : row.updatedAt.toISOString(),
  };
}

/** 读取某个 ticker 的分析记录，无则返回 null */
export async function getAnalysis(
  ticker: string
): Promise<StockAnalysis | null> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) return memoryStore.get(upper) ?? null;

  // 数据库已配置时，查询失败一律返回 null，绝不回退到内存旧数据。
  // 否则用户从 DB 删除记录后，内存里残留的旧数据仍会被返回，导致页面显示已删除的数据。
  try {
    const row = await prisma.analysisCache.findUnique({
      where: { ticker: upper },
    });
    return row ? mapAnalysis(row) : null;
  } catch (firstErr) {
    // 若 technicalSignals 列不存在（schema 未同步），回退到 raw SQL 查询（不含该列）
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (errMsg.includes("technicalSignals") || errMsg.includes("does not exist") || errMsg.includes("Unknown argument")) {
      try {
        const rows = await prisma.$queryRawUnsafe<PrismaAnalysisCache[]>(
          `SELECT * FROM "AnalysisCache" WHERE ticker = $1 LIMIT 1`,
          upper
        );
        if (!rows.length) return null;
        // 手动补一个 undefined 的 technicalSignals，避免 mapAnalysis 报错
        const row = { ...rows[0], technicalSignals: undefined as unknown as string | null };
        return mapAnalysis(row);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 写入/覆盖某 ticker 的分析记录（每 ticker 仅一份，基于 @unique(ticker) upsert） */
export async function saveAnalysis(analysis: StockAnalysis): Promise<void> {
  const upper = analysis.ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    memoryStore.set(upper, analysis);
    return;
  }

  // 数据库已配置时必须真正落库。失败让错误向上抛，由调用方捕获并提示用户，
  // 避免静默降级导致下次读取仍是旧数据。
  //
  // 注意：technicalSignals 是新增字段，若数据库 schema 尚未同步（列不存在），
  // 整个 upsert 会失败。因此先尝试完整写入，失败后回退到不含 technicalSignals 的写入。
  const baseData = {
    name: analysis.name,
    metrics: JSON.stringify(analysis.metrics),
    overallVerdict: analysis.overallVerdict,
    overallSummary: analysis.overallSummary,
    currentPrice: analysis.currentPrice,
    targetMeanPrice: analysis.targetMeanPrice,
    targetHighPrice: analysis.targetHighPrice,
    targetLowPrice: analysis.targetLowPrice,
    targetMedianPrice: analysis.targetMedianPrice,
    targetUpside: analysis.targetUpside,
    numberOfAnalysts: analysis.numberOfAnalysts,
    recommendationMean: analysis.recommendationMean,
    llmNarrative: analysis.llmNarrative,
    llmProvider: analysis.llmProvider,
    llmError: analysis.llmError,
    strategyIdsUsed: JSON.stringify(analysis.strategyIdsUsed),
    dataSource: analysis.dataSource,
    warnings: analysis.warnings ? JSON.stringify(analysis.warnings) : null,
    industryRank: analysis.industryRank ? JSON.stringify(analysis.industryRank) : null,
    industry: analysis.industry ?? null,
    sector: analysis.sector ?? null,
    news: analysis.news ? JSON.stringify(analysis.news) : null,
    fetchedAt: analysis.fetchedAt ? new Date(analysis.fetchedAt) : null,
  };

  try {
    await prisma.analysisCache.upsert({
      where: { ticker: upper },
      update: {
        ...baseData,
        technicalSignals: analysis.technicalSignals ? JSON.stringify(analysis.technicalSignals) : null,
      },
      create: {
        ticker: upper,
        ...baseData,
        technicalSignals: analysis.technicalSignals ? JSON.stringify(analysis.technicalSignals) : null,
      },
    });
  } catch (firstErr) {
    // 若因 technicalSignals 列不存在而失败，回退到 raw SQL（完全绕过 Prisma 的 SELECT 列表）
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (errMsg.includes("technicalSignals") || errMsg.includes("does not exist") || errMsg.includes("Unknown argument")) {
      console.warn("[analysis-cache] technicalSignals column not found, falling back to raw SQL");
      const now = new Date();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AnalysisCache" (
          "id", "ticker", "name", "metrics", "overallVerdict", "overallSummary",
          "currentPrice", "targetMeanPrice", "targetHighPrice", "targetLowPrice",
          "targetMedianPrice", "targetUpside", "numberOfAnalysts", "recommendationMean",
          "llmNarrative", "llmProvider", "llmError", "strategyIdsUsed", "dataSource",
          "warnings", "industryRank", "industry", "sector", "news",
          "fetchedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23,
          $24, $25, $25
        )
        ON CONFLICT ("ticker") DO UPDATE SET
          "name" = $2, "metrics" = $3, "overallVerdict" = $4, "overallSummary" = $5,
          "currentPrice" = $6, "targetMeanPrice" = $7, "targetHighPrice" = $8, "targetLowPrice" = $9,
          "targetMedianPrice" = $10, "targetUpside" = $11, "numberOfAnalysts" = $12, "recommendationMean" = $13,
          "llmNarrative" = $14, "llmProvider" = $15, "llmError" = $16, "strategyIdsUsed" = $17, "dataSource" = $18,
          "warnings" = $19, "industryRank" = $20, "industry" = $21, "sector" = $22, "news" = $23,
          "fetchedAt" = $24, "updatedAt" = $25`,
        upper,
        baseData.name,
        baseData.metrics,
        baseData.overallVerdict,
        baseData.overallSummary,
        baseData.currentPrice,
        baseData.targetMeanPrice,
        baseData.targetHighPrice,
        baseData.targetLowPrice,
        baseData.targetMedianPrice,
        baseData.targetUpside,
        baseData.numberOfAnalysts,
        baseData.recommendationMean,
        baseData.llmNarrative,
        baseData.llmProvider,
        baseData.llmError,
        baseData.strategyIdsUsed,
        baseData.dataSource,
        baseData.warnings,
        baseData.industryRank,
        baseData.industry,
        baseData.sector,
        baseData.news,
        baseData.fetchedAt,
        now
      );
    } else {
      throw firstErr;
    }
  }
}

/** 删除某 ticker 的分析记录 */
export async function clearAnalysis(ticker: string): Promise<void> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    memoryStore.delete(upper);
    return;
  }

  // 数据库已配置时尝试删除；不存在记录是正常情况（P2025）不视为错误。
  try {
    await prisma.analysisCache.delete({ where: { ticker: upper } });
  } catch (err: unknown) {
    // Prisma P2025: 记录不存在，属正常情况，忽略
    if (err && typeof err === "object" && "code" in err && err.code === "P2025") {
      return;
    }
    throw err;
  }
}

/** 清空所有分析记录 */
export async function clearAllAnalysis(): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) {
    memoryStore.clear();
    return;
  }

  await prisma.analysisCache.deleteMany();
}

/** 列出所有已分析的 ticker */
export async function listAnalysisTickers(): Promise<string[]> {
  const prisma = getPrisma();
  if (!prisma) return Array.from(memoryStore.keys()).sort();

  try {
    const rows = await prisma.analysisCache.findMany({
      orderBy: { ticker: "asc" },
    });
    return rows.map((r) => r.ticker);
  } catch {
    return [];
  }
}
