import { NextResponse } from "next/server";
import { getEtfTrendData, fetchEtfTrendData, storeEtfTrendData } from "@/lib/etf-trend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/etf-trend
 * 读取当日（北京时间）ETF 主升浪池（已同类去重）；当日暂无数据时回退到最近一次快照。
 * 公开接口（行情数据，无需登录）。
 */
export async function GET() {
  try {
    const result = await getEtfTrendData();
    if (!result) {
      return NextResponse.json(
        { error: "暂无 ETF 主升浪数据，请等待盘前定时任务抓取或手动刷新" },
        { status: 404 }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/etf-trend
 * 手动触发一次同花顺 ETF 主升浪池抓取并存储（公开，便于前端"刷新"按钮即时更新）。
 * 与每日盘前 cron 行为一致：抓取后按日期 upsert 落库。
 */
export async function POST() {
  try {
    const result = await fetchEtfTrendData();
    if (!result) {
      return NextResponse.json({ error: "抓取同花顺 ETF 主升浪池失败" }, { status: 502 });
    }
    const count = await storeEtfTrendData(result);
    return NextResponse.json({
      success: true,
      date: result.date,
      count,
      total: result.total,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
