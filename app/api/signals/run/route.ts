import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth-guards";
import { runSignalsJob } from "@/lib/cron/signals-runner";
import { startCronRun, finishCronRun } from "@/lib/db/cron-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动触发的冷却时间（毫秒）。60 秒防 spam */
const COOLDOWN_MS = 60_000;

export async function POST(request: NextRequest) {
  void request; // 当前未使用 request body，预留扩展
  const { user, response } = await requireUser();
  if (response || !user) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  }

  const jobName = `signals:manual:${user.id}`;

  // Cooldown 检查：用 CronRun 找该 jobName 最近的 endedAt
  const lastRun = await prisma.cronRun.findFirst({
    where: { jobName, status: { not: "running" } },
    orderBy: { endedAt: "desc" },
    select: { endedAt: true },
  });

  if (lastRun?.endedAt) {
    const elapsed = Date.now() - lastRun.endedAt.getTime();
    if (elapsed < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return NextResponse.json(
        {
          error: `操作太频繁，请 ${waitSec} 秒后再试`,
          retryAfterSec: waitSec,
        },
        { status: 429 }
      );
    }
  }

  // 找当前用户 starred
  const starredFavorites = await prisma.favorite.findMany({
    where: { userId: user.id, starred: true },
    select: { userId: true, ticker: true, name: true },
  });

  const validFavorites = starredFavorites.filter(
    (f): f is { userId: string; ticker: string; name: string | null } =>
      f.userId !== null
  );

  if (validFavorites.length === 0) {
    return NextResponse.json({
      success: true,
      message: "你还没有重点关注的股票",
      total: 0,
      processed: 0,
      skipped: 0,
      errorCount: 0,
      results: [],
    });
  }

  const runId = await startCronRun({ jobName });

  try {
    const result = await runSignalsJob({
      jobName,
      favorites: validFavorites,
      runId,
    });

    return NextResponse.json({
      success: true,
      runId: result.runId,
      total: result.total,
      processed: result.processed,
      skipped: result.skipped,
      errorCount: result.errorCount,
      errors: result.errors,
      results: result.results.map((r) => ({
        processed: r.processed,
        skipped: r.skipped,
        phase: r.phase,
        error: r.error,
        overall: r.signal?.overall,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[signals/run] 手动执行失败:", err);
    // 异常情况也确保 CronRun 收尾（runSignalsJob 内部会写一次，但兜底再写一次）
    try {
      await finishCronRun(runId, {
        status: "error",
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 1,
        errorMessage: msg,
      });
    } catch {
      /* ignore */
    }
    return NextResponse.json({ error: msg, runId }, { status: 500 });
  }
}
