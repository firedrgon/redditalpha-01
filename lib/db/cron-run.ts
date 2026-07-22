/**
 * CronRun 数据访问层
 *
 * 记录每次定时任务执行的开始时间、结束时间、统计结果。
 * 目的：解决"cron 跑没跑、跑了多少、失败几个"只能从 SignalAlert 数量反推的问题。
 *
 * 写入路径：
 *   - 由 /api/cron/* 路由在执行前后分别调用 startCronRun / finishCronRun
 *   - 失败/跳过也写一条记录，避免静默吞错
 */

import { getPrisma } from "./prisma";

export type CronRunStatus = "running" | "success" | "error";

export interface CronRunRow {
  id: string;
  jobName: string;
  startedAt: number;
  endedAt: number | null;
  status: CronRunStatus;
  total: number;
  processed: number;
  skipped: number;
  errorCount: number;
  errors: CronRunErrorItem[] | null;
  errorMessage: string | null;
}

export interface CronRunErrorItem {
  ticker: string;
  error: string;
  /** "fetch" | "non_us" | "db" 等阶段标记 */
  phase?: string;
}

export interface StartCronRunInput {
  jobName: string;
}

export interface FinishCronRunInput {
  status: CronRunStatus;
  total: number;
  processed: number;
  skipped: number;
  errorCount: number;
  errors?: CronRunErrorItem[];
  errorMessage?: string;
}

function toRow(r: {
  id: string;
  jobName: string;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
  total: number;
  processed: number;
  skipped: number;
  errorCount: number;
  errors: string | null;
  errorMessage: string | null;
}): CronRunRow {
  let parsedErrors: CronRunErrorItem[] | null = null;
  if (r.errors) {
    try {
      const arr = JSON.parse(r.errors);
      if (Array.isArray(arr)) parsedErrors = arr as CronRunErrorItem[];
    } catch {
      parsedErrors = null;
    }
  }
  return {
    id: r.id,
    jobName: r.jobName,
    startedAt: r.startedAt.getTime(),
    endedAt: r.endedAt ? r.endedAt.getTime() : null,
    status: r.status as CronRunStatus,
    total: r.total,
    processed: r.processed,
    skipped: r.skipped,
    errorCount: r.errorCount,
    errors: parsedErrors,
    errorMessage: r.errorMessage,
  };
}

/**
 * 标记一次 cron 任务开始执行。
 * 必须在执行前调用。返回 runId，finishCronRun 时回填。
 *
 * 兜底：DB 不可用时返回内存中的 runId（"mem-" 开头），
 * 仍允许上层调用 finishCronRun 不报错（仅打日志）。
 */
export async function startCronRun(input: StartCronRunInput): Promise<string> {
  const prisma = getPrisma();
  if (!prisma) {
    console.warn(
      `[cron-run] Prisma 不可用，跳过 startCronRun 持久化：${input.jobName}`
    );
    return `mem-${Date.now()}`;
  }

  const row = await prisma.cronRun.create({
    data: {
      jobName: input.jobName,
      status: "running",
    },
  });
  return row.id;
}

/**
 * 标记一次 cron 任务执行结束，写入统计与状态。
 * 必须在执行后调用。errors 数组会自动 JSON.stringify。
 */
export async function finishCronRun(
  runId: string,
  input: FinishCronRunInput
): Promise<void> {
  // 内存模式：仅日志
  if (runId.startsWith("mem-")) {
    console.log(
      `[cron-run] (mem) finish ${runId}: status=${input.status} total=${input.total} processed=${input.processed} errors=${input.errorCount}`
    );
    return;
  }

  const prisma = getPrisma();
  if (!prisma) {
    console.warn(`[cron-run] Prisma 不可用，跳过 finishCronRun 持久化：${runId}`);
    return;
  }

  await prisma.cronRun.update({
    where: { id: runId },
    data: {
      status: input.status,
      endedAt: new Date(),
      total: input.total,
      processed: input.processed,
      skipped: input.skipped,
      errorCount: input.errorCount,
      errors: input.errors && input.errors.length > 0 ? JSON.stringify(input.errors) : null,
      errorMessage: input.errorMessage ?? null,
    },
  });
}

/**
 * 列出某个 job 的最近 N 条执行历史（倒序：最近的在最前）。
 * 用于 /admin 或排查页。
 */
export async function listCronRuns(
  jobName: string,
  limit = 20
): Promise<CronRunRow[]> {
  const prisma = getPrisma();
  if (!prisma) return [];
  const rows = await prisma.cronRun.findMany({
    where: { jobName },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return rows.map(toRow);
}

/** 取最近一条运行记录（不论成功失败） */
export async function getLatestCronRun(
  jobName: string
): Promise<CronRunRow | null> {
  const prisma = getPrisma();
  if (!prisma) return null;
  const row = await prisma.cronRun.findFirst({
    where: { jobName },
    orderBy: { startedAt: "desc" },
  });
  return row ? toRow(row) : null;
}

/**
 * 列出所有 job 的最近 N 条执行历史（倒序）。
 * 用于 /admin 监控页（不按 jobName 过滤）。
 */
export async function listAllCronRuns(limit = 50): Promise<CronRunRow[]> {
  const prisma = getPrisma();
  if (!prisma) return [];
  const rows = await prisma.cronRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return rows.map(toRow);
}
