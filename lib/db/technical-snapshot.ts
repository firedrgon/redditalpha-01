/**
 * TechnicalSignalSnapshot 数据访问层
 *
 * 设计目的：每个 ticker 维护一行最新技术信号，Card 渲染时高频读取，
 * 避免每次都重读 SignalAlert（事件存档，按时间累加）。
 *
 * 写入路径：
 *   - 每日 cron /api/cron/signals（重点关注股票美股开盘前批量更新）
 *   - 用户进入收藏页时 lazy refresh（snapshot 缺失或 > 24h 旧时）
 */

import { getPrisma } from "./prisma";
import { fetchTradingViewTechnicals, type Signal, type TechnicalSignals } from "@/lib/technical";
import { detectMarket } from "@/lib/market";

export interface TechnicalSignalSnapshotRow {
  ticker: string;
  tickerName: string | null;
  oscillators: Signal;
  movingAverages: Signal;
  overall: Signal;
  price: number | null;
  fetchedAt: number;
  updatedAt: number;
}

/** 兜底：DB 不可用时用的内存 Map（与 favorites.ts 模式一致，本地开发） */
const memoryByTicker: Map<string, TechnicalSignalSnapshotRow> = new Map();

function toRow(r: {
  ticker: string;
  tickerName: string | null;
  oscillators: string;
  movingAverages: string;
  overall: string;
  price: number | null;
  fetchedAt: Date;
  updatedAt: Date;
}): TechnicalSignalSnapshotRow {
  return {
    ticker: r.ticker,
    tickerName: r.tickerName,
    oscillators: r.oscillators as Signal,
    movingAverages: r.movingAverages as Signal,
    overall: r.overall as Signal,
    price: r.price,
    fetchedAt: r.fetchedAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

export interface UpsertSignalData {
  tickerName?: string | null;
  oscillators: Signal;
  movingAverages: Signal;
  overall: Signal;
  price?: number | null;
  /** 显式指定 fetchedAt（默认 now） */
  fetchedAt?: Date;
}

/**
 * 写入或更新某 ticker 的最新技术信号。
 * 用于 cron 任务与 lazy refresh。
 */
export async function upsertTechnicalSnapshot(
  data: UpsertSignalData & { ticker: string }
): Promise<TechnicalSignalSnapshotRow> {
  const upper = data.ticker.toUpperCase();
  const prisma = getPrisma();
  const now = new Date();
  const fetchedAt = data.fetchedAt ?? now;

  if (!prisma) {
    const existing = memoryByTicker.get(upper);
    const row: TechnicalSignalSnapshotRow = {
      ticker: upper,
      tickerName: data.tickerName ?? existing?.tickerName ?? null,
      oscillators: data.oscillators,
      movingAverages: data.movingAverages,
      overall: data.overall,
      price: data.price ?? null,
      fetchedAt: fetchedAt.getTime(),
      updatedAt: now.getTime(),
    };
    memoryByTicker.set(upper, row);
    return row;
  }

  const row = await prisma.technicalSignalSnapshot.upsert({
    where: { ticker: upper },
    create: {
      ticker: upper,
      tickerName: data.tickerName ?? null,
      oscillators: data.oscillators,
      movingAverages: data.movingAverages,
      overall: data.overall,
      price: data.price ?? null,
      fetchedAt,
    },
    update: {
      tickerName: data.tickerName ?? undefined,
      oscillators: data.oscillators,
      movingAverages: data.movingAverages,
      overall: data.overall,
      price: data.price ?? null,
      fetchedAt,
    },
  });
  return toRow(row);
}

/**
 * 批量按 ticker 取最新 snapshot。返回 Map（O(1) 查表），不在列表里的 ticker 不会出现在 Map 中。
 */
export async function listTechnicalSnapshots(
  tickers: string[]
): Promise<Map<string, TechnicalSignalSnapshotRow>> {
  const map = new Map<string, TechnicalSignalSnapshotRow>();
  if (tickers.length === 0) return map;

  const upperTickers = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  const prisma = getPrisma();
  if (!prisma) {
    for (const t of upperTickers) {
      const row = memoryByTicker.get(t);
      if (row) map.set(t, row);
    }
    return map;
  }

  const rows = await prisma.technicalSignalSnapshot.findMany({
    where: { ticker: { in: upperTickers } },
  });
  for (const r of rows) {
    map.set(r.ticker, toRow(r));
  }
  return map;
}

/** 取单个 ticker 的 snapshot */
export async function getTechnicalSnapshot(
  ticker: string
): Promise<TechnicalSignalSnapshotRow | null> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) return memoryByTicker.get(upper) ?? null;
  const row = await prisma.technicalSignalSnapshot.findUnique({ where: { ticker: upper } });
  return row ? toRow(row) : null;
}

/**
 * 重新从 TradingView 拉取信号并写入 snapshot。
 * - 仅美股；非美股直接跳过，返回 null
 * - TradingView 拉取失败时返回 null（调用方应保留旧 snapshot）
 * - 用于 cron 任务与按需懒刷新
 */
export async function refreshTechnicalSnapshot(
  ticker: string,
  tickerName?: string | null
): Promise<TechnicalSignalSnapshotRow | null> {
  const upper = ticker.toUpperCase();
  if (detectMarket(upper) !== "US") return null;

  const signals = await fetchTradingViewTechnicals(upper);
  if (!signals) return null;

  return upsertTechnicalSnapshot({
    ticker: upper,
    tickerName: tickerName ?? null,
    oscillators: signals.oscillators,
    movingAverages: signals.movingAverages,
    overall: signals.overall,
    price: null, // TradingView scanner 不返回收盘价，保持 null；如需价格再单独拉
  });
}

/** 兜底：让前端拿到与后端一致的类型 */
export type { Signal, TechnicalSignals };
