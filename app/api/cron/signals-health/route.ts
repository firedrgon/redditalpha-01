import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import {
  startCronRun,
  finishCronRun,
} from "@/lib/db/cron-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 轻量 cron 健康检查端点：仅写入 CronRun 记录，不触碰 SignalAlert。
 * 用于临时排查 Vercel cron 是否真正在调度（解决"secret 看起来对但 cron 没跑"问题）。
 * 验证完毕后从 vercel.json 中移除此任务。
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  const runId = await startCronRun({ jobName: "signals-health" });
  await finishCronRun(runId, {
    status: "success",
    total: 0,
    processed: 0,
    skipped: 0,
    errorCount: 0,
  });

  return NextResponse.json({
    success: true,
    jobName: "signals-health",
    runId,
    ts: new Date().toISOString(),
  });
}
