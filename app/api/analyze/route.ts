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
import { getEnabledStrategies } from "@/lib/strategies";
import {
  getCachedAnalysis,
  saveAnalysis,
} from "@/lib/analysis-cache";

export const runtime = "nodejs";
// 分析可能调用外部 LLM，避免被 Vercel 默认 10s 限制卡死
export const maxDuration = 60;

/**
 * GET /api/analyze?ticker=NVO
 *   默认：重新拉取最新财务数据 + 计算规则指标；
 *         若之前有 LLM 分析结果，直接复用，不重新调用大模型。
 *
 * GET /api/analyze?ticker=NVO&force=true
 *   重新拉取财务数据 + 重新调用 LLM（完全重新分析），覆盖旧缓存。
 *
 * GET /api/analyze?ticker=NVO&llm=false
 *   跳过 LLM 调用（仅规则判定）
 *
 * GET /api/analyze?ticker=NVO&cache=true
 *   直接返回完整缓存（连财务数据也不刷新），最快。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim();
  const force = searchParams.get("force") === "true";
  const useLLM = searchParams.get("llm") !== "false"; // 默认 true
  const useCacheOnly = searchParams.get("cache") === "true";

  if (!ticker) {
    return NextResponse.json(
      { error: "缺少 ticker 参数" },
      { status: 400 }
    );
  }

  const upper = ticker.toUpperCase();
  const cached = await getCachedAnalysis(upper);

  // cache=true 模式：直接返回完整缓存（最快）
  if (useCacheOnly && cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  // 2. 拉取最新财务数据
  const metrics = await fetchFinancialMetrics(upper);
  // 用 ticker-names 补充名称
  if (!metrics.name) {
    const name = await resolveTickerName(upper);
    metrics.name = name;
  }

  // 3. 取当前启用的策略
  const strategies = await getEnabledStrategies();

  // 4. 计算指标
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

  // 5. LLM 叙述：force=true 时重新调用；否则复用缓存中的 LLM 结果
  let llmReused = false;
  if (useLLM) {
    if (!force && cached?.llmNarrative) {
      // 复用缓存的 LLM 结果
      analysis.llmNarrative = cached.llmNarrative;
      analysis.llmProvider = cached.llmProvider;
      analysis.llmError = cached.llmError;
      llmReused = true;
    } else {
      // force=true 或没有缓存时，调用 LLM
      try {
        const messages = buildLLMMessages(
          upper,
          metrics,
          results,
          overall,
          overallSummary
        );
        const resp = await chatCompletion(messages, {
          temperature: 0.4,
          maxTokens: 1024,
        });
        analysis.llmNarrative = resp.text;
        analysis.llmProvider = `${resp.providerName} (${resp.model})`;
      } catch (err) {
        analysis.llmError =
          err instanceof Error ? err.message : String(err);
        // LLM 调用失败但缓存有结果时，保留缓存的 LLM 结果
        if (cached?.llmNarrative) {
          analysis.llmNarrative = cached.llmNarrative;
          analysis.llmProvider = cached.llmProvider;
          llmReused = true;
        }
      }
    }
  }

  // 6. 写入缓存（覆盖旧数据）
  await saveAnalysis(analysis);

  return NextResponse.json({ ...analysis, cached: false, llmReused });
}
