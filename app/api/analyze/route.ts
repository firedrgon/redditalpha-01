import { NextRequest, NextResponse } from "next/server";
import { fetchFinancialMetrics } from "@/lib/finance";
import {
  computeMetricsWithStrategies,
  computeOverallVerdict,
  buildOverallSummary,
  buildLLMMessages,
  type StockAnalysis,
} from "@/lib/analysis";
import { chatCompletion } from "@/lib/llm";
import { resolveTickerName } from "@/lib/ticker-names";
import { getEnabledStrategiesDB as getEnabledStrategies } from "@/lib/db";
import { getAnalysis, saveAnalysis } from "@/lib/db";
import { recordFinanceSnapshot } from "@/lib/db";
import { getDbInitError } from "@/lib/db/prisma";
import { detectMarket, normalizeCNTicker } from "@/lib/market";

export const runtime = "nodejs";
export const maxDuration = 60;
// 强制动态渲染，禁止 Next.js 路由缓存——确保每次请求都实时读数据库，
// 否则删除库数据后页面可能命中旧响应仍显示数据。
export const dynamic = "force-dynamic";
export const revalidate = 0;

// fetchFinancialMetrics 内部会串行尝试多个数据源（Tiingo→Finnhub→FMP→AV→Yahoo），
// 每个 API 2-3 秒，7 秒极易超时。改为 20 秒给足时间获取完整数据（含新闻）。
// A 股并行请求同花顺+腾讯（各 8s），20s 足够覆盖并行 + 潜在降级。
const FETCH_TIMEOUT_MS = 20000;
// Nemotron 3 Ultra 550B / DeepSeek R1 等大参数推理模型生成较慢，
// 30s 易超时。提升至 35s（与 maxDuration=60 配合，留 25s 给 fetch + 落库）。
const LLM_TIMEOUT_MS = 35000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController
): Promise<T> {
  const abortController = controller || new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`${label} 超时 (${ms}ms)`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 重新生成分析：拉取最新财务数据 → 跑策略判定 → 调用 LLM 生成叙述 → 写入数据库。
 * 数据库为唯一存储，不使用任何缓存层。每次调用都重新获取、重新分析。
 */
async function regenerateAnalysis(ticker: string): Promise<StockAnalysis> {
  const upper = ticker.toUpperCase();

  const metrics = await withTimeout(
    fetchFinancialMetrics(upper),
    FETCH_TIMEOUT_MS,
    "财务数据获取"
  );

  if (!metrics.name) {
    const name = await resolveTickerName(upper);
    metrics.name = name;
  }

  const strategies = await getEnabledStrategies();
  const results = computeMetricsWithStrategies(metrics, strategies);
  const overall = computeOverallVerdict(results);
  const overallSummary = buildOverallSummary(upper, results, overall);

  const analysis: StockAnalysis = {
    ticker: upper,
    name: metrics.name,
    metrics: results,
    overallVerdict: overall,
    overallSummary,
    strategyIdsUsed: strategies.map((s) => s.id),
    fetchedAt: new Date().toISOString(),
    dataSource: metrics.dataSource,
    warnings: metrics.warnings,
    currentPrice: metrics.currentPrice,
    targetMeanPrice: metrics.targetMeanPrice,
    targetHighPrice: metrics.targetHighPrice,
    targetLowPrice: metrics.targetLowPrice,
    targetMedianPrice: metrics.targetMedianPrice,
    targetUpside: metrics.targetUpside,
    numberOfAnalysts: metrics.numberOfAnalysts,
    recommendationMean: metrics.recommendationMean,
    news: metrics.news,
    industryRank: metrics.industryRank,
    industry: metrics.industry,
    sector: metrics.sector,
  };

  // 每次重新生成都会调用 LLM（用户点击「重新生成 AI 分析」即期望拿到新叙述）
  try {
    const messages = buildLLMMessages(
      upper,
      metrics,
      results,
      overall,
      overallSummary
    );
    const controller = new AbortController();
    const llmPromise = chatCompletion(messages, {
      temperature: 0.4,
      signal: controller.signal,
    });
    const resp = await withTimeout(
      llmPromise,
      LLM_TIMEOUT_MS,
      "LLM 分析",
      controller
    );
    analysis.llmNarrative = resp.text;
    analysis.llmProvider = `${resp.providerName} (${resp.model})`;
  } catch (err) {
    analysis.llmError = err instanceof Error ? err.message : String(err);
  }

  // 持久化到数据库。必须 await，否则 serverless 实例可能在写完成前就结束，
  // 导致新分析数据丢失、下次读取仍是旧数据。
  try {
    await saveAnalysis(analysis);
  } catch (saveErr) {
    const msg = saveErr instanceof Error ? saveErr.message : String(saveErr);
    console.error("[analyze] saveAnalysis failed:", msg);
    analysis.warnings = [
      ...(analysis.warnings ?? []),
      `分析结果保存失败: ${msg}`,
    ];
  }
  // 同步保存财务快照（不再 fire-and-forget）：serverless 返回响应后实例可能被回收，
  // 不 await 会导致财务数据没真正落库，再次读取看不到最新财务数据。
  try {
    await recordFinanceSnapshot(upper, metrics);
  } catch (err) {
    console.error("[analyze] recordFinanceSnapshot failed:", err);
  }

  return analysis;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim();
  const force = searchParams.get("force") === "true";

  if (!ticker) {
    return NextResponse.json(
      { error: "缺少 ticker 参数" },
      { status: 400 }
    );
  }

  // 规范化：A 股补全 .SH/.SZ 后缀，美股统一大写
  const upper =
    detectMarket(ticker) === "CN"
      ? (normalizeCNTicker(ticker) ?? ticker.toUpperCase())
      : ticker.toUpperCase();

  // 数据库未配置时直接报错，不走内存降级——否则用户会以为数据来自 DB，
  // 实际是内存里的旧数据，删除 DB 记录后页面仍显示，造成困惑。
  const dbInitError = getDbInitError();
  if (dbInitError) {
    return NextResponse.json(
      { error: `数据库未就绪: ${dbInitError.message}` },
      { status: 500 }
    );
  }

  // 重新生成：每次点击都重新拉取财务数据 + 重新跑 LLM 分析 + 写入数据库
  if (force) {
    try {
      const analysis = await regenerateAnalysis(upper);
      return NextResponse.json(analysis);
    } catch (err) {
      // 重新生成失败时，若数据库已有旧记录则返回旧记录并附带错误信息，
      // 否则返回错误。避免用户点了一次重新生成失败后看不到任何数据。
      const existing = await getAnalysis(upper);
      if (existing) {
        return NextResponse.json({
          ...existing,
          refreshError: err instanceof Error ? err.message : String(err),
        });
      }
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }
  }

  // 普通查询：直接从数据库读取最新落库的数据。
  // DB 无记录时返回 null，不自动生成——数据只由用户点击「重新生成」产生。
  // 这样删除库数据后页面会显示空状态，而非悄悄重新生成。
  const existing = await getAnalysis(upper);
  return NextResponse.json(existing);
}
