import { prisma } from "./prisma";
import type { FinancialMetrics } from "../finance";

export interface FinanceSnapshotRecord {
  id: string;
  ticker: string;
  snapshotDate: string;
  price?: number | null;
  marketCap?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  pegRatio?: number | null;
  priceToBook?: number | null;
  roe?: number | null;
  returnOnEquity5yAvg?: number | null;
  revenueGrowthYoY?: number | null;
  quarterlyRevenueGrowth?: number | null;
  grossMargin?: number | null;
  profitMargin?: number | null;
  quickRatio?: number | null;
  currentRatio?: number | null;
  debtToEquity?: number | null;
  industry?: string | null;
  sector?: string | null;
  industryPE?: number | null;
  targetMeanPrice?: number | null;
  targetUpside?: number | null;
  recommendationMean?: number | null;
  dataSource?: string | null;
}

export async function recordFinanceSnapshot(
  ticker: string,
  metrics: FinancialMetrics
): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const existing = await prisma.financeSnapshot.findFirst({
    where: {
      ticker: ticker.toUpperCase(),
      snapshotDate: { gte: today },
    },
  });

  if (existing) {
    await prisma.financeSnapshot.update({
      where: { id: existing.id },
      data: {
        price: metrics.currentPrice,
        marketCap: metrics.marketCap,
        trailingPE: metrics.trailingPE,
        forwardPE: metrics.forwardPE,
        pegRatio: metrics.pegRatio,
        roe: metrics.roe,
        returnOnEquity5yAvg: metrics.returnOnEquity5yAvg,
        revenueGrowthYoY: metrics.revenueGrowthYoY,
        quarterlyRevenueGrowth: metrics.quarterlyRevenueGrowth,
        grossMargin: metrics.grossMargin,
        profitMargin: metrics.profitMargin,
        quickRatio: metrics.quickRatio,
        currentRatio: metrics.currentRatio,
        industry: metrics.industry,
        industryPE: metrics.industryPE,
        targetMeanPrice: metrics.targetMeanPrice,
        targetUpside: metrics.targetUpside,
        recommendationMean: metrics.recommendationMean,
        dataSource: metrics.dataSource,
        rawJson: JSON.stringify(metrics),
      },
    });
  } else {
    await prisma.financeSnapshot.create({
      data: {
        ticker: ticker.toUpperCase(),
        price: metrics.currentPrice,
        marketCap: metrics.marketCap,
        trailingPE: metrics.trailingPE,
        forwardPE: metrics.forwardPE,
        pegRatio: metrics.pegRatio,
        roe: metrics.roe,
        returnOnEquity5yAvg: metrics.returnOnEquity5yAvg,
        revenueGrowthYoY: metrics.revenueGrowthYoY,
        quarterlyRevenueGrowth: metrics.quarterlyRevenueGrowth,
        grossMargin: metrics.grossMargin,
        profitMargin: metrics.profitMargin,
        quickRatio: metrics.quickRatio,
        currentRatio: metrics.currentRatio,
        industry: metrics.industry,
        industryPE: metrics.industryPE,
        targetMeanPrice: metrics.targetMeanPrice,
        targetUpside: metrics.targetUpside,
        recommendationMean: metrics.recommendationMean,
        dataSource: metrics.dataSource,
        rawJson: JSON.stringify(metrics),
      },
    });
  }
}

export async function getFinanceHistory(
  ticker: string,
  days: number = 30
): Promise<FinanceSnapshotRecord[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const rows = await prisma.financeSnapshot.findMany({
    where: {
      ticker: ticker.toUpperCase(),
      snapshotDate: { gte: since },
    },
    orderBy: { snapshotDate: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    snapshotDate: r.snapshotDate.toISOString(),
    price: r.price,
    marketCap: r.marketCap,
    trailingPE: r.trailingPE,
    forwardPE: r.forwardPE,
    pegRatio: r.pegRatio,
    priceToBook: r.priceToBook,
    roe: r.roe,
    returnOnEquity5yAvg: r.returnOnEquity5yAvg,
    revenueGrowthYoY: r.revenueGrowthYoY,
    quarterlyRevenueGrowth: r.quarterlyRevenueGrowth,
    grossMargin: r.grossMargin,
    profitMargin: r.profitMargin,
    quickRatio: r.quickRatio,
    currentRatio: r.currentRatio,
    debtToEquity: r.debtToEquity,
    industry: r.industry,
    sector: r.sector,
    industryPE: r.industryPE,
    targetMeanPrice: r.targetMeanPrice,
    targetUpside: r.targetUpside,
    recommendationMean: r.recommendationMean,
    dataSource: r.dataSource,
  }));
}

export async function getLatestFinanceSnapshot(
  ticker: string
): Promise<FinanceSnapshotRecord | null> {
  const row = await prisma.financeSnapshot.findFirst({
    where: { ticker: ticker.toUpperCase() },
    orderBy: { snapshotDate: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    ticker: row.ticker,
    snapshotDate: row.snapshotDate.toISOString(),
    price: row.price,
    marketCap: row.marketCap,
    trailingPE: row.trailingPE,
    forwardPE: row.forwardPE,
    pegRatio: row.pegRatio,
    priceToBook: row.priceToBook,
    roe: row.roe,
    returnOnEquity5yAvg: row.returnOnEquity5yAvg,
    revenueGrowthYoY: row.revenueGrowthYoY,
    quarterlyRevenueGrowth: row.quarterlyRevenueGrowth,
    grossMargin: row.grossMargin,
    profitMargin: row.profitMargin,
    quickRatio: row.quickRatio,
    currentRatio: row.currentRatio,
    debtToEquity: row.debtToEquity,
    industry: row.industry,
    sector: row.sector,
    industryPE: row.industryPE,
    targetMeanPrice: row.targetMeanPrice,
    targetUpside: row.targetUpside,
    recommendationMean: row.recommendationMean,
    dataSource: row.dataSource,
  };
}
