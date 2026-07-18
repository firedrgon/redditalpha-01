import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

/**
 * 诊断端点：测试 TradingView API 连通性 + 检查 DB 中技术信号数据
 *
 * 使用方式：访问 /api/test-tv?ticker=AAPL
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "AAPL").toUpperCase();

  const results: Record<string, unknown> = {
    ticker,
    timestamp: new Date().toISOString(),
  };

  // 1. 测试 TradingView API
  const tvStart = Date.now();
  const tvResult: Record<string, unknown> = {};
  try {
    const body = JSON.stringify({
      symbols: { tickers: [`NASDAQ:${ticker}`, `NYSE:${ticker}`] },
      columns: ["Recommend.All", "Recommend.MA", "Recommend.Other", "close"],
    });

    const res = await fetch("https://scanner.tradingview.com/us/scan", {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Type": "application/json",
        Origin: "https://www.tradingview.com",
        Referer: "https://www.tradingview.com/",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    tvResult.status = res.status;
    tvResult.statusText = res.statusText;
    tvResult.timeMs = Date.now() - tvStart;

    if (res.ok) {
      const json = await res.json();
      tvResult.dataCount = json.data?.length ?? 0;
      tvResult.data = json.data;
    } else {
      tvResult.body = (await res.text()).slice(0, 200);
    }
  } catch (err) {
    tvResult.error = err instanceof Error ? err.message : String(err);
    tvResult.timeMs = Date.now() - tvStart;
  }
  results.tv = tvResult;

  // 2. 检查 DB 中该 ticker 的技术信号数据
  const prisma = getPrisma();
  if (prisma) {
    try {
      // 用 raw SQL 查询，避免 technicalSignals 列不存在时报错
      const rows = await prisma.$queryRawUnsafe<
        Array<{ ticker: string; technical_signals: string | null; updated_at: Date }>
      >(
        `SELECT ticker, technical_signals, updated_at FROM "AnalysisCache" WHERE ticker = $1 LIMIT 1`,
        ticker
      );
      if (rows.length > 0) {
        results.db = {
          found: true,
          technicalSignals: rows[0].technical_signals
            ? JSON.parse(rows[0].technical_signals)
            : null,
          updatedAt: rows[0].updated_at,
        };
      } else {
        results.db = { found: false };
      }
    } catch (err) {
      // 如果 technical_signals 列不存在，用不含该列的查询
      try {
        const rows = await prisma.$queryRawUnsafe<
          Array<{ ticker: string; updated_at: Date }>
        >(`SELECT ticker, updated_at FROM "AnalysisCache" WHERE ticker = $1 LIMIT 1`, ticker);
        results.db = {
          found: rows.length > 0,
          note: "technicalSignals 列不存在，需访问 /api/db-sync 同步",
        };
      } catch {
        results.db = { error: "查询失败" };
      }
    }
  } else {
    results.db = { error: "数据库未配置" };
  }

  return NextResponse.json(results);
}
