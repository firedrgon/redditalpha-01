import { getPrisma } from "./prisma";
import type { FinanceSnapshot as PrismaFinanceSnapshot } from "@prisma/client";
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

const memorySnapshots: Map<string, FinanceSnapshotRecord[]> = new Map();

function mapSnapshot(r: PrismaFinanceSnapshot): FinanceSnapshotRecord {
  return {
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
  };
}

function metricsToRecord(
  ticker: string,
  metrics: FinancialMetrics,
  date: Date
): FinanceSnapshotRecord {
  return {
    id: `snap-${date.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
    ticker: ticker.toUpperCase(),
    snapshotDate: date.toISOString(),
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
  };
}

function getMemoryHistory(ticker: string): FinanceSnapshotRecord[] {
  return memorySnapshots.get(ticker.toUpperCase()) ?? [];
}

export async function recordFinanceSnapshot(
  ticker: string,
  metrics: FinancialMetrics
): Promise<void> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    // 内存模式：每个 ticker 只保留一份最新快照
    const now = new Date();
    const record = metricsToRecord(upper, metrics, now);
    memorySnapshots.set(upper, [record]);
    return;
  }

  try {
    // 每个 ticker 在数据库只保留一份：基于 @unique(ticker) 做 upsert
    await prisma.financeSnapshot.upsert({
      where: { ticker: upper },
      update: {
        snapshotDate: new Date(),
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
      create: {
        ticker: upper,
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
  } catch {
    // 数据库写入失败时降级到内存，避免阻塞主流程
    const now = new Date();
    const record = metricsToRecord(upper, metrics, now);
    memorySnapshots.set(upper, [record]);
  }
}

export async function getFinanceHistory(
  ticker: string,
  days: number = 30
): Promise<FinanceSnapshotRecord[]> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);
    return getMemoryHistory(upper).filter(
      (s) => new Date(s.snapshotDate).getTime() >= since.getTime()
    );
  }

  try {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const rows = await prisma.financeSnapshot.findMany({
      where: {
        ticker: upper,
        snapshotDate: { gte: since },
      },
      orderBy: { snapshotDate: "asc" },
    });

    return rows.map(mapSnapshot);
  } catch {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);
    return getMemoryHistory(upper).filter(
      (s) => new Date(s.snapshotDate).getTime() >= since.getTime()
    );
  }
}

export async function getLatestFinanceSnapshot(
  ticker: string
): Promise<FinanceSnapshotRecord | null> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    const history = getMemoryHistory(upper);
    return history.length > 0 ? history[history.length - 1] : null;
  }

  try {
    const row = await prisma.financeSnapshot.findFirst({
      where: { ticker: upper },
      orderBy: { snapshotDate: "desc" },
    });
    if (!row) return null;
    return mapSnapshot(row);
  } catch {
    const history = getMemoryHistory(upper);
    return history.length > 0 ? history[history.length - 1] : null;
  }
}

/**
 * 删除指定 ticker 的财务快照记录。
 * 移除收藏时调用，避免残留无主数据。
 * 记录不存在（Prisma P2025）属正常情况，不视为错误。
 */
export async function clearFinanceSnapshot(ticker: string): Promise<void> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    memorySnapshots.delete(upper);
    return;
  }

  try {
    await prisma.financeSnapshot.delete({ where: { ticker: upper } });
  } catch (err: unknown) {
    // Prisma P2025: 记录不存在，属正常情况，忽略
    if (err && typeof err === "object" && "code" in err && err.code === "P2025") {
      return;
    }
    throw err;
  }
}
