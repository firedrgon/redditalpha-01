/**
 * 信号提醒执行器（共享逻辑）
 *
 * 给两条入口共用：
 *  - /api/cron/signals（Vercel cron，全平台所有用户的 starred）
 *  - /api/signals/run（用户手动触发，仅当前用户的 starred）
 *
 * 关键设计：
 *  - 非美股：写一条 neutral SignalAlert 作为"今日已检查"占位
 *  - 拉取失败：写一条 neutral SignalAlert 并附错误信息
 *  - 拉取成功：写 SignalAlert + TechnicalSignalSnapshot
 *
 * 任何情况都返回一条 ProcessResult，让调用方汇总到 CronRun。
 */

import { getPrisma } from "@/lib/db/prisma";
import { fetchTradingViewTechnicals, SIGNAL_LABELS } from "@/lib/technical";
import { detectMarket, type Market } from "@/lib/market";
import { upsertTechnicalSnapshot } from "@/lib/db/technical-snapshot";
import {
  startCronRun,
  finishCronRun,
  type CronRunErrorItem,
} from "@/lib/db/cron-run";
import type { Signal, TechnicalSignals } from "@/lib/technical";

type PrismaClient = NonNullable<Awaited<ReturnType<typeof getPrisma>>>;

export type ProcessPhase = "non_us" | "fetch_empty" | "fetch_error" | "ok";

export interface ProcessResult {
  processed: boolean;
  skipped: boolean;
  error?: string;
  phase?: ProcessPhase;
  signal?: TechnicalSignals;
}

export interface StarredFavorite {
  userId: string;
  ticker: string;
  name: string | null;
}

function determineSignalType(overall: Signal): "buy" | "sell" | "neutral" {
  if (overall === "strong_buy" || overall === "buy") return "buy";
  if (overall === "strong_sell" || overall === "sell") return "sell";
  return "neutral";
}

function buildNote(signals: TechnicalSignals): string {
  return [
    `综合信号: ${SIGNAL_LABELS[signals.overall]}`,
    `振荡指标: ${SIGNAL_LABELS[signals.oscillators]}`,
    `移动均线: ${SIGNAL_LABELS[signals.movingAverages]}`,
  ].join("; ");
}

/**
 * 处理单个 starred 收藏
 */
