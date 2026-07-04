/**
 * 股票分析逻辑：基于启用的策略做规则判定 + LLM 叙述生成
 *
 * 策略来自 .strategies.json（lib/strategies.ts），用户可启用/禁用/编辑/新增。
 * computeMetricsWithStrategies() 根据 strategy.metricField 从 FinancialMetrics
 * 取值，按 operator / threshold 判定 pass/fail/unknown。
 *
 * 特殊字段 peVsIndustry：当 trailingPE 或 industryPE 缺失时返回 unknown，
 * 否则按 PE/industryPE 比值判定。
 */

import type { FinancialMetrics } from "./finance";
import type { LLMMessage } from "./llm";
import type { Strategy, MetricField, ValueFormat } from "./strategies";
import { DEFAULT_STRATEGIES } from "./strategies";

export type Verdict = "pass" | "fail" | "unknown";

export interface MetricResult {
  key: string; // strategy.id
  title: string; // strategy.name
  description: string; // strategy.description
  value: string; // 展示用的值文本
  numericValue: number | null;
  threshold: string; // 阈值描述
  verdict: Verdict;
  reasoning: string;
}

export interface StockAnalysis {
  ticker: string;
  name?: string | null;
  metrics: MetricResult[];
  overallVerdict: Verdict;
  overallSummary: string;
  // 分析师目标价与评级统计
  currentPrice?: number | null;
  targetMeanPrice?: number | null;
  targetHighPrice?: number | null;
  targetLowPrice?: number | null;
  targetMedianPrice?: number | null;
  targetUpside?: number | null;
  numberOfAnalysts?: number | null;
  recommendationMean?: number | null;
  // LLM 叙述（若可用）
  llmNarrative?: string;
  llmProvider?: string;
  llmError?: string;
  // 当时分析所用的策略 id 列表（缓存命中时显示，便于和当前启用策略对比）
  strategyIdsUsed: string[];
  fetchedAt: string;
  cached?: boolean; // 是否来自缓存
  // 财务数据来源 & 警告（用于排查"未能获取该指标数据"类问题）
  dataSource?: string;
  warnings?: string[];
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function fmtNum(v: number | null, suffix = ""): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}${suffix}`;
}

function fmtValue(v: number | null, format: ValueFormat): string {
  if (format === "percent") return fmtPct(v);
  return fmtNum(v);
}

function fmtThreshold(threshold: number, format: ValueFormat): string {
  if (format === "percent") return `${(threshold * 100).toFixed(2)}%`;
  return threshold.toFixed(2);
}

function applyOperator(
  value: number,
  operator: Strategy["operator"],
  threshold: number
): boolean {
  switch (operator) {
    case ">=":
      return value >= threshold;
    case ">":
      return value > threshold;
    case "<=":
      return value <= threshold;
    case "<":
      return value < threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
  }
}

/** 从 FinancialMetrics 按 metricField 取值 */
function getFieldValue(
  metrics: FinancialMetrics,
  field: MetricField
): number | null {
  switch (field) {
    case "revenueGrowthYoY":
      return metrics.revenueGrowthYoY;
    case "quarterlyRevenueGrowth":
      return metrics.quarterlyRevenueGrowth;
    case "trailingPE":
      return metrics.trailingPE;
    case "forwardPE":
      return metrics.forwardPE;
    case "pegRatio":
      return metrics.pegRatio;
    case "returnOnEquity5yAvg":
      return metrics.returnOnEquity5yAvg;
    case "roe":
      return metrics.roe;
    case "quickRatio":
      return metrics.quickRatio;
    case "currentRatio":
      return metrics.currentRatio;
    case "grossMargin":
      return metrics.grossMargin;
    case "profitMargin":
      return metrics.profitMargin;
    case "peVsIndustry": {
      // 特殊：取 PE / industryPE 比值
      // 优先用 trailingPE，没有的话用 forwardPE
      const pe = metrics.trailingPE ?? metrics.forwardPE;
      if (pe == null || metrics.industryPE == null) return null;
      if (metrics.industryPE === 0) return null;
      return pe / metrics.industryPE;
    }
    case "targetUpside":
      return metrics.targetUpside;
    case "recommendationMean":
      return metrics.recommendationMean;
    default:
      return null;
  }
}

/** 计算单个策略的判定结果 */
function computeOne(
  strategy: Strategy,
  metrics: FinancialMetrics
): MetricResult {
  const value = getFieldValue(metrics, strategy.metricField);

  const { verdict, reasoning } =
    value == null
      ? {
          verdict: "unknown" as Verdict,
          reasoning: "未能获取该指标数据，无法判定。",
        }
      : (() => {
          const passed = applyOperator(
            value,
            strategy.operator,
            strategy.threshold
          );
          const valueStr = fmtValue(value, strategy.format);
          const threshStr = fmtThreshold(strategy.threshold, strategy.format);
          return {
            verdict: (passed ? "pass" : "fail") as Verdict,
            reasoning: passed
              ? `实际值 ${valueStr} 满足 ${strategy.operator} ${threshStr}，达标。`
              : `实际值 ${valueStr} 不满足 ${strategy.operator} ${threshStr}，未达标。`,
          };
        })();

  // 对 peVsIndustry 给出更友好的展示
  let displayValue = fmtValue(value, strategy.format);
  if (strategy.metricField === "peVsIndustry") {
    const pe = metrics.trailingPE ?? metrics.forwardPE;
    const peLabel = metrics.trailingPE != null ? "PE" : "Forward PE";
    const indPE = metrics.industryPE;
    displayValue =
      pe != null && indPE != null
        ? `${peLabel} ${pe.toFixed(2)} / 行业 ${indPE.toFixed(2)} = ${(pe / indPE).toFixed(2)}`
        : pe != null
          ? `${peLabel} ${pe.toFixed(2)} / 行业 —`
          : "—";
  } else if (strategy.metricField === "targetUpside") {
    const currentPrice = metrics.currentPrice;
    const targetMean = metrics.targetMeanPrice;
    const analysts = metrics.numberOfAnalysts;
    if (value != null && currentPrice != null && targetMean != null) {
      const analystStr = analysts != null ? `（${analysts}位分析师）` : "";
      displayValue = `当前价 $${currentPrice.toFixed(2)} → 目标均价 $${targetMean.toFixed(2)}\n上涨空间 ${(value * 100).toFixed(2)}%${analystStr}`;
    }
  } else if (strategy.metricField === "recommendationMean") {
    if (value != null) {
      let label = "";
      if (value <= 1.5) label = "强力买入";
      else if (value <= 2.5) label = "买入";
      else if (value <= 3.5) label = "持有";
      else if (value <= 4.5) label = "卖出";
      else label = "强力卖出";
      const high = metrics.targetHighPrice;
      const low = metrics.targetLowPrice;
      const rangeStr = high != null && low != null ? `，目标价区间 $${low.toFixed(2)}~$${high.toFixed(2)}` : "";
      displayValue = `${value.toFixed(2)}（${label}）${rangeStr}`;
    }
  }

  return {
    key: strategy.id,
    title: strategy.name,
    description: strategy.description,
    value: displayValue,
    numericValue: value,
    threshold: `${strategy.operator} ${fmtThreshold(
      strategy.threshold,
      strategy.format
    )}`,
    verdict,
    reasoning,
  };
}

/**
 * 根据启用的策略列表计算判定结果
 * @param metrics 财务数据
 * @param strategies 已按 order 排序的、启用的策略
 */
export function computeMetricsWithStrategies(
  metrics: FinancialMetrics,
  strategies: Strategy[]
): MetricResult[] {
  return strategies.map((s) => computeOne(s, metrics));
}

/** 兼容旧接口：使用默认 5 项策略计算 */
export function computeMetrics(metrics: FinancialMetrics): MetricResult[] {
  return computeMetricsWithStrategies(
    metrics,
    DEFAULT_STRATEGIES.filter((s) => s.enabled).map((s) => ({ ...s }))
  );
}

export function computeOverallVerdict(results: MetricResult[]): Verdict {
  const judged = results.filter((r) => r.verdict !== "unknown");
  if (judged.length === 0) return "unknown";
  if (judged.some((r) => r.verdict === "fail")) return "fail";
  return "pass";
}

export function buildOverallSummary(
  ticker: string,
  results: MetricResult[],
  overall: Verdict
): string {
  const fails = results.filter((r) => r.verdict === "fail");
  const passes = results.filter((r) => r.verdict === "pass");
  const unknowns = results.filter((r) => r.verdict === "unknown");

  const lines: string[] = [];
  if (overall === "pass") {
    lines.push(`${ticker}：${passes.length} 项关键指标全部通过，符合长期持有候选标准。`);
  } else if (overall === "fail") {
    lines.push(
      `${ticker}：${fails.length} 项指标未通过，建议谨慎。未通过项：${fails.map((f) => f.title).join("、")}。`
    );
  } else {
    lines.push(
      `${ticker}：部分指标数据缺失，无法做出完整判断。已通过 ${passes.length} 项，未通过 ${fails.length} 项，未知 ${unknowns.length} 项。`
    );
  }
  return lines.join("\n");
}

/** 构造发送给 LLM 的消息 */
export function buildLLMMessages(
  ticker: string,
  metrics: FinancialMetrics,
  results: MetricResult[],
  overall: Verdict,
  overallSummary: string
): LLMMessage[] {
  const system = `你是一位严谨的股票分析师，使用用户启用的若干项关键财务指标为投资者筛选长期持有的优质标的。
