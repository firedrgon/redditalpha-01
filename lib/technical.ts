/**
 * 美股技术指标（TradingView Scanner API）
 *
 * 从 TradingView scanner 接口获取振荡指标与移动均线的综合信号，
 * 返回 5 级信号：强烈卖出 / 卖出 / 中立 / 买入 / 强烈买入。
 *
 * 仅用于美股，A 股不调用。
 */

/* ------------------------------------------------------------------ */
/* 类型定义                                                             */
/* ------------------------------------------------------------------ */

export type Signal =
  | "strong_buy"
  | "buy"
  | "neutral"
  | "sell"
  | "strong_sell";

export interface TechnicalSignals {
  oscillators: Signal;
  movingAverages: Signal;
  overall: Signal;
}

/** 信号 → 中文标签 */
export const SIGNAL_LABELS: Record<Signal, string> = {
  strong_sell: "强烈卖出",
  sell: "卖出",
  neutral: "中立",
  buy: "买入",
  strong_buy: "强烈买入",
};

/* ------------------------------------------------------------------ */
/* TradingView 字段列表                                                */
/* ------------------------------------------------------------------ */

/**
 * 请求 TradingView scanner 时传入的字段列表。
 * 我们核心只需要 Recommend.Other / Recommend.MA / Recommend.All，
 * 但多取一些字段以备将来扩展（不影响性能）。
 */
const COLUMNS: string[] = [
  // 综合推荐
  "Recommend.All",
  "Recommend.MA",
  "Recommend.Other",
  // 振荡指标（备用）
  "RSI",
  "Stoch.K",
  "Stoch.D",
  "CCI20",
  "ADX",
  "AO",
  "Mom",
  "MACD.macd",
  "MACD.signal",
  "Stoch.RSI.K",
  "W.R",
  "BBPower",
  "UO",
  // 移动均线（备用）
  "EMA10",
  "EMA20",
  "EMA50",
  "EMA100",
  "EMA200",
  "SMA10",
  "SMA20",
  "SMA50",
  "SMA100",
  "SMA200",
  "VWMA",
  "HullMA9",
  // 价格
  "close",
];

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * 将美股 ticker 转换为 TradingView 格式。
 * 输入 "NFLX" → ["NASDAQ:NFLX", "NYSE:NFLX"]（不确定交易所时两个都试）
 * 输入 "NASDAQ:NFLX" → ["NASDAQ:NFLX"]
 */
function toTVTickers(ticker: string): string[] {
  if (ticker.includes(":")) return [ticker];
  // 不确定交易所，同时尝试 NASDAQ 和 NYSE
  return [`NASDAQ:${ticker}`, `NYSE:${ticker}`];
}

/**
 * 将 Recommend 值（-1 到 1）转换为 5 级信号。
 * 与 TradingView 内部逻辑一致：
 *   >= 0.75  → strong_buy
 *   >= 0.25  → buy
 *   > -0.25  → neutral
 *   > -0.75  → sell
 *   <= -0.75 → strong_sell
 */
function recommendToSignal(value: number | null | undefined): Signal {
  if (value == null || isNaN(value)) return "neutral";
  if (value >= 0.75) return "strong_buy";
  if (value >= 0.25) return "buy";
  if (value > -0.25) return "neutral";
  if (value > -0.75) return "sell";
  return "strong_sell";
}

/* ------------------------------------------------------------------ */
/* 主函数                                                               */
/* ------------------------------------------------------------------ */

/**
 * 从 TradingView scanner API 获取美股技术信号。
 *
 * @param ticker 美股 ticker（如 "NFLX"、"NASDAQ:NFLX"）
 * @returns 三个维度的信号，失败返回 null
 */
export async function fetchTradingViewTechnicals(
  ticker: string
): Promise<TechnicalSignals | null> {
  const tvTickers = toTVTickers(ticker);

  try {
    const res = await fetch("https://scanner.tradingview.com/us/scan", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Origin: "https://www.tradingview.com",
        Referer: "https://www.tradingview.com/",
      },
      body: JSON.stringify({
        symbols: { tickers: tvTickers },
        columns: COLUMNS,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: Array<{ s?: string; d?: (number | string | null)[] }>;
    };

    // 取第一个有数据的行（可能 NASDAQ 或 NYSE 命中）
    const row = json.data?.find((r) => r.d && r.d.length > 0);
    if (!row || !row.d) return null;

    // 字段索引映射
    const idx = Object.fromEntries(COLUMNS.map((name, i) => [name, i]));

    const recommendAll = row.d[idx["Recommend.All"]] as number | null;
    const recommendMA = row.d[idx["Recommend.MA"]] as number | null;
    const recommendOther = row.d[idx["Recommend.Other"]] as number | null;

    return {
      overall: recommendToSignal(recommendAll),
      movingAverages: recommendToSignal(recommendMA),
      oscillators: recommendToSignal(recommendOther),
    };
  } catch {
    return null;
  }
}
