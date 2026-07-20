import { NextRequest, NextResponse } from "next/server";
import { listTechnicalSnapshots } from "@/lib/db/technical-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/technical-snapshots?tickers=AAPL,NFLX,TSLA
 *
 * 批量取 ticker 的最新技术信号快照，返回 Map 数组。
 * 公开端点（Card 渲染时调用，无需登录）。
 *
 * 响应：
 * {
 *   snapshots: [
 *     { ticker, tickerName, overall, oscillators, movingAverages, price, fetchedAt, updatedAt }
 *   ],
 *   notFound: ["AAPL"]   // 没有 snapshot 的 ticker
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("tickers") || "";
  const tickers = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 100); // 单次最多 100 个

  if (tickers.length === 0) {
    return NextResponse.json({ snapshots: [], notFound: [] });
  }

  try {
    const map = await listTechnicalSnapshots(tickers);
    const found: unknown[] = [];
    const notFound: string[] = [];
    for (const t of tickers) {
      const row = map.get(t);
      if (row) found.push(row);
      else notFound.push(t);
    }
    return NextResponse.json({ snapshots: found, notFound });
  } catch (err) {
    console.error("[api/technical-snapshots] 获取失败:", err);
    return NextResponse.json(
      { snapshots: [], notFound: tickers, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
