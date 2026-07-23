import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { startCronRun, finishCronRun } from "@/lib/db/cron-run";
import { runSignalsJob } from "@/lib/cron/signals-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_NAME = "signals";

// GET / POST 共用：Vercel Cron 默认用 GET 调 cron 路径，但也兼容 POST（手动/外部）
// 统一入口，避免「只导出 POST 导致 Vercel GET 请求 405」的坑。
async function handleCron(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  // Vercel 调度器每次调用都会带 x-vercel-cron-schedule；用它判断「是不是 Vercel 真在调」
  const cronSchedule = request.headers.get("x-vercel-cron-schedule");
  const cronSource = request.headers.get("x-vercel-cron-source");
  const method = request.method;
  const isVercelCron = Boolean(cronSchedule || cronSource);

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    // 诊断：401 也写一条 CronRun，方便排查。默认开启；
    // 部署后在 Vercel 设 CRON_LOG_AUTH_FAILURES=false 可关闭（减少外部扫描产生的噪音）。
    const reason = isVercelCron
      ? "Vercel 调度器调用但未携带正确的 Authorization 头（CRON_SECRET 未生效或环境未同步，请在 Vercel 后台确认 Production 环境已设置 CRON_SECRET）"
      : "收到未携带 Authorization 头的请求（外部调用 / 手动测试 / 扫描器），已拒绝——这不是定时任务逻辑错误";
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
            errorMessage: `【信号扫描 signals】认证失败：${reason}。env_CRON_SECRET_present=${Boolean(
              cronSecret
            )}, env_CRON_SECRET_len=${cronSecret?.length ?? 0}, header_present=${Boolean(
              authHeader
            )}, header_len=${authHeader?.length ?? 0}, isVercelCron=${isVercelCron}, method=${method}, cronSchedule=${cronSchedule ?? "无"}, cronSource=${cronSource ?? "无"}`,
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

/** GET /api/cron/signals：Vercel Cron 调度入口 */
export async function GET(request: NextRequest) {
  return handleCron(request);
}

/** POST /api/cron/signals：兼容手动/外部调用 */
export async function POST(request: NextRequest) {
  return handleCron(request);
}
