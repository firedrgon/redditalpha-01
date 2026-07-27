/**
 * 美股技术指标（TradingView Scanner API） + A 股技术指标（TradingView 中国区 Scanner）+ A 股筹码状态（同花顺）
 *
 * TradingView 美股：scanner.tradingview.com/america，symbol 前缀 NASDAQ:/NYSE:
 * TradingView A 股：scanner.tradingview.com/china，symbol 前缀 SSE:/SZSE:
 *   - 两者返回完全相同的 Recommend.All/MA/Other 周线值，映射逻辑共用，A 股与美股信号语义一致。
 * 同花顺筹码状态：仅用于 A 股，从 chip_situation.desc 获取，作为辅助指标展示。
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

/** A 股 ticker（600276.SH）→ TradingView 中国区 symbol：沪市 SSE:600276 / 深市 SZSE:000001 */
function toCNTradingViewTickers(ticker: string): string[] {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return [ticker];
  const exchange = m[2] === "SZ" ? "SZSE" : "SSE";
  return [`${exchange}:${m[1]}`];
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
  return fetchTradingViewScan("america", toTVTickers(ticker));
}

/**
 * 获取 A 股 TradingView 中国区技术信号（与美股完全同构，仅 scanner 分区与 symbol 前缀不同）。
 *
 * @param ticker A 股 ticker，如 "600276.SH"
 * @returns 5 级技术信号；失败返回 null
 */
export async function fetchCNTradingViewTechnicals(
  ticker: string
): Promise<TechnicalSignals | null> {
  return fetchTradingViewScan("china", toCNTradingViewTickers(ticker));
}

export interface TVScanRow {
  /** TradingView symbol，如 "SSE:600276" */
  s: string;
  signals: TechnicalSignals;
}

/**
 * 共享核心（批量）：请求 TradingView scanner（america / china 等分区），
 * 用官方 Recommend 周线值映射为 5 级信号，返回所有命中的行（含 symbol 映射）。
 * 一次请求可拿回多只股票的信号，适合热榜等批量场景。
 */
async function fetchTradingViewScanMulti(
  endpoint: string,
  tvTickers: string[],
  timeoutMs = 10000
): Promise<TVScanRow[]> {
  if (tvTickers.length === 0) return [];
  const startTime = Date.now();

  try {
    console.log(
      `[technical] 请求 TradingView(${endpoint}) x${tvTickers.length}: ${tvTickers.slice(0, 5).join(", ")}…`
    );
    const res = await fetch(`https://scanner.tradingview.com/${endpoint}/scan`, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.warn(`[technical] TradingView(${endpoint}) 响应非 200: ${res.status}`);
      return [];
    }

    const json = (await res.json()) as {
      data?: Array<{ s?: string; d?: (number | string | null)[] }>;
    };

    const rows = json.data ?? [];
    const idx = Object.fromEntries(COLUMNS.map((name, i) => [name, i]));

    const out: TVScanRow[] = [];
    for (const row of rows) {
      if (!row.s || !row.d || row.d.length === 0) continue;
      const v: Record<string, number | null> = {};
      for (const col of COLUMNS) {
        const key = col.replace("|1W", "");
        v[key] = num(row.d[idx[col]]);
      }
      if (v["close"] == null) continue; // 无价格数据的行跳过
      out.push({
        s: row.s,
        signals: {
          oscillators: recommendToSignal(v["Recommend.Other"]),
          movingAverages: recommendToSignal(v["Recommend.MA"]),
          overall: recommendToSignal(v["Recommend.All"]),
        },
      });
    }
    console.log(
      `[technical] 成功(${endpoint}) (${Date.now() - startTime}ms): ${out.length}/${tvTickers.length} 命中`
    );
    return out;
  } catch (err) {
    console.error(`[technical] 失败(${endpoint}) (${Date.now() - startTime}ms):`, err instanceof Error ? err.message : err);
    return [];
  }
}

/** 单只版本：取批量结果的第一条（保持与旧调用方兼容） */
async function fetchTradingViewScan(
  endpoint: string,
  tvTickers: string[]
): Promise<TechnicalSignals | null> {
  const rows = await fetchTradingViewScanMulti(endpoint, tvTickers);
  return rows[0]?.signals ?? null;
}

/**
 * 批量获取 A 股 TradingView 中国区技术信号。
 * 一次 scanner 请求拿回所有 ticker 的信号，避免对 n 只各发一次请求。
 *
 * @param tickers A 股 ticker 数组，如 ["600276.SH", "000651.SZ"]
 * @returns Map<ticker, TechnicalSignals>；未命中/失败的 ticker 不在 Map 中
 */
