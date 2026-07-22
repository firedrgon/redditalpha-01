/**
 * 轻量行情接口：只取价格 + 涨跌额 + 涨跌幅，用于卡片展示。
 *
 * 与 lib/finance.ts 的 fetchFinancialMetrics（重，20s 超时、串多个源）不同，
 * 这里走最快的单源：
 *   - 美股 / 加密：Yahoo v7/finance/quote（无需 crumb，含 regularMarketPrice/Change/ChangePercent）
 *   - A 股：东方财富 push2 行情（f43 现价/分、f169 涨跌额/分、f170 涨跌幅%）
 *
 * 设计为批量友好：fetchQuotes 并行拉取，结果按 ticker 大写映射。
 */

import { detectMarket, normalizeCNTicker, type Market } from "./market";
import { readFinanceConfig } from "./finance-config";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface Quote {
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  name?: string | null;
  market: Market;
  /** 拉取是否成功（false 时仅 ticker/market 有效，其余为 null） */
  ok: boolean;
}

const EMPTY = (ticker: string, market: Market): Quote => ({
  ticker,
  price: null,
  change: null,
  changePercent: null,
  currency: market === "CN" ? "CNY" : "USD",
  name: null,
  market,
  ok: false,
});

/** 美股 / 加密：优先用已配置的 Finnhub / FMP key，Yahoo 仅作兜底 */
async function fetchUSQuote(ticker: string): Promise<Quote> {
  const cfg = await readFinanceConfig().catch(() => null);

  // 1) Finnhub quote（已配置 key 时）
  if (cfg?.finnhubApiKey) {
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
        ticker
      )}&token=${encodeURIComponent(cfg.finnhubApiKey)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (res.ok) {
        const d = (await res.json()) as {
          c?: number; d?: number | null; dp?: number | null;
          pc?: number; t?: number;
        };
        // c 为当前价；d=涨跌额，dp=涨跌幅%
        if (typeof d.c === "number" && d.c > 0) {
          return {
            ticker,
            price: d.c,
            change: typeof d.d === "number" ? d.d : null,
            changePercent: typeof d.dp === "number" ? d.dp : null,
            currency: "USD",
            name: null,
            market: "US",
            ok: true,
          };
        }
      }
    } catch {
      /* 降级到下一源 */
    }
  }

  // 2) FMP quote（已配置 key 时）
  if (cfg?.fmpApiKey) {
    try {
      const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(
        ticker
      )}?apikey=${encodeURIComponent(cfg.fmpApiKey)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (res.ok) {
        const arr = (await res.json()) as Array<{
          price?: number; change?: number; changesPercentage?: number;
        }>;
        const d = arr?.[0];
        if (d && typeof d.price === "number") {
          return {
            ticker,
            price: d.price,
            change: typeof d.change === "number" ? d.change : null,
            changePercent:
              typeof d.changesPercentage === "number"
                ? d.changesPercentage
                : null,
            currency: "USD",
            name: null,
            market: "US",
            ok: true,
          };
        }
      }
    } catch {
      /* 降级到 Yahoo */
    }
  }

  // 3) Yahoo v8 chart 兜底（可能 403，失败则返回空）
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=1d&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (res.ok) {
      const j = (await res.json()) as {
        chart?: { result?: Array<{ meta?: Record<string, number | string | null> }> };
      };
      const m = j?.chart?.result?.[0]?.meta;
      if (m) {
        const price = typeof m.regularMarketPrice === "number" ? m.regularMarketPrice : null;
        const prev =
          typeof m.chartPreviousClose === "number"
            ? m.chartPreviousClose
            : typeof m.previousClose === "number"
              ? m.previousClose
              : null;
        if (price != null && prev && prev !== 0) {
          const change = price - prev;
          return {
            ticker: typeof m.symbol === "string" ? m.symbol : ticker,
            price,
            change,
            changePercent: (price / prev - 1) * 100,
            currency: typeof m.currency === "string" ? m.currency : "USD",
            name: typeof m.shortName === "string" ? m.shortName : null,
            market: "US",
            ok: true,
          };
        }
      }
    }
  } catch {
    /* ignore */
  }

  return EMPTY(ticker, "US");
}

/** A 股：东方财富 push2 行情 */
async function fetchCNQuote(ticker: string): Promise<Quote> {
  const norm = normalizeCNTicker(ticker);
  const m = norm?.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return EMPTY(ticker, "CN");
  const [, code, ex] = m;
  const secid = ex === "SH" ? `1.${code}` : `0.${code}`;
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f58,f169,f170`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return EMPTY(ticker, "CN");
    const json = (await res.json()) as { data?: Record<string, number | string | null> };
    const d = json?.data;
    if (!d || d.f43 == null) return EMPTY(ticker, "CN");
    const price = typeof d.f43 === "number" ? d.f43 / 100 : null;
    const change =
      typeof d.f169 === "number" ? d.f169 / 100 : null;
    // f170 为涨跌幅（百分制的 100 倍，如 84 表示 +0.84%），需 /100
    const changePercent = typeof d.f170 === "number" ? d.f170 / 100 : null;
    return {
      ticker: norm ?? ticker,
      price,
      change,
      changePercent,
      currency: "CNY",
      name: typeof d.f58 === "string" ? d.f58 : null,
      market: "CN",
      ok: true,
    };
  } catch {
    return EMPTY(ticker, "CN");
  }
}

/** 单 ticker 行情 */
export async function fetchQuote(ticker: string): Promise<Quote> {
  const market = detectMarket(ticker);
  if (market === "CN") return fetchCNQuote(ticker);
  // 美股 / 加密 / 未知 都走 Yahoo（Yahoo 能覆盖大部分美股与 BTC-USD 等加密）
  return fetchUSQuote(ticker);
}

/** 批量行情，结果按 ticker 大写映射 */
export async function fetchQuotes(
  tickers: string[]
): Promise<Record<string, Quote>> {
  const unique = Array.from(new Set(tickers.map((t) => t.trim().toUpperCase())));
  const results = await Promise.all(unique.map((t) => fetchQuote(t)));
  const map: Record<string, Quote> = {};
  for (const q of results) {
    map[q.ticker.toUpperCase()] = q;
  }
  return map;
}