export async function processStarredStock(
  prisma: PrismaClient,
  userId: string,
  ticker: string,
  name: string | null
): Promise<ProcessResult> {
  const market: Market = detectMarket(ticker);

  // 1) 非美股：写一条 neutral SignalAlert 作为"今日已检查"占位
  if (market !== "US") {
    try {
      await prisma.signalAlert.create({
        data: {
          userId,
          ticker,
          tickerName: name || undefined,
          signalType: "neutral",
          overallSignal: "neutral",
          oscillators: "neutral",
          movingAverages: "neutral",
          price: undefined,
          note: `非美股（${market}）不支持 TradingView 周线技术信号；今日已检查`,
        },
      });
      console.log(`[signals-runner] 非美股已记录占位: ${ticker} (${market})`);
      return { processed: false, skipped: true, phase: "non_us" };
    } catch (err) {
      console.error(`[signals-runner] 写非美股占位失败: ${ticker}`, err);
      return {
        processed: false,
        skipped: true,
        error: `非美股占位写入失败: ${err instanceof Error ? err.message : String(err)}`,
        phase: "non_us",
      };
    }
  }

  // 2) 美股：拉取 TV 信号
  let signals: TechnicalSignals | null = null;
  let fetchError: string | null = null;
  try {
    signals = await fetchTradingViewTechnicals(ticker);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  if (!signals) {
    // 拉取失败或空：写一条带 error 的 neutral 记录，让用户能看到
    const reason = fetchError ?? "未获取到技术信号（TradingView 返回空）";
    try {
      await prisma.signalAlert.create({
        data: {
          userId,
          ticker,
          tickerName: name || undefined,
          signalType: "neutral",
          overallSignal: "neutral",
          oscillators: "neutral",
          movingAverages: "neutral",
          price: undefined,
          note: `TradingView 拉取失败，今日已检查: ${reason}`,
        },
      });
    } catch (err) {
      console.error(`[signals-runner] 写失败记录也失败: ${ticker}`, err);
    }
    console.log(`[signals-runner] 拉取失败已记录: ${ticker} -> ${reason}`);
    return {
      processed: false,
      skipped: true,
      error: reason,
      phase: fetchError ? "fetch_error" : "fetch_empty",
    };
  }

  // 3) 拉取成功：写 SignalAlert + TechnicalSignalSnapshot
  const signalType = determineSignalType(signals.overall);
  const note = buildNote(signals);
  try {
    await prisma.signalAlert.create({
      data: {
        userId,
        ticker,
        tickerName: name || undefined,
        signalType,
        overallSignal: signals.overall,
        oscillators: signals.oscillators,
        movingAverages: signals.movingAverages,
        price: signals.overall === "neutral" ? null : undefined,
        note,
      },
    });

    await upsertTechnicalSnapshot({
      ticker,
      tickerName: name,
      oscillators: signals.oscillators,
      movingAverages: signals.movingAverages,
      overall: signals.overall,
      price: null,
    });

    console.log(
      `[signals-runner] 创建信号提醒 + snapshot: ${ticker} -> ${signalType} (${signals.overall})`
    );
    return { processed: true, skipped: false, signal: signals, phase: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[signals-runner] 写库失败: ${ticker}`, err);
    return { processed: false, skipped: true, error: msg, phase: "fetch_error" };
  }
}

export interface RunSignalsOptions {
  jobName: string;
  favorites: StarredFavorite[];
  /** 可选：预创建的 runId（用于嵌套场景；不传则自动 startCronRun） */
  runId?: string;
}

export interface RunSignalsResult {
  runId: string;
  total: number;
  processed: number;
  skipped: number;
  errorCount: number;
  errors: CronRunErrorItem[];
  results: ProcessResult[];
}

/**
 * 执行一整轮信号提醒：处理每个 starred，写 CronRun 记录。
 *
 * 注意：本函数**假定**传入的 favorites 数组已经过滤好（cron 传全部 starred，
 * 手动传单用户 starred）。函数本身不做范围过滤。
 */
export async function runSignalsJob({
  jobName,
  favorites,
  runId: providedRunId,
}: RunSignalsOptions): Promise<RunSignalsResult> {
  const prisma = getPrisma();
  if (!prisma) {
    throw new Error("Database not available");
  }

  const runId = providedRunId ?? (await startCronRun({ jobName }));

  try {
    if (favorites.length === 0) {
      await finishCronRun(runId, {
        status: "success",
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 0,
      });
      return {
        runId,
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 0,
        errors: [],
        results: [],
      };
    }

    const results = await Promise.all(
      favorites.map((fav) =>
        processStarredStock(prisma, fav.userId, fav.ticker, fav.name)
      )
    );

    const processed = results.filter((r) => r.processed).length;
    const errorItems: CronRunErrorItem[] = results
      .filter((r) => !r.processed && r.error)
      .map((r, i) => ({
        ticker: favorites[i].ticker,
        error: r.error!,
        phase: r.phase,
      }));
    const errorCount = errorItems.length;
    const skipped = Math.max(0, favorites.length - processed - errorCount);

    const status = errorCount > 0 && processed === 0 ? "error" : "success";
    await finishCronRun(runId, {
      status,
      total: favorites.length,
      processed,
      skipped,
      errorCount,
      errors: errorItems,
    });

    return {
      runId,
      total: favorites.length,
      processed,
      skipped,
      errorCount,
      errors: errorItems,
      results,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[signals-runner] job ${jobName} 执行失败:`, err);
    await finishCronRun(runId, {
      status: "error",
      total: 0,
      processed: 0,
      skipped: 0,
      errorCount: 1,
      errorMessage: msg,
    });
    throw err;
  }
}
