import { getPrisma } from "./prisma";
import type { AnalysisCache as PrismaAnalysisCache } from "@prisma/client";
import type { StockAnalysis } from "../analysis";
import {
  getCachedAnalysis as getCachedAnalysisFile,
  saveAnalysis as saveAnalysisFile,
  clearCachedAnalysis as clearCachedAnalysisFile,
  clearAllCache as clearAllCacheFile,
  listCachedTickers as listCachedTickersFile,
} from "../analysis-cache";

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
    cached: true,
  };
}

export async function getCachedAnalysisDB(
  ticker: string
): Promise<StockAnalysis | null> {
  const prisma = getPrisma();
  if (!prisma) return getCachedAnalysisFile(ticker);

  try {
    const row = await prisma.analysisCache.findUnique({
      where: { ticker: ticker.toUpperCase() },
    });
    if (!row) {
      // 数据库中没有记录，降级到文件缓存
      return getCachedAnalysisFile(ticker);
    }
    return mapAnalysis(row);
  } catch {
    // 数据库查询失败，降级到文件缓存
    return getCachedAnalysisFile(ticker);
  }
}

export async function saveAnalysisDB(analysis: StockAnalysis): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) {
    await saveAnalysisFile(analysis);
    return;
  }

  // 数据库已配置时，必须把数据真正写到 DB。
  // 不要在 upsert 失败时静默降级到文件缓存——getCachedAnalysisDB 会优先读 DB，
  // 一旦 DB 仍是旧数据，再次点开页面就会看到旧内容，且用户毫无感知。
  // 让错误向上抛出，由调用方（doRefresh）捕获并写入 warnings 提示用户。
  const ticker = analysis.ticker.toUpperCase();
  await prisma.analysisCache.upsert({
    where: { ticker },
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
      ticker,
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

export async function clearCachedAnalysisDB(ticker: string): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) {
    await clearCachedAnalysisFile(ticker);
    return;
  }

  try {
    await prisma.analysisCache.delete({
      where: { ticker: ticker.toUpperCase() },
    });
  } catch {
    await clearCachedAnalysisFile(ticker);
  }
}

export async function clearAllCacheDB(): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) {
    await clearAllCacheFile();
    return;
  }

  try {
    await prisma.analysisCache.deleteMany();
  } catch {
    await clearAllCacheFile();
  }
}

export async function listCachedTickersDB(): Promise<string[]> {
  const prisma = getPrisma();
  if (!prisma) return listCachedTickersFile();

  try {
    const rows = await prisma.analysisCache.findMany({
      orderBy: { ticker: "asc" },
    });
    return rows.map(mapAnalysis).map((a) => a.ticker);
  } catch {
    return listCachedTickersFile();
  }
}
