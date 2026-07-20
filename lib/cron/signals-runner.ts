/**
 * 信号提醒执行器（共享逻辑）
 *
 * 给两条入口共用：
 *  - /api/cron/signals（Vercel cron，全平台所有用户的 starred）
 *  - /api/signals/run（用户手动触发，仅当前用户的 starred）
 *
 * 核心设计：状态机 + 决策表
 *
 * 状态（state）：
 *   - OUT  空仓 / 观望
 *   - HOLD 持仓中
 *
 * 信号（3 档）：
 *   - BUY      = strong_buy | buy
 *   - SELL     = strong_sell | sell
 *   - NEUTRAL  = neutral
 *
 * 状态推断：查该 ticker 最近一条 signalType ∈ {buy, sell} 的 alert；
 *          没有则默认 OUT。
 *
 * 决策表（state × today）：
 *   state  today     写 alert?  动作
 *   ───────────────────────────────────
 *   OUT    BUY       ✓ buy     建仓   → HOLD
 *   OUT    SELL      ✗         空仓不卖（不卖空）
 *   OUT    NEUTRAL   ✗         保持观望
 *   HOLD   BUY       ✗         继续持有
 *   HOLD   SELL      ✓ sell    平仓   → OUT
 *   HOLD   NEUTRAL   ✗         继续持有
 *
 * 边界：
 *   - 非美股 / TV 拉取失败：写一条 neutral alert 但**不动 state**（用户能看到"今日已检查"）
 *   - HOLD+BUY、OUT+SELL、任意+NEUTRAL 都不写 alert（避免噪音）
 *   - snapshot（高频读缓存）只在拉到真实信号时写
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

export type PositionState = "OUT" | "HOLD";
export type SignalClass = "BUY" | "SELL" | "NEUTRAL";

/** 决策表的结果：进入 / 退出 / 持仓不动 / 观望不动 / 非美股 / 拉取失败 */
export type ProcessPhase =
  | "enter"
  | "exit"
  | "hold"
  | "stay_out"
  | "non_us"
  | "fetch_empty"
  | "fetch_error";

export interface ProcessResult {
  processed: boolean;
  skipped: boolean;
  error?: string;
  phase: ProcessPhase;
  /** 触发 enter/exit 时的信号强度 */
  signal?: TechnicalSignals;
  /** 当前推断的状态（仅 OK / enter / exit / hold / stay_out 时有） */
  state?: PositionState;
  /** 今天收到的信号分类（仅 OK 时有） */
  today?: SignalClass;
}

/** 3 档信号分类 */
function classifySignal(s: Signal): SignalClass {
  if (s === "strong_buy" || s === "buy") return "BUY";
  if (s === "strong_sell" || s === "sell") return "SELL";
  return "NEUTRAL";
}

export interface StarredFavorite {
  userId: string;
  ticker: string;
  name: string | null;
}

/**
 * 推断当前持仓状态
 *
 * 规则：取该 (userId, ticker) 最近一条 signalType ∈ {buy, sell} 的 alert；
 *       buy → HOLD，sell → OUT；都没有则默认 OUT。
 */
export async function getCurrentState(
  prisma: PrismaClient,
  userId: string,
  ticker: string
): Promise<PositionState> {
  const last = await prisma.signalAlert.findFirst({
    where: {
      userId,
      ticker,
      signalType: { in: ["buy", "sell"] },
    },
    orderBy: { createdAt: "desc" },
    select: { signalType: true },
  });
  if (!last) return "OUT";
  return last.signalType === "buy" ? "HOLD" : "OUT";
}

/**
 * 决策表：state × today → phase
 */
function decide(state: PositionState, today: SignalClass): ProcessPhase {
  if (state === "OUT" && today === "BUY") return "enter";
  if (state === "HOLD" && today === "SELL") return "exit";
  if (state === "HOLD") return "hold"; // HOLD + BUY/NEUTRAL
  return "stay_out"; // OUT + SELL/NEUTRAL
}

function buildAlertNote(signals: TechnicalSignals): string {
  return [
    `综合信号: ${SIGNAL_LABELS[signals.overall]}`,
    `振荡指标: ${SIGNAL_LABELS[signals.oscillators]}`,
    `移动均线: ${SIGNAL_LABELS[signals.movingAverages]}`,
  ].join("; ");
}

/** 写一条 neutral 占位 alert（非美股 / 拉取失败）。不动 state。 */
async function writeNeutralAlert(
  prisma: PrismaClient,
  userId: string,
  ticker: string,
  name: string | null,
  reason: string
): Promise<void> {
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
      note: reason,
    },
  });
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

  // 1) 非美股：写 neutral 占位，不动 state
  if (market !== "US") {
    try {
      await writeNeutralAlert(
        prisma,
        userId,
        ticker,
        name,
        `非美股（${market}）不支持 TradingView 周线技术信号；今日已检查`
      );
      console.log(`[signals-runner] 非美股已记录占位: ${ticker} (${market})`);
    } catch (err) {
      console.error(`[signals-runner] 写非美股占位失败: ${ticker}`, err);
    }
    return { processed: false, skipped: true, phase: "non_us" };
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
    // 拉取失败：写 neutral 占位，不动 state，不写 snapshot
    const reason = fetchError ?? "未获取到技术信号（TradingView 返回空）";
    try {
      await writeNeutralAlert(
        prisma,
        userId,
        ticker,
        name,
        `TradingView 拉取失败，今日已检查: ${reason}`
      );
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

  // 3) 应用状态机决策表
  const today = classifySignal(signals.overall);
  const state = await getCurrentState(prisma, userId, ticker);
  const phase = decide(state, today);

  console.log(
    `[signals-runner] ${ticker} state=${state} today=${today} → ${phase}`
  );

  // 4) 写 snapshot（高频读缓存，与 alert 独立；只要拉到信号就更新）
  await upsertTechnicalSnapshot({
    ticker,
    tickerName: name,
    oscillators: signals.oscillators,
    movingAverages: signals.movingAverages,
    overall: signals.overall,
    price: null,
  });

  // 5) 根据 phase 决定是否写 alert
  if (phase === "enter" || phase === "exit") {
    const signalType: "buy" | "sell" = phase === "enter" ? "buy" : "sell";
    const actionLabel = phase === "enter" ? "建仓" : "平仓";
    const note = `${actionLabel}信号（${state} → ${
      phase === "enter" ? "HOLD" : "OUT"
    }）; ${buildAlertNote(signals)}`;
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
      console.log(
        `[signals-runner] ${ticker} ${actionLabel} alert 写入, signal=${signals.overall}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[signals-runner] 写 ${actionLabel} alert 失败: ${ticker}`, err);
      return {
        processed: false,
        skipped: true,
        error: msg,
        phase: "fetch_error",
        state,
        today,
      };
    }
  }

  return {
    processed: phase === "enter" || phase === "exit",
    skipped: phase === "hold" || phase === "stay_out",
    phase,
    signal: signals,
    state,
    today,
  };
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
  /** 真正触发建仓/平仓的数量 */
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
      .filter((r) => r.phase === "fetch_error" || r.phase === "fetch_empty")
      .map((r, i) => ({
        ticker: favorites[i].ticker,
        error: r.error ?? r.phase,
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
