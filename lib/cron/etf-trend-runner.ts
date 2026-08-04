/**
 * ETF 主升浪池定时任务执行器
 *
 * 设计为可独立运行（自带 CronRun 记录，方便在 /admin 单独监控），
 * 由 /api/cron/signals 路由在盘前信号扫描后顺带调用（best-effort）。
 *
 * 每天盘前抓取一次：按北京时间日期 upsert，同一交易日多次触发只刷新当日快照。
 */

import { getPrisma } from "@/lib/db/prisma";
import { startCronRun, finishCronRun } from "@/lib/db/cron-run";
import { fetchEtfTrendData, storeEtfTrendData } from "@/lib/etf-trend";

const JOB_NAME = "etf-trend";

export interface RunEtfTrendResult {
  runId: string;
  success: boolean;
  count: number;
  total: number;
  error?: string;
}

/**
 * 执行一轮 ETF 主升浪池抓取 + 存储。
 * @param providedRunId 可选：外部已创建的 runId（嵌套场景）；不传则自动 startCronRun
 */
export async function runEtfTrendJob(
  providedRunId?: string
): Promise<RunEtfTrendResult> {
  const prisma = getPrisma();
  if (!prisma) {
    return {
      runId: "",
      success: false,
      count: 0,
      total: 0,
      error: "Database not available",
    };
  }

  const runId = providedRunId ?? (await startCronRun({ jobName: JOB_NAME }));

  try {
    const result = await fetchEtfTrendData();
    if (!result) {
      await finishCronRun(runId, {
        status: "error",
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 1,
        errorMessage: "抓取同花顺 ETF 主升浪池失败（接口异常或超时）",
      });
      return { runId, success: false, count: 0, total: 0, error: "fetch failed" };
    }

    const count = await storeEtfTrendData(result);
    await finishCronRun(runId, {
      status: "success",
      total: result.total,
      processed: count,
      skipped: 0,
      errorCount: 0,
    });
    console.log(
      `[etf-trend-runner] 成功: ${count} 条入库, 池总数 ${result.total} (${result.date}, ${result.elapsedMs}ms)`
    );
    return { runId, success: true, count, total: result.total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[etf-trend-runner] job ${JOB_NAME} 执行失败:`, err);
    await finishCronRun(runId, {
      status: "error",
      total: 0,
      processed: 0,
      skipped: 0,
      errorCount: 1,
      errorMessage: msg,
    });
    return { runId, success: false, count: 0, total: 0, error: msg };
  }
}
