/**
 * Reddit 热榜定时任务执行器（ApeWisdom all-stocks Top 100）。
 *
 * 设计为可独立运行（自带 CronRun 记录），
 * 目前由 /api/cron/signals 路由在每日信号扫描后顺带调用（best-effort）。
 */

import { getPrisma } from "@/lib/db/prisma";
import { startCronRun, finishCronRun } from "@/lib/db/cron-run";
import { fetchRedditHotStocks, storeRedditHotStocks, enrichRedditHotStocks } from "@/lib/reddit-hot";

const JOB_NAME = "reddit-hot-stocks";

export interface RunRedditHotResult {
  runId: string;
  success: boolean;
  count: number;
  error?: string;
}

/**
 * 执行一轮 Reddit 热榜抓取 + 存储。
 * @param providedRunId 可选：外部已创建的 runId（嵌套场景）；不传则自动 startCronRun
 */
export async function runRedditHotJob(
  providedRunId?: string
): Promise<RunRedditHotResult> {
  const prisma = getPrisma();
  if (!prisma) {
    return { runId: "", success: false, count: 0, error: "Database not available" };
  }

  const runId = providedRunId ?? (await startCronRun({ jobName: JOB_NAME }));

  try {
    const result = await fetchRedditHotStocks();
    if (!result) {
      await finishCronRun(runId, {
        status: "error",
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 1,
        errorMessage: "抓取 Reddit 热榜失败（ApeWisdom 接口异常或超时）",
      });
      return { runId, success: false, count: 0, error: "fetch failed" };
    }

    // 调度触发时一并补充技术信号 + 当前价格/涨跌（Top 100，与前端展示量一致）
    try {
      result.items = await enrichRedditHotStocks(result.items, 100);
    } catch (e) {
      console.warn(`[reddit-hot-runner] enrich 失败(已忽略，仅存基础热榜):`, e);
    }

    const count = await storeRedditHotStocks(result);
    await finishCronRun(runId, {
      status: "success",
      total: result.count,
      processed: count,
      skipped: 0,
      errorCount: 0,
    });
    return { runId, success: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reddit-hot-runner] job ${JOB_NAME} 执行失败:`, err);
    await finishCronRun(runId, {
      status: "error",
      total: 0,
      processed: 0,
      skipped: 0,
      errorCount: 1,
      errorMessage: msg,
    });
    return { runId, success: false, count: 0, error: msg };
  }
}