请基于给定的真实财务数据、近期新闻和所属行业信息，给出简洁、专业、客观的分析结论。
不要给出具体买卖建议或价格预测，只评估该公司是否符合用户启用的指标标准。
输出格式（必须包含以下 4 个章节标题）：
## 公司概览
用 1-2 段总结性文字点评该公司。

## 指标判定
列出每项指标各自的判定（通过/不通过/数据缺失）和一句理由。

## 消息面分析
基于提供的近期新闻，总结 2-4 条最重要的利好和利空因素。如果新闻不足，说明"近期新闻有限"。

## 行业前景
结合公司所属行业，分析该行业未来 1-3 年的主要趋势、增长动力和潜在风险。

## 总评
给出是否符合标准、风险提示。

请用中文回答，字数控制在 900 字以内。`;

  const dataLines: string[] = [];
  dataLines.push(`股票代码：${ticker}`);
  if (metrics.name) dataLines.push(`公司名称：${metrics.name}`);
  if (metrics.industry) dataLines.push(`所属行业：${metrics.industry}`);
  if (metrics.totalRevenue != null)
    dataLines.push(
      `总营收：${(metrics.totalRevenue / 1e9).toFixed(2)} 亿（${metrics.currency || "USD"}）`
    );
  if (metrics.currentPrice != null)
    dataLines.push(`当前股价：$${metrics.currentPrice.toFixed(2)}`);
  if (metrics.targetMeanPrice != null) {
    const upside = metrics.targetUpside != null ? `${(metrics.targetUpside * 100).toFixed(2)}%` : "—";
    const analystStr = metrics.numberOfAnalysts != null ? `（${metrics.numberOfAnalysts}位分析师）` : "";
    dataLines.push(`分析师目标均价：$${metrics.targetMeanPrice.toFixed(2)}，上涨空间：${upside}${analystStr}`);
  }
  if (metrics.targetHighPrice != null && metrics.targetLowPrice != null)
    dataLines.push(`分析师目标价区间：$${metrics.targetLowPrice.toFixed(2)} ~ $${metrics.targetHighPrice.toFixed(2)}`);
  if (metrics.recommendationMean != null) {
    let label = "";
    if (metrics.recommendationMean <= 1.5) label = "强力买入";
    else if (metrics.recommendationMean <= 2.5) label = "买入";
    else if (metrics.recommendationMean <= 3.5) label = "持有";
    else if (metrics.recommendationMean <= 4.5) label = "卖出";
    else label = "强力卖出";
    dataLines.push(`分析师推荐评级：${metrics.recommendationMean.toFixed(2)}（${label}）`);
  }
  if (metrics.news && metrics.news.length > 0) {
    dataLines.push("");
    dataLines.push(`【近期相关新闻（共 ${metrics.news.length} 条）】`);
    for (const n of metrics.news.slice(0, 8)) {
      const dateStr = n.date ? new Date(n.date).toLocaleDateString("zh-CN") : "";
      dataLines.push(`- ${dateStr ? `[${dateStr}] ` : ""}${n.title}${n.source ? `（${n.source}）` : ""}`);
      if (n.summary) dataLines.push(`  摘要：${n.summary.slice(0, 200)}${n.summary.length > 200 ? "..." : ""}`);
    }
  } else {
    dataLines.push("");
    dataLines.push("【近期相关新闻】");
    dataLines.push("- 未获取到相关新闻。");
  }

  dataLines.push("");
  dataLines.push(`【启用的指标数据（共 ${results.length} 项）】`);
  for (const r of results) {
    dataLines.push(`- ${r.title}`);
    dataLines.push(`  实际值：${r.value}`);
    dataLines.push(`  阈值：${r.threshold}`);
    dataLines.push(`  规则判定：${r.verdict}`);
    dataLines.push(`  理由：${r.reasoning}`);
  }
  dataLines.push("");
  dataLines.push(`规则计算总判定：${overall}`);
  dataLines.push(`规则计算总评：${overallSummary}`);
  dataLines.push("");
  dataLines.push("数据警告：");
  if (metrics.warnings.length === 0) {
    dataLines.push("- 无");
  } else {
    for (const w of metrics.warnings) dataLines.push(`- ${w}`);
  }

  const user = `请基于以下数据，对 ${ticker} 进行分析，并给出你的独立判断（可以补充规则之外的洞察，例如行业地位、护城河、风险因素等）。

${dataLines.join("\n")}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
