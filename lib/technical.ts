/**
 * 美股技术指标（TradingView Scanner API）
 *
 * 直接使用 TradingView 的 Recommend 值（Recommend.Other / Recommend.MA /
 * Recommend.All），确保与 TradingView 网站显示的信号完全一致。
 * 这些值由 TradingView 官方计算，范围为 -1（强烈卖出）到 1（强烈买入）。
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

/** 请求 scanner API 的字段列表（TradingView 官方 Recommend 值 + 价格，使用周线数据 1W） */
const COLUMNS: string[] = [
  // TradingView 官方推荐值（-1 到 1，与网站显示一致，周线）
  "Recommend.All|1W",    // 综合信号
  "Recommend.MA|1W",     // 移动均线信号
  "Recommend.Other|1W",  // 振荡指标信号
  // 价格（用于日志，周线）
  "close|1W",
];

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function toTVTickers(ticker: string): string[] {
  if (ticker.includes(":")) return [ticker];
  return [`NASDAQ:${ticker}`, `NYSE:${ticker}`];
}

/** 安全取数值 */
function num(val: number | string | null | undefined): number | null {
  if (val == null || val === "") return null;
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? null : n;
}

/* ------------------------------------------------------------------ */
/* Recommend 值 → 5 级信号映射                                          */
/* ------------------------------------------------------------------ */

/**
 * 将 TradingView 的 Recommend 值（-1 到 1）映射为 5 级信号。
 * 阈值与 TradingView 前端完全一致：
 *   < -0.5  → 强烈卖出
 *   < -0.1  → 卖出
 *   < 0.1   → 中立
 *   < 0.5   → 买入
 *   >= 0.5  → 强烈买入
 */
function recommendToSignal(val: number | null): Signal {
  if (val == null) return "neutral";
  if (val < -0.5) return "strong_sell";
  if (val < -0.1) return "sell";
  if (val < 0.1) return "neutral";
  if (val < 0.5) return "buy";
  return "strong_buy";
}

/* ------------------------------------------------------------------ */
/* 主函数                                                               */
/* ------------------------------------------------------------------ */

export async function fetchTradingViewTechnicals(
  ticker: string
): Promise<TechnicalSignals | null> {
  const tvTickers = toTVTickers(ticker);
  const startTime = Date.now();

  try {
    console.log(`[technical] 请求 TradingView: ${tvTickers.join(", ")}`);
    const res = await fetch("https://scanner.tradingview.com/america/scan", {
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

    if (!res.ok) {
      console.warn(`[technical] TradingView 响应非 200: ${res.status}`);
      return null;
    }

    const json = (await res.json()) as {
      data?: Array<{ s?: string; d?: (number | string | null)[] }>;
    };

    const row = json.data?.find((r) => r.d && r.d.length > 0);
    if (!row || !row.d) {
      console.warn(`[technical] TradingView 返回空数据`);
      return null;
    }

    // 构建字段名 → 值的映射
    const idx = Object.fromEntries(COLUMNS.map((name, i) => [name, i]));
    const v: Record<string, number | null> = {};
    for (const col of COLUMNS) {
      // 移除 |1W 后缀，这样后面访问时用原始字段名
      const key = col.replace("|1W", "");
      v[key] = num(row.d[idx[col]]);
    }

    const price = v["close"];
    if (price == null) {
      console.warn(`[technical] 无价格数据`);
      return null;
    }

    // 直接使用 TradingView 官方 Recommend 值映射信号（与网站显示一致）
    const oscillators = recommendToSignal(v["Recommend.Other"]);
    const movingAverages = recommendToSignal(v["Recommend.MA"]);
    const overall = recommendToSignal(v["Recommend.All"]);

    const result = { oscillators, movingAverages, overall };
    console.log(
      `[technical] 成功 (${Date.now() - startTime}ms): ` +
      `价格=${price}, ` +
      `振荡=${oscillators}(raw=${v["Recommend.Other"]?.toFixed(4)}), ` +
      `均线=${movingAverages}(raw=${v["Recommend.MA"]?.toFixed(4)}), ` +
      `综合=${overall}(raw=${v["Recommend.All"]?.toFixed(4)})`
    );
    return result;
  } catch (err) {
    console.error(`[technical] 失败 (${Date.now() - startTime}ms):`, err instanceof Error ? err.message : err);
    return null;
  }
}
