/**
 * 信号提醒执行器（共享逻辑）
 *
 * 给两条入口共用：
 *  - /api/cron/signals（Vercel cron，全平台所有用户的收藏）
 *  - /api/signals/run（用户手动触发，仅当前用户的收藏）
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
 *   - 非美股 / 非 A 股（港股/加密/ETF 等）：不支持信号与筹码状态，
 *     只写中性 snapshot（upsert，不无限增长），**不写 alert**（减少噪音）
 *   - A 股：获取 TradingView 中国区技术信号 + 同花顺筹码状态，进入同一套状态机
 *     （与美股一致，仅在建仓/平仓时写 buy/sell alert）；筹码状态写入 snapshot 辅助展示。
 *     技术信号拉取失败（但筹码成功）：写中性 snapshot + 中性占位 alert。
 *   - TV 拉取失败：写一条 neutral alert 但**不动 state**（用户能看到"今日已检查"）
 *   - HOLD+BUY、OUT+SELL、任意+NEUTRAL 都不写 alert（避免噪音）
 *   - snapshot（高频读缓存）只在拉到真实信号或筹码状态时写
 */

import { getPrisma } from "@/lib/db/prisma";
import { fetchTradingViewTechnicals, fetchCNTradingViewTechnicals, fetchChipSituation, SIGNAL_LABELS } from "@/lib/technical";
import { detectMarket, type Market } from "@/lib/market";
import { upsertTechnicalSnapshot } from "@/lib/db/technical-snapshot";
import {
  openPosition,
  closePosition,
  fetchSignalPrice,
  getFavoriteUserIds,
  getCapitalForMarket,
  currencyOf,
  type AssetMarket,
} from "@/lib/db/positions";
import { ANON_USER_ID } from "@/lib/auth";
import {
  startCronRun,
  finishCronRun,
  type CronRunErrorItem,
} from "@/lib/db/cron-run";
import type { Signal, TechnicalSignals } from "@/lib/technical";

type PrismaClient = NonNullable<Awaited<ReturnType<typeof getPrisma>>>;

export type PositionState = "OUT" | "HOLD";
export type SignalClass = "BUY" | "SELL" | "NEUTRAL";

/** 决策表的结果：进入 / 退出 / 持仓不动 / 观望不动 / 非美股 / A股筹码 / 拉取失败 */
export type ProcessPhase =
  | "enter"
  | "exit"
  | "hold"
  | "stay_out"
  | "non_us"
  | "cn_chip"
  | "cn_chip_empty"
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
  ticker: string;
  name: string | null;
}

/**
 * 推断当前持仓状态
 *
 * 真实持仓优先于提醒历史：
 * 1. 若 position 表里仍有 OPEN 持仓，直接视为 HOLD
 * 2. 否则回退到最近一条 buy/sell alert 推断
 * 3. 两者都没有则默认 OUT
 *
 * 这样可以兜住历史数据不完整的情况，避免“实际仍持仓，但因缺少 buy alert
 * 被误判为 OUT，导致后续 SELL 信号被跳过”。
 */
