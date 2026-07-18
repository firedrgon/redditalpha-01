import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

/**
 * 诊断端点：测试多种 TradingView API 端点，找到可用的
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

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    Origin: "https://www.tradingview.com",
    Referer: "https://www.tradingview.com/",
  };

  const tvTicker = `NASDAQ:${ticker}`;
  const fields = "Recommend.All,Recommend.MA,Recommend.Other,RSI,MACD.macd,close";

  // 测试多个 TradingView 端点
  const endpoints = [
    {
      name: "scanner_us_scan",
      url: "https://scanner.tradingview.com/us/scan",
      options: {
        method: "POST",
        headers,
        body: JSON.stringify({
          symbols: { tickers: [tvTicker, `NYSE:${ticker}`] },
          columns: ["Recommend.All", "Recommend.MA", "Recommend.Other", "close"],
        }),
      },
    },
    {
      name: "scanner_symbol_get",
      url: `https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(tvTicker)}&fields=${fields}`,
      options: { method: "GET", headers },
    },
    {
      name: "scanner_global_scan",
      url: "https://scanner.tradingview.com/global/scan",
      options: {
        method: "POST",
        headers,
        body: JSON.stringify({
          symbols: { tickers: [tvTicker, `NYSE:${ticker}`] },
          columns: ["Recommend.All", "Recommend.MA", "Recommend.Other", "close"],
        }),
      },
    },
    {
      name: "scanner_americas_scan",
      url: "https://scanner.tradingview.com/america/scan",
      options: {
        method: "POST",
        headers,
        body: JSON.stringify({
          symbols: { tickers: [tvTicker, `NYSE:${ticker}`] },
          columns: ["Recommend.All", "Recommend.MA", "Recommend.Other", "close"],
        }),
      },
    },
  ];

  const endpointResults: Record<string, unknown>[] = [];

  for (const ep of endpoints) {
    const start = Date.now();
    const result: Record<string, unknown> = { name: ep.name, url: ep.url };
    try {
      const res = await fetch(ep.url, {
        ...ep.options,
        signal: AbortSignal.timeout(10000),
      } as RequestInit);
      result.status = res.status;
      result.statusText = res.statusText;
      result.timeMs = Date.now() - start;
      if (res.ok) {
        const text = await res.text();
        result.bodyPreview = text.slice(0, 300);
      } else {
        result.bodyPreview = (await res.text()).slice(0, 200);
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.timeMs = Date.now() - start;
    }
    endpointResults.push(result);
  }

  results.endpoints = endpointResults;

  // 检查 DB 状态
  const prisma = getPrisma();
  if (prisma) {
    try {
      // 先测试基本连接
      await prisma.$queryRawUnsafe<{ one: number }[]>(`SELECT 1 as one`);
      results.dbConnection = "OK";

      // 检查 AnalysisCache 表是否存在
      const tableCheck = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = 'AnalysisCache'`
      );
      results.tableExists = Number(tableCheck[0]?.cnt ?? 0) > 0;

      if (results.tableExists) {
        // 检查列
        const colCheck = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
          `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_name = 'AnalysisCache' AND column_name = 'technicalSignals'`
        );
        results.hasTechnicalSignals = Number(colCheck[0]?.cnt ?? 0) > 0;

        // 尝试查询数据
        try {
          const rows = await prisma.$queryRawUnsafe<
            Array<{ ticker: string; technical_signals: string | null; updated_at: Date }>
          >(
            `SELECT ticker, "technicalSignals" as technical_signals, "updatedAt" as updated_at FROM "AnalysisCache" WHERE ticker = $1 LIMIT 1`,
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
        } catch (qErr) {
          results.db = { error: qErr instanceof Error ? qErr.message : String(qErr) };
        }
      } else {
        results.db = { error: "AnalysisCache 表不存在" };
      }
    } catch (err) {
      results.db = { error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    results.db = { error: "数据库未配置" };
  }

  return NextResponse.json(results);
}
