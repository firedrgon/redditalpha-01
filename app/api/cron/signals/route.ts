import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { startCronRun, finishCronRun } from "@/lib/db/cron-run";
import { runSignalsJob } from "@/lib/cron/signals-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_NAME = "signals";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // 诊断：401 也写一条 CronRun，方便排查 CRON_SECRET 不匹配问题
    // 默认开启；诊断完毕后可在 Vercel 设 CRON_LOG_AUTH_FAILURES=false 关闭
    if (process.env.CRON_LOG_AUTH_FAILURES !== "false") {
      const prisma = getPrisma();
      if (prisma) {
        try {
          const runId = await startCronRun({ jobName: `${JOB_NAME}:auth-fail` });
          await finishCronRun(runId, {
            status: "error",
            total: 0,
            processed: 0,
            skipped: 0,
            errorCount: 1,
            errorMessage: `Unauthorized: header_present=${Boolean(
              authHeader
            )}, env_CRON_SECRET_present=${Boolean(
              process.env.CRON_SECRET
            )}, env_CRON_SECRET_len=${
              process.env.CRON_SECRET?.length ?? 0
            }, header_len=${authHeader?.length ?? 0}`,
          });
        } catch (e) {
          console.error("[cron/signals] 写 auth-fail 记录失败:", e);
        }
      }
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  try {
    // 所有收藏的股票都更新技术信号（不再限定 starred=true）
    const allFavorites = await prisma.favorite.findMany({
      select: { userId: true, ticker: true, name: true },
    });

    const validFavorites = allFavorites.filter(
      (f): f is { userId: string; ticker: string; name: string | null } =>
        f.userId !== null
    );

    const result = await runSignalsJob({
      jobName: JOB_NAME,
      favorites: validFavorites,
    });

    return NextResponse.json({
      success: true,
      runId: result.runId,
      total: result.total,
      processed: result.processed,
      skipped: result.skipped,
      errorCount: result.errorCount,
      errors: result.errors,
      message: result.total === 0 ? "没有收藏的股票" : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/signals] 顶层异常:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
