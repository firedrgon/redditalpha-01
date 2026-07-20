import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { fetchTradingViewTechnicals, SIGNAL_LABELS } from "@/lib/technical";
import { detectMarket } from "@/lib/market";
import { upsertTechnicalSnapshot } from "@/lib/db/technical-snapshot";
import type { Signal, TechnicalSignals } from "@/lib/technical";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

async function processStarredStock(
  prisma: NonNullable<Awaited<ReturnType<typeof getPrisma>>>,
  userId: string,
  ticker: string,
  name: string | null
): Promise<{ processed: boolean; signal?: TechnicalSignals; error?: string }> {
  const market = detectMarket(ticker);
  if (market !== "US") {
    console.log(`[cron/signals] 跳过非美股: ${ticker} (市场: ${market})`);
    return { processed: false, error: "非美股，技术信号仅支持美股" };
  }

  try {
    const signals = await fetchTradingViewTechnicals(ticker);
    if (!signals) {
      console.log(`[cron/signals] 未获取到信号: ${ticker}`);
      return { processed: false, error: "未获取到技术信号" };
    }

    const signalType = determineSignalType(signals.overall);
    const note = buildNote(signals);

    // 1) 写 SignalAlert（事件存档，用于 /signals 页面历史流）
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

    // 2) 同步写入 TechnicalSignalSnapshot（高频读缓存，Card 渲染直接查这里）
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
    return { processed: true, signal: signals };
  } catch (err) {
    console.error(`[cron/signals] 处理失败: ${ticker}`, err);
    return { processed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "Database not available" }, { status: 500 });
  }

  try {
    const starredFavorites = await prisma.favorite.findMany({
      where: { starred: true },
      select: { userId: true, ticker: true, name: true },
    });

    if (starredFavorites.length === 0) {
      return NextResponse.json({
        success: true,
        message: "没有重点关注的股票",
        processed: 0,
        created: 0,
      });
    }

    const results = await Promise.all(
      starredFavorites.map((fav) =>
        processStarredStock(prisma, fav.userId!, fav.ticker, fav.name)
      )
    );

    const processed = results.filter((r) => r.processed).length;
    const errors = results.filter((r) => !r.processed && r.error).map((r) => r.error);

    return NextResponse.json({
      success: true,
      total: starredFavorites.length,
      processed,
      skipped: starredFavorites.length - processed,
      errors,
    });
  } catch (err) {
    console.error("[cron/signals] 定时任务执行失败:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
