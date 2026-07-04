import { prisma } from "./prisma";
import type { AnalysisCache as PrismaAnalysisCache } from "@prisma/client";
import type { StockAnalysis } from "../analysis";

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
    fetchedAt: row.updatedAt.toISOString(),
    cached: true,
  };
}

export async function getCachedAnalysisDB(
  ticker: string
): Promise<StockAnalysis | null> {
  const row = await prisma.analysisCache.findUnique({
    where: { ticker: ticker.toUpperCase() },
  });
  if (!row) return null;
  return mapAnalysis(row);
}

export async function saveAnalysisDB(analysis: StockAnalysis): Promise<void> {
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
    },
  });
}

export async function clearCachedAnalysisDB(ticker: string): Promise<void> {
  await prisma.analysisCache.delete({
    where: { ticker: ticker.toUpperCase() },
  });
}

export async function clearAllCacheDB(): Promise<void> {
  await prisma.analysisCache.deleteMany();
}

export async function listCachedTickersDB(): Promise<string[]> {
  const rows = await prisma.analysisCache.findMany({
    orderBy: { ticker: "asc" },
  });
  return rows.map(mapAnalysis).map((a) => a.ticker);
}
