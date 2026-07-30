/**
 * 模拟持仓数据层。
 *
 * 与 signals-runner 的状态机（enter=建仓 / exit=平仓）配套：
 *  - openPosition：买入信号触发时，记录一个 OPEN 持仓（按固定虚拟本金算股数）。
 *  - closePosition：卖出信号触发时，关闭该 (userId, ticker) 最新 OPEN 持仓并算盈亏。
 *
 * 资金模型：每笔固定虚拟本金，按市场区分币种（AppSetting 可配，缺省各 10000）：
 *  - 美股：simCapitalPerTradeUS（USD，默认 $10,000）
 *  - A 股：simCapitalPerTradeCN（CNY，默认 ¥10,000）
 * 股数 = capital / entryPrice。价格由调用方在信号触发时传入（fetchQuote 取信号时刻价）。
 */
import type { PrismaClient } from "@prisma/client";
import { fetchQuote, type Quote } from "@/lib/quote";

/** 每笔交易默认虚拟本金（分币种） */
export const DEFAULT_CAPITAL_US = 10000; // 美股，USD
export const DEFAULT_CAPITAL_CN = 10000; // A 股，CNY

/** AppSetting 键名 */
export const SIM_CAPITAL_KEY_US = "simCapitalPerTradeUS";
export const SIM_CAPITAL_KEY_CN = "simCapitalPerTradeCN";

export type AssetMarket = "CN" | "US";

/** 市场 → 本金币种 */
export function currencyOf(market: AssetMarket): "CNY" | "USD" {
  return market === "CN" ? "CNY" : "USD";
}

/**
 * 读取某市场的每笔虚拟本金（AppSetting 可配，缺省用默认）。
 * @param market CN → 读 simCapitalPerTradeCN；US → 读 simCapitalPerTradeUS
 */
export async function getCapitalForMarket(
  prisma: PrismaClient,
  market: AssetMarket
): Promise<number> {
  const key = market === "CN" ? SIM_CAPITAL_KEY_CN : SIM_CAPITAL_KEY_US;
  const fallback = market === "CN" ? DEFAULT_CAPITAL_CN : DEFAULT_CAPITAL_US;
  try {
    const s = await prisma.appSetting.findUnique({ where: { key } });
    const n = s ? Number(s.value) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* 忽略，走默认 */
  }
  return fallback;
}

/** 取信号时刻价格；失败/无值/价格<=0 返回 null（此时跳过持仓金额，仅记信号）。
 *  注意：价格 0 不是有效信号价（可能是数据源返回 0 占位），必须排除，否则会建出
 *  entryPrice=0、shares=0 的「幽灵持仓」。 */
export async function fetchSignalPrice(ticker: string): Promise<number | null> {
  try {
    const q: Quote = await fetchQuote(ticker);
    return typeof q.price === "number" && q.price > 0 ? q.price : null;
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
  /** 资产市场：CN | US（决定币种与本金档位） */
  assetType: AssetMarket;
  /** 本金币种：CNY | USD */
  currency: "CNY" | "USD";
  capital: number;
}

/** 建仓：创建一个 OPEN 持仓 */
export async function openPosition(
  prisma: PrismaClient,
  { userId, ticker, tickerName, price, alertId, assetType, currency, capital }: OpenPositionArgs
) {
  const shares = price > 0 ? capital / price : 0;
  return prisma.position.create({
    data: {
      userId,
      ticker,
      tickerName: tickerName || undefined,
      assetType,
      currency,
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
