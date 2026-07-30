/**
 * 模拟持仓数据层。
 *
 * 与 signals-runner 的状态机（enter=建仓 / exit=平仓）配套：
 *  - openPosition：买入信号触发时，记录一个 OPEN 持仓（按固定虚拟本金算股数）。
 *  - closePosition：卖出信号触发时，关闭该 (userId, ticker) 最新 OPEN 持仓并算盈亏。
 *
 * 资金模型：每笔固定虚拟本金（AppSetting.simCapitalPerTrade，默认 10000），
 * 股数 = capital / entryPrice。价格由调用方在信号触发时传入（fetchQuote 取信号时刻价）。
 */
import type { PrismaClient } from "@prisma/client";
import { fetchQuote, type Quote } from "@/lib/quote";

/** 每笔交易默认虚拟本金（美元） */
export const DEFAULT_CAPITAL_PER_TRADE = 10000;

/** 读取每笔虚拟本金（AppSetting 可配，缺省用默认） */
export async function getCapitalPerTrade(prisma: PrismaClient): Promise<number> {
  try {
    const s = await prisma.appSetting.findUnique({
      where: { key: "simCapitalPerTrade" },
    });
    const n = s ? Number(s.value) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* 忽略，走默认 */
  }
  return DEFAULT_CAPITAL_PER_TRADE;
}

/** 取信号时刻价格；失败/无值返回 null（此时跳过持仓金额，仅记信号） */
export async function fetchSignalPrice(ticker: string): Promise<number | null> {
  try {
    const q: Quote = await fetchQuote(ticker);
    return typeof q.price === "number" ? q.price : null;
  } catch {
    return null;
  }
}

export interface OpenPositionArgs {
  userId: string;
  ticker: string;
  tickerName: string | null;
  price: number;
  alertId: string;
  capital: number;
}

/** 建仓：创建一个 OPEN 持仓 */
export async function openPosition(
  prisma: PrismaClient,
  { userId, ticker, tickerName, price, alertId, capital }: OpenPositionArgs
) {
  const shares = price > 0 ? capital / price : 0;
  return prisma.position.create({
    data: {
      userId,
      ticker,
      tickerName: tickerName || undefined,
      status: "OPEN",
      entryPrice: price,
      entryAlertId: alertId,
      shares,
      capital,
    },
  });
}

export interface ClosePositionArgs {
  userId: string;
  ticker: string;
  /** 平仓价；为 null 时仅关闭持仓、盈亏留空 */
  price: number | null;
  alertId: string;
}

/** 平仓：关闭最新 OPEN 持仓并算 pnl/pnlPct/holdDays */
export async function closePosition(
  prisma: PrismaClient,
  { userId, ticker, price, alertId }: ClosePositionArgs
) {
  const open = await prisma.position.findFirst({
    where: { userId, ticker, status: "OPEN" },
    orderBy: { entryAt: "desc" },
  });
  if (!open) return null;

  const holdDays = Math.floor(
    (Date.now() - open.entryAt.getTime()) / 86_400_000
  );

  const pnl =
    price != null ? (price - open.entryPrice) * open.shares : null;
  const pnlPct =
    price != null && open.entryPrice > 0
      ? (price / open.entryPrice - 1) * 100
      : null;

  return prisma.position.update({
    where: { id: open.id },
    data: {
      status: "CLOSED",
      exitPrice: price ?? undefined,
      exitAt: new Date(),
      exitAlertId: alertId,
      holdDays,
      pnl,
      pnlPct,
    },
  });
}
