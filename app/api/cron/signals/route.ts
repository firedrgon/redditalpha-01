import { NextRequest, NextResponse } from "next/server";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_NAME = "signals";

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

interface ProcessResult {
  processed: boolean;
  skipped: boolean;
  error?: string;
  phase?: "non_us" | "fetch_empty" | "fetch_error" | "ok";
  signal?: TechnicalSignals;
}

/**
 * 处理单个 starred 收藏。
 *
 * 关键设计：
 * - 非美股：写一条 neutral SignalAlert，让前端有"今日已检查"反馈
 * - 拉取失败：写一条 neutral SignalAlert，note 含错误信息，用户能看到
 * - 成功：写 SignalAlert + 写 TechnicalSignalSnapshot
 *
 * 不管成功失败，都返回一条记录，由调用方汇总到 CronRun。
 */
async function processStarredStock(
  prisma: NonNullable<Awaited<ReturnType<typeof getPrisma>>>,
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
      console.log(`[cron/signals] 非美股已记录占位: ${ticker} (${market})`);
      return { processed: false, skipped: true, phase: "non_us" };
    } catch (err) {
      console.error(`[cron/signals] 写非美股占位失败: ${ticker}`, err);
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
      console.error(`[cron/signals] 写失败记录也失败: ${ticker}`, err);
    }
    console.log(`[cron/signals] 拉取失败已记录: ${ticker} -> ${reason}`);
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
      `[cron/signals] 创建信号提醒 + snapshot: ${ticker} -> ${signalType} (${signals.overall})`
    );
    return { processed: true, skipped: false, signal: signals, phase: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron/signals] 写库失败: ${ticker}`, err);
    return { processed: false, skipped: true, error: msg, phase: "fetch_error" };
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // 诊断：401 也写一条 CronRun，方便排查 CRON_SECRET 不匹配问题
    // 默认开启；诊断完毕后可在 Vercel 设 CRON_LOG_AUTH_FAILURES=false 关闭
    if (process.env.CRON_LOG_AUTH_FAILURES !== "false") {
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  // 1) 启动 CronRun
  const runId = await startCronRun({ jobName: JOB_NAME });

  try {
    const starredFavorites = await prisma.favorite.findMany({
      where: { starred: true },
      select: { userId: true, ticker: true, name: true },
    });

    if (starredFavorites.length === 0) {
      await finishCronRun(runId, {
        status: "success",
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 0,
      });
      return NextResponse.json({
        success: true,
        message: "没有重点关注的股票",
        total: 0,
        processed: 0,
        skipped: 0,
        errorCount: 0,
        runId,
      });
    }

    const results = await Promise.all(
      starredFavorites.map((fav) =>
        processStarredStock(prisma, fav.userId!, fav.ticker, fav.name)
      )
    );

    const processed = results.filter((r) => r.processed).length;
    const errorItems: CronRunErrorItem[] = results
      .filter((r) => !r.processed && r.error)
      .map((r, i) => ({
        ticker: starredFavorites[i].ticker,
        error: r.error!,
        phase: r.phase,
      }));
    const errorCount = errorItems.length;
    // 当前 processStarredStock 失败也归入 errorCount，skipped 实际为 0
    const skipped = Math.max(0, starredFavorites.length - processed - errorCount);

    // 2) 收尾 CronRun
    const status = errorCount > 0 && processed === 0 ? "error" : "success";
    await finishCronRun(runId, {
      status,
      total: starredFavorites.length,
      processed,
      skipped,
      errorCount,
      errors: errorItems,
    });

    return NextResponse.json({
      success: true,
      runId,
      total: starredFavorites.length,
      processed,
      skipped,
      errorCount,
      errors: errorItems,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/signals] 定时任务执行失败:", err);

    // 顶层异常也要写进 CronRun，方便排查
    await finishCronRun(runId, {
      status: "error",
      total: 0,
      processed: 0,
      skipped: 0,
      errorCount: 1,
      errorMessage: msg,
    });

    return NextResponse.json({ error: msg, runId }, { status: 500 });
  }
}
