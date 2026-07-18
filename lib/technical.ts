/**
 * 美股技术指标（TradingView Scanner API）
 *
 * 从 TradingView scanner 获取原始指标值，自行计算信号，
 * 返回 5 级信号：强烈卖出 / 卖出 / 中立 / 买入 / 强烈买入。
 *
 * 不依赖 scanner 的 Recommend 值（与前端页面计算方式不同），
 * 而是逐个评估振荡指标和移动均线，再汇总得出信号。
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

/** 请求 scanner API 的完整字段列表（原始指标值，非 Recommend） */
const COLUMNS: string[] = [
  // 振荡指标
  "RSI",
  "Stoch.K",
  "Stoch.D",
  "CCI20",
  "ADX",
  "ADX+DI",
  "ADX-DI",
  "AO",
  "Mom",
  "MACD.macd",
  "MACD.signal",
  "W.R",
  "UO",
  // 移动均线
  "EMA10", "EMA20", "EMA30", "EMA50", "EMA100", "EMA200",
  "SMA10", "SMA20", "SMA30", "SMA50", "SMA100", "SMA200",
  "VWMA", "HullMA9", "Ichimoku.BLine",
  // 价格
  "close",
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
/* 振荡指标逐个评估                                                     */
/* ------------------------------------------------------------------ */

/**
 * 评估单个振荡指标，返回 +1(买入) / 0(中立) / -1(卖出)
 */
function evalOscillator(
  name: string,
  v: Record<string, number | null>
): number {
  switch (name) {
    case "RSI": {
      const rsi = v["RSI"];
      if (rsi == null) return 0;
      if (rsi < 30) return 1;   // 超卖 → 买入
      if (rsi > 70) return -1;  // 超买 → 卖出
      return 0;
    }
    case "Stoch": {
      const k = v["Stoch.K"];
      const d = v["Stoch.D"];
      if (k == null || d == null) return 0;
      if (k < 20 && d < 20) return 1;
      if (k > 80 && d > 80) return -1;
      return 0;
    }
    case "CCI20": {
      const cci = v["CCI20"];
      if (cci == null) return 0;
      if (cci > 100) return -1;  // 超买
      if (cci < -100) return 1;  // 超卖
      return 0;
    }
    case "ADX": {
      const adx = v["ADX"];
      const plusDI = v["ADX+DI"];
      const minusDI = v["ADX-DI"];
      if (adx == null || plusDI == null || minusDI == null) return 0;
      if (adx > 20) {
        if (plusDI > minusDI) return 1;
        if (minusDI > plusDI) return -1;
      }
      return 0;
    }
    case "AO": {
      const ao = v["AO"];
      if (ao == null) return 0;
      return ao > 0 ? 1 : -1;
    }
    case "Mom": {
      const mom = v["Mom"];
      if (mom == null) return 0;
      return mom > 0 ? 1 : -1;
    }
    case "MACD": {
      const macd = v["MACD.macd"];
      const signal = v["MACD.signal"];
      if (macd == null || signal == null) return 0;
      if (macd > signal) return 1;
      if (macd < signal) return -1;
      return 0;
    }
    case "W.R": {
      const wr = v["W.R"];
      if (wr == null) return 0;
      if (wr < -80) return 1;   // 超卖
      if (wr > -20) return -1;  // 超买
      return 0;
    }
    case "UO": {
      const uo = v["UO"];
      if (uo == null) return 0;
      if (uo < 30) return 1;
      if (uo > 70) return -1;
      return 0;
    }
    default:
      return 0;
  }
}

/* ------------------------------------------------------------------ */
/* 信号计算                                                             */
/* ------------------------------------------------------------------ */

/**
 * 从一组 +1/0/-1 评分计算 5 级信号。
 * score = sum / count（-1 到 1 之间）
 * 然后用阈值映射到信号。
 */
function scoresToSignal(scores: number[]): Signal {
  if (scores.length === 0) return "neutral";
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  // 阈值：与 TradingView 前端一致的 5 级映射
  if (avg >= 0.5) return "strong_buy";
  if (avg >= 0.1) return "buy";
  if (avg > -0.1) return "neutral";
  if (avg > -0.5) return "sell";
  return "strong_sell";
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
      v[col] = num(row.d[idx[col]]);
    }

    const price = v["close"];
    if (price == null) {
      console.warn(`[technical] 无价格数据`);
      return null;
    }

    // ---- 振荡指标信号 ----
    const oscNames = ["RSI", "Stoch", "CCI20", "ADX", "AO", "Mom", "MACD", "W.R", "UO"];
    const oscScores = oscNames.map((name) => evalOscillator(name, v));
    const oscillators = scoresToSignal(oscScores);

    // ---- 移动均线信号 ----
    const maColumns = [
      "EMA10", "EMA20", "EMA30", "EMA50", "EMA100", "EMA200",
      "SMA10", "SMA20", "SMA30", "SMA50", "SMA100", "SMA200",
      "VWMA", "HullMA9", "Ichimoku.BLine",
    ];
    const maScores: number[] = [];
    for (const col of maColumns) {
      const maVal = v[col];
      if (maVal != null) {
        maScores.push(price > maVal ? 1 : -1);
      }
    }
    const movingAverages = scoresToSignal(maScores);

    // ---- 综合信号（振荡 + 均线合并）----
    const allScores = [...oscScores, ...maScores];
    const overall = scoresToSignal(allScores);

    const result = { oscillators, movingAverages, overall };
    console.log(
      `[technical] 成功 (${Date.now() - startTime}ms): ` +
      `振荡=${oscillators}(${oscScores}), ` +
      `均线=${movingAverages}(${maScores.filter(s => s > 0).length}B/${maScores.filter(s => s < 0).length}S), ` +
      `综合=${overall}`
    );
    return result;
  } catch (err) {
    console.error(`[technical] 失败 (${Date.now() - startTime}ms):`, err instanceof Error ? err.message : err);
    return null;
  }
}
