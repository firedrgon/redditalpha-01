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
    fetchedAt: row.updatedAt.toISOString(),
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
    if (!row) return null;
    return mapAnalysis(row);
  } catch {
    return getCachedAnalysisFile(ticker);
  }
}

export async function saveAnalysisDB(analysis: StockAnalysis): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) {
    await saveAnalysisFile(analysis);
    return;
  }

  try {
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
      },
    });
  } catch {
    await saveAnalysisFile(analysis);
  }
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
