import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

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
 * 用 Yahoo Finance Search API 校验 ticker 是否为有效股票/ETF 标的。
 * 返回：
 *   - valid: boolean
 *   - symbol: 标准化后的 symbol
 *   - name: 公司名（如果命中）
 *   - quoteType: EQUITY / ETF / MUTUALFUND / CRYPTOCURRENCY 等
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();

  if (!ticker) {
    return NextResponse.json(
      { valid: false, error: "缺少 ticker 参数" },
      { status: 400 }
    );
  }

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
      exactMatch: exact != null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        valid: false,
        ticker,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
