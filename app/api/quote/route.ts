import { NextRequest, NextResponse } from "next/server";
import { fetchQuotes } from "@/lib/quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/quote?tickers=AAPL,600276.SH,TSLA
 * 或 GET /api/quote?ticker=AAPL
 *
 * 返回：{ quotes: { TICKER: Quote } }
 * Quote: { ticker, price, change, changePercent, currency, name, market, ok }
 *
 * 用于卡片展示实时价格 + 涨跌幅（中美双源，轻量）。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const single = searchParams.get("ticker");
  const multi = searchParams.get("tickers");

  let tickers: string[] = [];
  if (single) {
    tickers = [single];
  } else if (multi) {
    tickers = multi
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (tickers.length === 0) {
    return NextResponse.json({ error: "缺少 ticker / tickers 参数" }, { status: 400 });
  }
  // 限制批量大小，避免滥用
  if (tickers.length > 100) {
    tickers = tickers.slice(0, 100);
  }

  try {
    const quotes = await fetchQuotes(tickers);
    return NextResponse.json({ quotes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
