import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { fetchHotStocks, storeHotStocks, beijingDate } from "@/lib/hot-stocks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/hot-stocks?limit=50
 * 读取当日（北京时间）热榜；若当日暂无数据，回退到最近一次快照。
 * 公开接口（热榜是公开行情数据，无需登录）。
 */
export async function GET(request: NextRequest) {
  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  const limit = Math.min(
    Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 50), 1),
    100
  );

  try {
    const today = beijingDate();
    let date = today;
    let rows = await prisma.hotStock.findMany({
      where: { date: today },
      orderBy: { rank: "asc" },
      take: limit,
    });

    // 当日暂无数据 → 回退到最近一次快照
    if (rows.length === 0) {
      const latest = await prisma.hotStock.findFirst({ orderBy: { date: "desc" } });
      if (latest) {
        date = latest.date;
        rows = await prisma.hotStock.findMany({
          where: { date },
          orderBy: { rank: "asc" },
          take: limit,
        });
      }
    }

    return NextResponse.json({ date, count: rows.length, stocks: rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/hot-stocks
 * 手动触发一次同花顺热榜抓取并存储（公开，便于前端"刷新"按钮即时更新）。
 */
export async function POST(request: NextRequest) {
  try {
    const result = await fetchHotStocks();
    if (!result) {
      return NextResponse.json({ error: "抓取同花顺热榜失败" }, { status: 502 });
    }
    const count = await storeHotStocks(result);
    return NextResponse.json({ success: true, date: result.date, count });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