export async function fetchCNTradingViewTechnicalsBatch(
  tickers: string[]
): Promise<Map<string, TechnicalSignals>> {
  const result = new Map<string, TechnicalSignals>();
  if (tickers.length === 0) return result;

  const tvToTicker = new Map<string, string>();
  const tvTickers: string[] = [];
  for (const t of tickers) {
    const m = t.match(/^(\d{6})\.(SH|SZ)$/);
    if (!m) continue;
    const exchange = m[2] === "SZ" ? "SZSE" : "SSE";
    const sym = `${exchange}:${m[1]}`;
    tvTickers.push(sym);
    tvToTicker.set(sym, t);
  }
  if (tvTickers.length === 0) return result;

  const rows = await fetchTradingViewScanMulti("china", tvTickers);
  for (const row of rows) {
    const tk = tvToTicker.get(row.s);
    if (tk) result.set(tk, row.signals);
  }
  return result;
}

/**
 * 批量获取美股 TradingView 技术信号（america 分区）。
 * 一次 scanner 请求拿回所有 ticker 的信号，避免对 n 只各发一次请求。
 * 美股 symbol 前缀为 NASDAQ:/NYSE:，两者都尝试，命中其一即记录。
 *
 * @param tickers 美股 ticker 数组，如 ["NVDA", "AAPL", "TSLA"]
 * @param timeoutMs 单次 scanner 请求超时（毫秒），默认 10s；调用方可传更长时间（如 Reddit 批量抓取时）
 * @returns Map<ticker(大写), TechnicalSignals>；未命中/失败的 ticker 不在 Map 中
 */
export async function fetchTradingViewTechnicalsBatch(
  tickers: string[],
  timeoutMs = 10000
): Promise<Map<string, TechnicalSignals>> {
  const result = new Map<string, TechnicalSignals>();
  if (tickers.length === 0) return result;

  const tvToTicker = new Map<string, string>();
  const tvTickers: string[] = [];
  for (const t of tickers) {
    const up = t.toUpperCase();
    for (const ex of ["NASDAQ", "NYSE"]) {
      const sym = `${ex}:${up}`;
      tvTickers.push(sym);
      tvToTicker.set(sym, up);
    }
  }
  if (tvTickers.length === 0) return result;

  const rows = await fetchTradingViewScanMulti("america", tvTickers, timeoutMs);
  for (const row of rows) {
    const tk = tvToTicker.get(row.s);
    // 同一 ticker 可能 NASDAQ/NYSE 都返回，取第一个命中的
    if (tk && !result.has(tk)) result.set(tk, row.signals);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* A 股筹码状态（同花顺 API）                                             */
/* ------------------------------------------------------------------ */

/**
 * 从同花顺获取 A 股筹码状态描述。
 *
 * API: https://basic.10jqka.com.cn/api/stockph/research/{code}/stock/
 * 取 data.user_action.chip_situation.desc，去除 HTML 标签后返回纯文本。
 *
 * @param ticker A 股 ticker，如 "600276.SH"
 * @returns 筹码状态纯文本描述（如 "当前个股近120天的平均成本为54.45元…筹码状态高度密集…可继续关注。"），失败返回 null
 */
export async function fetchChipSituation(ticker: string): Promise<string | null> {
  const code = ticker.match(/^(\d{6})\.(SH|SZ)$/)?.[1];
  if (!code) {
    console.warn(`[chipSituation] 无法提取股票代码: ${ticker}`);
    return null;
  }

  const startTime = Date.now();
  try {
    const url = `https://basic.10jqka.com.cn/api/stockph/research/${code}/stock/`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: "https://basic.10jqka.com.cn/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[chipSituation] 同花顺响应非 200: ${res.status} (${ticker})`);
      return null;
    }

    const json = await res.json() as {
      status_code?: number;
      data?: {
        user_action?: {
          chip_situation?: {
            desc?: string;
          };
        };
      };
    };

    const desc = json?.data?.user_action?.chip_situation?.desc;
    if (!desc) {
      console.warn(`[chipSituation] 无筹码数据: ${ticker}`);
      return null;
    }

    // 去除 HTML 标签，保留纯文本
    const plainText = desc
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    console.log(`[chipSituation] 成功 (${Date.now() - startTime}ms): ${ticker} -> ${plainText.slice(0, 60)}…`);
    return plainText;
  } catch (err) {
    console.error(`[chipSituation] 失败 (${Date.now() - startTime}ms): ${ticker}`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 从筹码状态纯文本描述中提取状态关键词。
 *
 * desc 格式示例: "…筹码状态高度密集，可继续关注。"
 * 匹配 "筹码状态" 后紧跟的关键词（如 高度密集、较为分散、分散 等）。
 *
 * @returns 关键词字符串，如 "高度密集"；未匹配到返回 null
 */
export function extractChipKeyword(desc: string | null): string | null {
  if (!desc) return null;
  const m = desc.match(/筹码状态[，,\s]*([^\s，,。.]+)/);
  return m?.[1] ?? null;
}
