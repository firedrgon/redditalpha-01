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
 *   默认：返回缓存的分析结果（若存在），cached=true
 *
 * GET /api/analyze?ticker=NVO&force=true
 *   重新拉取财务数据 + 调用 LLM，覆盖旧缓存
 *
 * GET /api/analyze?ticker=NVO&llm=false
 *   跳过 LLM 调用（仅规则判定）
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim();
  const force = searchParams.get("force") === "true";
  const useLLM = searchParams.get("llm") !== "false"; // 默认 true

  if (!ticker) {
    return NextResponse.json(
      { error: "缺少 ticker 参数" },
      { status: 400 }
    );
  }

  const upper = ticker.toUpperCase();

  // 1. 非 force 模式：优先返回缓存
  if (!force) {
    const cached = await getCachedAnalysis(upper);
    if (cached) {
      return NextResponse.json({ ...cached, cached: true });
    }
  }

  // 2. 拉取财务数据
  const metrics = await fetchFinancialMetrics(upper);
  // 用 ticker-names 补充名称（Yahoo quoteSummary 没给直接的 shortName）
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
  };

  // 5. 调用 LLM 补充叙述（可选）
  if (useLLM) {
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
    }
  }

  // 6. 写入缓存（覆盖旧数据）
  await saveAnalysis(analysis);

  return NextResponse.json({ ...analysis, cached: false });
}
