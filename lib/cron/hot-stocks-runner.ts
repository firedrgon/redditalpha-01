/**
 * 同花顺热榜定时任务执行器
 *
 * 设计为可独立运行（自带 CronRun 记录，方便在 /admin 单独监控），
 * 目前由 /api/cron/signals 路由在每日信号扫描后顺带调用（best-effort）。
 */

import { getPrisma } from "@/lib/db/prisma";
import { startCronRun, finishCronRun } from "@/lib/db/cron-run";
import { fetchHotStocks, storeHotStocks, enrichHotStocks } from "@/lib/hot-stocks";

const JOB_NAME = "hot-stocks";

export interface RunHotStocksResult {
  runId: string;
  success: boolean;
  count: number;
  error?: string;
}

/**
 * 执行一轮热榜抓取 + 存储。
 * @param providedRunId 可选：外部已创建的 runId（嵌套场景）；不传则自动 startCronRun
 */
export async function runHotStocksJob(
  providedRunId?: string
): Promise<RunHotStocksResult> {
  const prisma = getPrisma();
  if (!prisma) {
    return { runId: "", success: false, count: 0, error: "Database not available" };
  }

  const runId = providedRunId ?? (await startCronRun({ jobName: JOB_NAME }));

  try {
    const result = await fetchHotStocks();
    if (!result) {
      await finishCronRun(runId, {
        status: "error",
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 1,
        errorMessage: "抓取同花顺热榜失败（接口异常或超时）",
      });
      return { runId, success: false, count: 0, error: "fetch failed" };
    }

    // 调度触发时一并补充技术信号 + 筹码（Top 50，与前端展示量一致）
    try {
      result.items = await enrichHotStocks(result.items, 50);
    } catch (e) {
      console.warn(`[hot-stocks-runner] enrich 失败(已忽略，仅存基础热榜):`, e);
    }

    const count = await storeHotStocks(result);
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
    console.error(`[hot-stocks-runner] job ${JOB_NAME} 执行失败:`, err);
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
