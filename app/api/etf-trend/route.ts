import { NextResponse } from "next/server";
import { fetchEtfTrendData } from "@/lib/etf-trend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/etf-trend
 * 实时抓取同花顺 ETF 主升浪池并按标签分类（趋势回踩 / 新入池）。
 * 公开接口（行情数据，无需登录）。
 */
export async function GET() {
  try {
    const result = await fetchEtfTrendData();
    if (!result) {
      return NextResponse.json(
        { error: "抓取同花顺 ETF 主升浪池失败" },
        { status: 502 }
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
