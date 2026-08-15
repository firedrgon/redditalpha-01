import { NextResponse } from "next/server";
import { getEtfTrendData, fetchEtfTrendData, storeEtfTrendData } from "@/lib/etf-trend";
import { warmEtfEvaluationCache } from "@/lib/etf-evaluate-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 刷新后需预热估值评估缓存（并发抓东方财富），可能较慢，放宽到 60s */
export const maxDuration = 60;

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
    // 刷新完主升浪池后，立即预热估值+质量评估缓存，使评级在刷新后即时可用
    // （best-effort：异常不影响主流程；限流时缓存短 TTL 尽快重试）
    await warmEtfEvaluationCache().catch(() => {});
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
