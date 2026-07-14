import { NextRequest, NextResponse } from "next/server";
import { detectMarket, normalizeCNTicker, toXueqiuSymbol, toYahooSymbol, toTonghuashunSymbol, toTencentSymbol } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  quoteType?: string;
  exchange?: string;
}

interface YahooSearchResponse {
  quotes?: YahooSearchQuote[];
}

/**
 * GET /api/validate-ticker?ticker=AAPL
 *
 * A 股（6 位数字 / .SH / .SZ / SH/SZ 前缀）走雪球接口校验；
 * 其他（美股/ETF/加密）走 Yahoo Finance Search API。
 *
 * 返回：
 *   - valid: boolean
 *   - ticker: 标准化后的 ticker（A 股为 600519.SH 格式）
 *   - name: 公司名
 *   - quoteType: EQUITY / ETF / ...
 *   - market: "CN" | "US" | ...
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const raw = (searchParams.get("ticker") || "").trim();

  if (!raw) {
    return NextResponse.json(
      { valid: false, error: "缺少 ticker 参数" },
      { status: 400 }
    );
  }

  const ticker = raw.toUpperCase();
  const market = detectMarket(raw);

  // ============================================================
  // A 股校验：同花顺 → 雪球 → Yahoo Finance 降级
  // ============================================================
  if (market === "CN") {
    const cnTicker = normalizeCNTicker(raw);
    if (!cnTicker) {
      return NextResponse.json({
        valid: false,
        ticker,
        market: "CN",
        error: "A 股代码格式不正确（需为 6 位数字，可带 .SH/.SZ 后缀）",
      });
    }

    // 1. 并行校验：同花顺 + 腾讯（两者全球可访问）
    const [thsRes, tencentRes] = await Promise.allSettled([
      (async () => {
        const symbol = toTonghuashunSymbol(cnTicker);
        const res = await fetch(
          `https://d.10jqka.com.cn/v6/realhead/${symbol}/last.js`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
              Referer: "https://basic.10jqka.com.cn/",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) return null;
        const body = await res.text();
        const m = body.match(/\((\{[\s\S]*\})\)/);
        if (!m) return null;
        const data = JSON.parse(m[1]);
        return data?.items?.name ?? null;
      })(),
      (async () => {
        const symbol = toTencentSymbol(cnTicker);
        const res = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        const text = new TextDecoder("gbk").decode(buf);
        const m = text.match(/v_\w+="([^"]+)"/);
        if (!m) return null;
        const fields = m[1].split("~");
        return fields[1] || null;
      })(),
    ]);

    const thsName = thsRes.status === "fulfilled" ? thsRes.value : null;
    const tencentName = tencentRes.status === "fulfilled" ? tencentRes.value : null;
    const stockName = thsName || tencentName;

    if (stockName) {
      return NextResponse.json({
        valid: true,
        ticker: cnTicker,
        name: stockName,
        quoteType: "EQUITY",
        market: "CN",
        exchange: cnTicker.endsWith(".SH") ? "上交所" : "深交所",
        exactMatch: true,
      });
    }

    // 2. 雪球校验
    try {
      const symbol = toXueqiuSymbol(cnTicker);
      const res = await fetch(
        `https://stock.xueqiu.com/v5/stock/quote.json?symbol=${symbol}&extend=detail`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            Accept: "application/json",
            Referer: "https://xueqiu.com/",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        }
      );

      if (res.ok) {
        const data = await res.json();
        const quote = data?.data?.quote;
        if (quote && quote.name) {
          return NextResponse.json({
            valid: true,
            ticker: cnTicker,
            name: quote.name as string,
            quoteType: "EQUITY",
            market: "CN",
            exchange: cnTicker.endsWith(".SH") ? "上交所" : "深交所",
            exactMatch: true,
          });
        }
      }
    } catch {
      /* 雪球失败，降级 Yahoo */
    }

    // 3. Yahoo Finance 降级（海外服务器可访问）
    try {
      const yahooSymbol = toYahooSymbol(cnTicker);
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSymbol)}&quotesCount=3&newsCount=0`,
        {
          headers: { "User-Agent": "Mozilla/5.0" },
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        }
      );

      if (res.ok) {
        const data = await res.json();
        const quotes = data?.quotes || [];
        const hit = quotes.find(
          (q: { symbol?: string }) => q.symbol?.toUpperCase() === yahooSymbol.toUpperCase()
        );
        if (hit && (hit.shortname || hit.longname)) {
          return NextResponse.json({
            valid: true,
            ticker: cnTicker,
            name: hit.longname || hit.shortname,
            quoteType: hit.quoteType || "EQUITY",
            market: "CN",
            exchange: cnTicker.endsWith(".SH") ? "上交所" : "深交所",
            exactMatch: true,
          });
        }
      }
    } catch {
      /* Yahoo 也失败 */
    }

    return NextResponse.json({
      valid: false,
      ticker: cnTicker,
      market: "CN",
      error: "未在同花顺/雪球/Yahoo Finance 找到该 A 股代码",
    });
  }

  // ============================================================
  // 美股 / 其他：Yahoo Finance Search API
  // ============================================================
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      ticker
    )}&quotesCount=5&newsCount=0`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({
        valid: false,
        ticker,
        market,
        error: `Yahoo Search HTTP ${res.status}`,
      });
    }

    const data = (await res.json()) as YahooSearchResponse;
    const quotes = data.quotes || [];

    // 优先找精确 symbol 匹配
    const exact = quotes.find(
      (q) => q.symbol?.toUpperCase() === ticker
    );

    // 否则取第一个有效结果
    const fallback = quotes.find(
      (q) => q.symbol && q.quoteType && q.quoteType !== "INDEX"
    );

    const hit = exact || fallback;

    if (!hit || !hit.symbol) {
      return NextResponse.json({
        valid: false,
        ticker,
        market,
        error: "未在 Yahoo Finance 中找到该 ticker",
      });
    }

    const allowedTypes = new Set([
      "EQUITY",
      "ETF",
      "MUTUALFUND",
      "CRYPTOCURRENCY",
      "CURRENCY",
      "FUTURE",
    ]);

    const isValidType =
      !hit.quoteType || allowedTypes.has(hit.quoteType.toUpperCase());

    return NextResponse.json({
      valid: isValidType,
      ticker: hit.symbol.toUpperCase(),
      name: hit.longname || hit.shortname || null,
      quoteType: hit.quoteType || null,
      exchange: hit.exchange || null,
      market,
      exactMatch: exact != null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        valid: false,
        ticker,
        market,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
