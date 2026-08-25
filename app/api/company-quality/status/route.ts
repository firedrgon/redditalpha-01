import { NextRequest, NextResponse } from "next/server";
import { getQualityStatus } from "@/lib/db/company-quality-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 批量查询哪些 A股已打过质地分（供收藏 / 热榜列表徽章）。
 * ?tickers=002739,600519,300750 → { status: { "002739": {scored:true,totalScore,level}, ... } }
 * 未配 DB 时全部 scored:false，列表降级为「去打分」。
 */
export async function GET(req: NextRequest) {
  const tickers = (req.nextUrl.searchParams.get("tickers") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const status = await getQualityStatus(tickers);
  return NextResponse.json({ status }, { headers: { "Cache-Control": "no-store" } });
}
