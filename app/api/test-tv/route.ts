import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * 诊断：获取 TradingView 完整原始指标值，用于对比前端页面
 * 访问 /api/test-tv?ticker=NFLX
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "NFLX").toUpperCase();

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    Origin: "https://www.tradingview.com",
    Referer: "https://www.tradingview.com/",
  };

  // 完整的振荡指标 + 移动均线字段
  const allColumns = [
    // 推荐汇总
    "Recommend.All|1W", "Recommend.MA|1W", "Recommend.Other|1W",
    // 振荡指标
    "RSI|1W", "RSI[1]|1W", "Stoch.K|1W", "Stoch.D|1W", "CCI20|1W", "ADX|1W", "ADX+DI|1W", "ADX-DI|1W",
    "AO|1W", "Mom|1W", "MACD.macd|1W", "MACD.signal|1W", "StochRSI.K|1W", "W.R|1W", "BBPower|1W", "UO|1W",
    // 移动均线
    "EMA10|1W", "EMA20|1W", "EMA30|1W", "EMA50|1W", "EMA100|1W", "EMA200|1W",
    "SMA10|1W", "SMA20|1W", "SMA30|1W", "SMA50|1W", "SMA100|1W", "SMA200|1W",
    "VWMA|1W", "HullMA9|1W", "Ichimoku.BLine|1W",
    // 价格
    "close|1W", "change|1W",
  ];

  const results: Record<string, unknown> = { ticker, timestamp: new Date().toISOString() };

  // 用 /america/scan 获取完整数据
  const tickers = [`NASDAQ:${ticker}`, `NYSE:${ticker}`];
  const scanStart = Date.now();
  try {
    const res = await fetch("https://scanner.tradingview.com/america/scan", {
      method: "POST",
      headers,
      body: JSON.stringify({
        symbols: { tickers },
        columns: allColumns,
      }),
      signal: AbortSignal.timeout(10000),
    } as RequestInit);

    results.scanStatus = res.status;
    results.scanTimeMs = Date.now() - scanStart;

    if (res.ok) {
      const json = await res.json() as {
        data?: Array<{ s?: string; d?: (number | string | null)[] }>;
      };
      const row = json.data?.find((r) => r.d && r.d.length > 0);
      if (row?.d) {
        // 将字段名和值映射为对象
        const values: Record<string, number | string | null> = {};
        allColumns.forEach((col, i) => {
          values[col] = row.d![i] ?? null;
        });
        results.symbol = row.s;
        results.values = values;

        // 解析 Recommend 值
        results.recommend = {
          all: row.d[allColumns.indexOf("Recommend.All|1W")],
          MA: row.d[allColumns.indexOf("Recommend.MA|1W")],
          Other: row.d[allColumns.indexOf("Recommend.Other|1W")],
        };
      }
    }
  } catch (err) {
    results.scanError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(results);
}
