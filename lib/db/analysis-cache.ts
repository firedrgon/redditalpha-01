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
  } catch {
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
  await prisma.analysisCache.upsert({
    where: { ticker: upper },
    update: {
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
    },
    create: {
      ticker: upper,
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
    },
  });
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