export async function getCurrentState(
  prisma: PrismaClient,
  ticker: string
): Promise<PositionState> {
  const openPosition = await prisma.position.findFirst({
    where: { ticker, status: "OPEN" },
    select: { id: true },
  });
  if (openPosition) return "HOLD";

  const last = await prisma.signalAlert.findFirst({
    where: {
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
  ticker: string,
  name: string | null,
  reason: string
): Promise<void> {
  await prisma.signalAlert.create({
    data: {
      userId: ANON_USER_ID,
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
 * 写 buy/sell alert（同时创建站内通知 + 投递邮件/Web Push）。
 * 单一出口，美股与 A 股共用，保证通知逻辑一致。
 * 返回 ok=false 表示写入失败（调用方据此决定是否计入 error）。
 */
async function writeSignalAlertAndNotify(
  prisma: PrismaClient,
  args: {
    ticker: string;
    name: string | null;
    signalType: "buy" | "sell";
    overall: string;
    oscillators: string;
    movingAverages: string;
    chipDesc?: string | null;
    state: PositionState;
    phase: "enter" | "exit";
    /** 资产市场：CN | US（决定本金币种） */
    market: AssetMarket;
  }
): Promise<{ ok: boolean; error?: string }> {
  const { ticker, name, signalType, overall, oscillators, movingAverages, chipDesc, state, phase, market } = args;
  const actionLabel = phase === "enter" ? "建仓" : "平仓";
  const note =
    `${actionLabel}信号（${state} → ${phase === "enter" ? "HOLD" : "OUT"}）; ` +
    buildAlertNote({ overall, oscillators, movingAverages } as TechnicalSignals) +
    (chipDesc ? `; 筹码状态: ${chipDesc.slice(0, 60)}` : "");

  try {
    const alert = await prisma.signalAlert.create({
      data: {
        userId: ANON_USER_ID,
        ticker,
        tickerName: name || undefined,
        signalType,
        overallSignal: overall,
        oscillators,
        movingAverages,
        price: null,
        note,
      },
    });

    // 取信号时刻价格（失败则跳过持仓金额，仅记信号）
    const price = await fetchSignalPrice(ticker);

    // 模拟持仓：建仓开 OPEN，平仓关闭最新 OPEN 并算盈亏
    if (phase === "enter") {
      if (price != null) {
        const capital = await getCapitalForMarket(prisma, market);
        await openPosition(
          prisma,
          {
            ticker,
            tickerName: name,
            price,
            alertId: alert.id,
            assetType: market,
            currency: currencyOf(market),
            capital,
          },
          ANON_USER_ID
        );
        // 回填 alert 价格，便于核对
        await prisma.signalAlert.update({
          where: { id: alert.id },
          data: { price },
        });
      }
    } else if (phase === "exit") {
      await closePosition(
        prisma,
        {
          ticker,
          price,
          alertId: alert.id,
        },
        ANON_USER_ID
      );
      if (price != null) {
        await prisma.signalAlert.update({
          where: { id: alert.id },
          data: { price },
        });
      }
    }

    // Fan-out：给收藏该 ticker 的登录用户各生成一条站内通知 + 各自的模拟持仓。
    // 站内通知是用户私有的（Notification.userId）；模拟持仓也按用户隔离（Position.userId）。
    // 匿名全局收藏不生成通知（无用户主体），其公开资金池持仓已在上面以 userId=__anon__ 创建。
    try {
      const userIds = await getFavoriteUserIds(prisma, ticker);
      if (userIds.length > 0) {
        const titleText = `${phase === "enter" ? "买入" : "卖出"}信号 · ${ticker}`;
        const notifyUrl = `/signals?ticker=${encodeURIComponent(ticker)}`;
        for (const uid of userIds) {
          try {
            await prisma.notification.create({
              data: {
                userId: uid,
                type: "signal",
                title: titleText,
                body: note,
                url: notifyUrl,
                ticker,
                read: false,
              },
            });
            if (phase === "enter") {
              if (price != null) {
                const capital = await getCapitalForMarket(prisma, market);
                await openPosition(
                  prisma,
                  {
                    ticker,
                    tickerName: name,
                    price,
                    alertId: alert.id,
                    assetType: market,
                    currency: currencyOf(market),
                    capital,
                  },
                  uid
                );
              }
            } else {
              await closePosition(
                prisma,
                { ticker, price, alertId: alert.id },
                uid
              );
            }
          } catch (fanErr) {
            console.error(
              `[signals-runner] fan-out 单用户失败 user=${uid} ticker=${ticker}:`,
              fanErr
            );
          }
        }
      }
    } catch (fanErr) {
      console.error(`[signals-runner] fan-out 查询失败 ticker=${ticker}:`, fanErr);
    }

    console.log(`[signals-runner] ${ticker} ${actionLabel} alert 写入, signal=${overall}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[signals-runner] 写 ${actionLabel} alert/通知失败: ${ticker}`, err);
    return { ok: false, error: msg };
  }
}

/**
 * 处理单个收藏（美股技术信号 / A 股筹码状态）
 */
export async function processStarredStock(
  prisma: PrismaClient,
  ticker: string,
  name: string | null
): Promise<ProcessResult> {
  const market: Market = detectMarket(ticker);

  // 1) A 股：获取 TradingView 中国区技术信号 + 同花顺筹码状态，进入同一套状态机
  if (market === "CN") {
    let cntv: TechnicalSignals | null = null;
    let chipDesc: string | null = null;
    try {
      cntv = await fetchCNTradingViewTechnicals(ticker);
    } catch (err) {
      console.error(`[signals-runner] A 股 TradingView 信号获取失败: ${ticker}`, err);
    }
    try {
      chipDesc = await fetchChipSituation(ticker);
    } catch (err) {
      console.error(`[signals-runner] A 股筹码获取失败: ${ticker}`, err);
    }

    // 技术信号拉取失败：写中性 snapshot（含筹码，若有）+ 中性占位 alert，不动 state
    if (!cntv) {
      if (chipDesc) {
        await upsertTechnicalSnapshot({
          ticker,
          tickerName: name,
          oscillators: "neutral",
          movingAverages: "neutral",
          overall: "neutral",
          chipSituation: chipDesc,
          price: null,
        });
        console.log(`[signals-runner] A 股筹码写入(信号缺失): ${ticker} -> ${chipDesc.slice(0, 40)}…`);
      }
      try {
        await writeNeutralAlert(
          prisma,
          ticker,
          name,
          chipDesc
            ? `A 股 TradingView 信号未获取；筹码状态: ${chipDesc.slice(0, 80)}；今日已检查`
            : `A 股 TradingView 信号与筹码均未获取；今日已检查`
        );
      } catch (err) {
        console.error(`[signals-runner] 写 A 股占位失败: ${ticker}`, err);
      }
      return { processed: false, skipped: true, phase: chipDesc ? "cn_chip" : "cn_chip_empty" };
    }

    // 技术信号成功 → 写 snapshot（含筹码，若有）+ 状态机决策
    await upsertTechnicalSnapshot({
      ticker,
      tickerName: name,
      oscillators: cntv.oscillators,
      movingAverages: cntv.movingAverages,
      overall: cntv.overall,
      chipSituation: chipDesc,
      price: null,
    });

    const today = classifySignal(cntv.overall);
    const state = await getCurrentState(prisma, ticker);
    const phase = decide(state, today);

    console.log(
      `[signals-runner] A股 ${ticker} state=${state} today=${today} → ${phase}`
    );

    // 建仓 / 平仓：写 buy/sell alert + 通知（与美股一致），note 附筹码状态
    if (phase === "enter" || phase === "exit") {
      const signalType: "buy" | "sell" = phase === "enter" ? "buy" : "sell";
      const r = await writeSignalAlertAndNotify(prisma, {
        ticker,
        name,
        signalType,
        overall: cntv.overall,
        oscillators: cntv.oscillators,
        movingAverages: cntv.movingAverages,
        chipDesc,
        state,
        phase,
        market,
      });
      if (!r.ok) {
        return {
          processed: false,
          skipped: true,
          error: r.error,
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
      signal: cntv,
      state,
      today,
    };
  }

  // 2) 非美股 & 非 A 股（港股/加密/ETF 等）：不支持信号与筹码状态。
  //    只写中性 snapshot（upsert，不会无限增长），不写 alert（避免噪音）。
  //    注意：CN 分支已在上面 return，能走到这里 market 必不为 CN。
  if (market !== "US") {
    try {
      await upsertTechnicalSnapshot({
        ticker,
        tickerName: name,
        oscillators: "neutral",
        movingAverages: "neutral",
        overall: "neutral",
        chipSituation: null,
        price: null,
      });
      console.log(`[signals-runner] 非美股/非A股已写中性 snapshot: ${ticker} (${market})`);
    } catch (err) {
      console.error(`[signals-runner] 写中性 snapshot 失败: ${ticker}`, err);
    }
    return { processed: false, skipped: true, phase: "non_us" };
  }

  // 3) 美股：拉取 TV 信号
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

  // 4) 应用状态机决策表
  const today = classifySignal(signals.overall);
  const state = await getCurrentState(prisma, ticker);
  const phase = decide(state, today);

  console.log(
    `[signals-runner] ${ticker} state=${state} today=${today} → ${phase}`
  );

  // 5) 写 snapshot（高频读缓存，与 alert 独立；只要拉到信号就更新）
  await upsertTechnicalSnapshot({
    ticker,
    tickerName: name,
    oscillators: signals.oscillators,
    movingAverages: signals.movingAverages,
    overall: signals.overall,
    chipSituation: null, // 美股无筹码状态
    price: null,
  });

  // 6) 根据 phase 决定是否写 alert + 通知
  if (phase === "enter" || phase === "exit") {
    const signalType: "buy" | "sell" = phase === "enter" ? "buy" : "sell";
    const r = await writeSignalAlertAndNotify(prisma, {
      ticker,
      name,
      signalType,
      overall: signals.overall,
      oscillators: signals.oscillators,
      movingAverages: signals.movingAverages,
      chipDesc: null,
      state,
      phase,
      market,
    });
    if (!r.ok) {
      return {
        processed: false,
        skipped: true,
        error: r.error,
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
 * 执行一整轮信号提醒：处理每个收藏，写 CronRun 记录。
 *
 * 注意：本函数**假定**传入的 favorites 数组已经过滤好（cron 传全部收藏，
 * 手动传单用户收藏）。函数本身不做范围过滤。
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
        processStarredStock(prisma, fav.ticker, fav.name)
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
