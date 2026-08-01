import { NextRequest, NextResponse } from "next/server";
import { listAllCronRuns } from "@/lib/db/cron-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/cron-runs?limit=50
 * 列出所有定时任务的最近执行历史（公开，无需登录）。
 */
export async function GET(request: NextRequest) {
  const limitParam = Number(request.nextUrl.searchParams.get("limit")) || 50;
  const limit = Math.min(Math.max(limitParam, 1), 200);

  try {
    const runs = await listAllCronRuns(limit);
    return NextResponse.json({ runs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
