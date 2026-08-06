import { NextRequest, NextResponse } from "next/server";
import {
  fetchRedditHotStocks,
  storeRedditHotStocks,
  getRedditHotStocks,
} from "@/lib/reddit-hot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reddit-hot?limit=100
 * 读取当日 Reddit 热榜；当日无数据则回退到最近一次快照。
 */
export async function GET(request: NextRequest) {
  try {
    const limit = Math.min(
      Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 100), 1),
      100
    );
    const result = await getRedditHotStocks(limit);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/reddit-hot
 * 手动触发一次 Reddit 热榜抓取并存储。
 */
export async function POST() {
  try {
    const result = await fetchRedditHotStocks();
    if (!result) {
      return NextResponse.json({ error: "抓取 Reddit 热榜失败" }, { status: 502 });
    }
    const count = await storeRedditHotStocks(result);
    return NextResponse.json({ success: true, date: result.date, count });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
