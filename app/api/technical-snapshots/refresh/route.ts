import { NextRequest, NextResponse } from "next/server";
import { refreshTechnicalSnapshot, getTechnicalSnapshot } from "@/lib/db/technical-snapshot";
import { detectMarket } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/technical-snapshots/refresh
 * Body: { ticker: "AAPL", tickerName?: "Apple", force?: boolean }
 *
 * 按需拉取最新 TradingView 信号并写入 snapshot。
 * 仅美股；非美股返回 400。
 *
 * 用于：
 * 1. 客户端 Card 懒刷新（snapshot 缺失或 > 24h）
 * 2. 单条手动刷新
 *
 * 响应：{ snapshot, refreshed: true } 或 { snapshot: <旧值>, refreshed: false, reason: "..." }
 */
export async function POST(request: NextRequest) {
  let body: { ticker?: string; tickerName?: string; force?: boolean };
  try {
    body = (await request.json()) as { ticker?: string; tickerName?: string; force?: boolean };
  } catch {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }

  const ticker = (body.ticker || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  if (detectMarket(ticker) !== "US") {
    return NextResponse.json(
      { error: "技术信号仅支持美股", market: detectMarket(ticker) },
      { status: 400 }
    );
  }

  // 非 force 模式下，若 snapshot < 5 分钟内已拉过则跳过（防止快速连点）
  if (!body.force) {
    const existing = await getTechnicalSnapshot(ticker);
    if (existing && Date.now() - existing.fetchedAt < 5 * 60 * 1000) {
      return NextResponse.json({ snapshot: existing, refreshed: false, reason: "fresh" });
    }
  }

  try {
    const row = await refreshTechnicalSnapshot(ticker, body.tickerName);
    if (!row) {
      return NextResponse.json(
        { snapshot: null, refreshed: false, reason: "fetch_failed" },
        { status: 502 }
      );
    }
    return NextResponse.json({ snapshot: row, refreshed: true });
  } catch (err) {
    console.error("[api/technical-snapshots/refresh] 失败:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
