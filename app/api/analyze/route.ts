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
import {
  getCachedAnalysisDB as getCachedAnalysis,
  saveAnalysisDB as saveAnalysis,
} from "@/lib/db";
import { recordFinanceSnapshot } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

const FETCH_TIMEOUT_MS = 7000;
const LLM_TIMEOUT_MS = 30000;

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

async function doRefresh(
  ticker: string,
  options: { force?: boolean; useLLM?: boolean; llmTimeoutMs?: number } = {}
): Promise<{ analysis: StockAnalysis }> {
  const upper = ticker.toUpperCase();
  const { force = false, useLLM = true, llmTimeoutMs = LLM_TIMEOUT_MS } = options;
  const cached = await getCachedAnalysis(upper);

  let metrics;
  try {
    metrics = await withTimeout(
      fetchFinancialMetrics(upper),
      FETCH_TIMEOUT_MS,
      "财务数据获取"
    );
  } catch (err) {
    if (cached) {
      return { analysis: { ...cached, cached: true } };
    }
    throw err;
  }

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
  };

  if (useLLM) {
    if (!force && cached?.llmNarrative) {
      analysis.llmNarrative = cached.llmNarrative;
      analysis.llmProvider = cached.llmProvider;
      analysis.llmError = cached.llmError;
    } else {
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
          llmTimeoutMs,
          "LLM 分析",
          controller
        );
        analysis.llmNarrative = resp.text;
        analysis.llmProvider = `${resp.providerName} (${resp.model})`;
      } catch (err) {
        analysis.llmError =
          err instanceof Error ? err.message : String(err);
        if (cached?.llmNarrative) {
          analysis.llmNarrative = cached.llmNarrative;
          analysis.llmProvider = cached.llmProvider;
        }
      }
    }
  }

  // 持久化分析结果。必须 await，否则 serverless 实例可能在写完成前就结束，
  // 导致新分析数据丢失、下次进来仍是旧数据。
  // 错误不再静默吞掉：记录到 warnings 但不影响响应（用户已拿到 analysis）。
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
  recordFinanceSnapshot(upper, metrics).catch((err) => {
    console.error("[analyze] recordFinanceSnapshot failed:", err);
  });

  return { analysis };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim();
  const force = searchParams.get("force") === "true";
  const useLLM = searchParams.get("llm") !== "false";
  const useCacheOnly = searchParams.get("cache") === "true";

  if (!ticker) {
    return NextResponse.json(
      { error: "缺少 ticker 参数" },
      { status: 400 }
    );
  }

  const upper = ticker.toUpperCase();
  const cached = await getCachedAnalysis(upper);

  if (useCacheOnly && cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  if (cached && !force) {
    doRefresh(upper, { force: false, useLLM }).catch(() => {});
    return NextResponse.json({ ...cached, cached: true, refreshing: true });
  }

  try {
    const { analysis } = await doRefresh(upper, { force, useLLM });
    return NextResponse.json({ ...analysis, cached: false });
  } catch (err) {
    if (cached) {
      return NextResponse.json(
        {
          ...cached,
          cached: true,
          refreshError: err instanceof Error ? err.message : String(err),
        },
        { status: 200 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
