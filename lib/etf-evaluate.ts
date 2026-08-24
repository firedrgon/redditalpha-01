/**
 * ETF 主升浪「估值 + 质量」评估引擎（纯函数，无网络依赖）
 *
 * 设计前提：调用方已经确认该 ETF 处于主升浪（趋势/筛选已先行完成），
 * 因此本模块只负责回答两个问题：
 *   1. 估值层（底层指数贵不贵、还有多少上行空间？）—— 决定「空间」
 *   2. 质量层（这只 ETF 本身工具属性好不好？）—— 决定「安全边际/冲击成本」
 * 最终综合两者给出买入价值评级 A/B/C/D。
 *
 * 所有输入字段均可为 null（数据缺失时），引擎对缺失项做「中性处理」并显式标注，
 * 不会因为缺数据而崩。评分区间统一为 0~100，越高越好。
 */

// ============================================================
// 类型定义
// ============================================================

/** 估值输入：底层指数的估值与景气信息（全部可选，null = 未知） */
export interface EtfValuationInput {
  /** 跟踪指数 PE 所处的历史百分位（0~100，越高越贵）。优先真实分位。 */
  indexPePercentile: number | null;
  /** 跟踪指数 PB 所处的历史百分位（0~100）。 */
  indexPbPercentile: number | null;
  /** 当前股息率（%，如 2.3 表示 2.3%）。 */
  dividendYieldPct: number | null;
  /** 10 年期国债收益率（%，用于股息安全垫对比），默认取 ~2.5。 */
  bondYieldPct: number | null;
  /** 盈利预期上修比例（%，-50~50，正数=更多分析师上调 EPS）。可选。 */
  epsRevisionUpPct: number | null;
  /** 若为代理分位（无真实历史分位、用 PE/估值天花板推算），置 true 以提示。 */
  proxy: boolean;
  /**
   * 当前价格吸引力（0~100，越高=当前价格越有吸引力/越便宜），由净值历史推导的兜底信号。
   * 当指数 PE/PB 分位与股息率均不可得时，作为「好价格」维度的主信号，避免维度空置。
   * 可选：不传（undefined）即视为缺失，不影响其它估值信号。
   */
  navPriceScore?: number | null;
}

/** 质量输入：ETF 自身的工具属性（全部可选，null = 未知） */
export interface EtfQualityInput {
  /** 基金规模（亿元）。 */
  scaleYi: number | null;
  /** 日均成交额（万元）。 */
  dailyTurnoverWan: number | null;
  /** 折溢价率（%，正数=溢价、负数=折价）。 */
  premiumDiscountPct: number | null;
  /** 年化跟踪误差（%）。 */
  trackingErrorPct: number | null;
  /** 总费率（管理+托管，%）。 */
  feeRatePct: number | null;
}

/** 单指标的分项打分结果 */
export interface MetricScore {
  key: string;
  label: string;
  /** 该项得分 0~100，null = 未评估（数据缺失） */
  score: number | null;
  /** 该项权重（仅对「已评估」项有效） */
  weight: number;
  /** 人类可读的说明 */
  note: string;
}

export interface DimensionResult {
  /** 维度综合分 0~100，null = 无可用数据 */
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "?";
  metrics: MetricScore[];
  notes: string[];
}

export type BuyGrade = "A" | "B" | "C" | "D";

export interface EtfEvaluation {
  /** 估值维度 */
  valuation: DimensionResult;
  /** 质量维度 */
  quality: DimensionResult;
  /** 综合买入价值分 0~100 */
  totalScore: number | null;
  /** 综合评级 */
  grade: BuyGrade | "?";
  /** 关键风险提示（已触发才会写入） */
  warnings: string[];
  /** 一句话结论 */
  summary: string;
}

// ============================================================
// 可调参数（权重 / 阈值）
// ============================================================

/** 估值维度内各指标权重（仅对已评估项归一化） */
const VALUATION_WEIGHTS: Record<keyof EtfValuationInput, number> = {
  indexPePercentile: 0.35,
  indexPbPercentile: 0.25,
  dividendYieldPct: 0.2,
  bondYieldPct: 0.0, // 仅作对比基准，不直接计分
  epsRevisionUpPct: 0.2,
  proxy: 0.0,
  navPriceScore: 0.15, // 净值价格位置兜底（PE/PB/股息率缺失时权重上升）
};

/** 质量维度内各指标权重 */
const QUALITY_WEIGHTS: Record<keyof EtfQualityInput, number> = {
  scaleYi: 0.3,
  dailyTurnoverWan: 0.3,
  premiumDiscountPct: 0.15,
  trackingErrorPct: 0.15,
  feeRatePct: 0.1,
};

/** 综合评分：估值(空间) 与 质量(工具) 的权重。趋势已给定，两者并重、估值略高。 */
export const COMBINED_WEIGHTS = { valuation: 0.55, quality: 0.45 };

/** 评级分档 */
export function gradeFromScore(score: number): BuyGrade {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  return "D";
}

// ============================================================
// 工具函数
// ============================================================

export function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 百分位 → 估值分：越低（越便宜）分越高 */
export function pePbScoreFromPercentile(pct: number): number {
  return clamp(100 - pct);
}

/** 规模 → 质量分（亿元） */
export function scaleScore(scaleYi: number): number {
  if (scaleYi >= 50) return 100;
  if (scaleYi >= 10) return 90;
  if (scaleYi >= 5) return 80;
  if (scaleYi >= 2) return 70;
  if (scaleYi >= 1) return 50;
  return 20;
}

/** 日均成交额 → 质量分（万元） */
export function turnoverScore(wan: number): number {
  if (wan >= 20000) return 100; // >=2 亿
  if (wan >= 5000) return 90; // 5000 万~2 亿
  if (wan >= 1000) return 75; // 1000 万~5000 万
  if (wan >= 500) return 60;
  return 30;
}

/** 折溢价率绝对值 → 质量分（偏离越大越差；折价对买家略有利，仅作温和提示） */
export function premiumDiscountScore(pdPct: number): number {
  const abs = Math.abs(pdPct);
  if (abs <= 0.1) return 100;
  if (abs <= 0.3) return 90;
  if (abs <= 0.5) return 75;
  if (abs <= 1.0) return 50;
  return 30;
}

/** 跟踪误差 → 质量分（%） */
export function trackingErrorScore(pct: number): number {
  if (pct <= 0.2) return 100;
  if (pct <= 0.5) return 90;
  if (pct <= 1.0) return 75;
  if (pct <= 2.0) return 50;
  return 30;
}

/** 总费率 → 质量分（%） */
export function feeScore(pct: number): number {
  if (pct <= 0.15) return 100;
  if (pct <= 0.3) return 90;
  if (pct <= 0.5) return 75;
  if (pct <= 0.75) return 60;
  return 40;
}

/** 股息率 → 估值分（%，含对国债的安全垫判断） */
export function dividendScore(div: number, bond: number | null): number {
  // 5% 股息率即满分；同时与国债对比给出安全垫
  let s = clamp(div * 20);
  if (bond != null && bond > 0 && div > bond) {
    s = clamp(s + 10); // 股息率超过国债，额外加分
  }
  return s;
}

/** 盈利上修比例 → 估值分（%，-50~50 映射到 0~100） */
export function epsRevisionScore(pct: number): number {
  return clamp(50 + pct);
}

// ============================================================
// 估值评估
// ============================================================

export function scoreValuation(input: EtfValuationInput): DimensionResult {
  const metrics: MetricScore[] = [];
  const notes: string[] = [];

  if (input.indexPePercentile != null) {
    const s = pePbScoreFromPercentile(input.indexPePercentile);
    metrics.push({
      key: "pe",
      label: "指数 PE 分位",
      score: s,
      weight: VALUATION_WEIGHTS.indexPePercentile,
      note: `当前 PE 处历史 ${input.indexPePercentile.toFixed(0)}% 分位${
        input.proxy ? "（代理估算）" : ""
      } → ${s >= 70 ? "低估、空间大" : s >= 50 ? "合理" : s >= 30 ? "偏高" : "偏贵"}`,
    });
  }

  if (input.indexPbPercentile != null) {
    const s = pePbScoreFromPercentile(input.indexPbPercentile);
    metrics.push({
      key: "pb",
      label: "指数 PB 分位",
      score: s,
      weight: VALUATION_WEIGHTS.indexPbPercentile,
      note: `当前 PB 处历史 ${input.indexPbPercentile.toFixed(0)}% 分位${
        input.proxy ? "（代理估算）" : ""
      } → ${s >= 70 ? "破净/低估" : s >= 50 ? "合理" : s >= 30 ? "偏高" : "偏贵"}`,
    });
  }

  if (input.dividendYieldPct != null) {
    const s = dividendScore(input.dividendYieldPct, input.bondYieldPct);
    const cushion =
      input.bondYieldPct != null
        ? input.dividendYieldPct > input.bondYieldPct
          ? "，高于国债收益率（有安全垫）"
          : "，低于国债收益率"
        : "";
    metrics.push({
      key: "dividend",
      label: "股息率安全垫",
      score: s,
      weight: VALUATION_WEIGHTS.dividendYieldPct,
      note: `股息率 ${input.dividendYieldPct.toFixed(2)}%${cushion}`,
    });
  }

  if (input.epsRevisionUpPct != null) {
    const s = epsRevisionScore(input.epsRevisionUpPct);
    metrics.push({
      key: "eps",
      label: "盈利预期上修",
      score: s,
      weight: VALUATION_WEIGHTS.epsRevisionUpPct,
      note: `分析师 EPS 上修比例 ${input.epsRevisionUpPct >= 0 ? "+" : ""}${input.epsRevisionUpPct.toFixed(
        0
      )}% → ${s >= 60 ? "景气向上" : s >= 40 ? "中性" : "预期下修"}`,
    });
  }

  if (input.navPriceScore != null) {
    const s = clamp(input.navPriceScore);
    metrics.push({
      key: "navPrice",
      label: "当前价格位置（净值）",
      score: s,
      weight: VALUATION_WEIGHTS.navPriceScore,
      note: `基于净值历史的价格吸引力 ${s.toFixed(0)} 分（越高=当前价格越有吸引力；PE/PB 分位与股息率缺失时的兜底信号）`,
    });
  }

  const evaluated = metrics.filter((m) => m.score != null);
  if (evaluated.length === 0) {
    notes.push("估值数据缺失，无法评估，按中性处理");
    return { score: null, grade: "?", metrics, notes };
  }

  const wsum = evaluated.reduce((s, m) => s + m.weight, 0);
  const score = clamp(
    evaluated.reduce((s, m) => s + (m.score ?? 0) * m.weight, 0) / wsum
  );

  if (input.proxy) notes.push("估值分位为代理估算（无真实历史分位数据源）");
  if (score < 40) notes.push("估值偏贵，主升浪上行空间有限，建议轻仓");

  return { score, grade: gradeFromScore(score), metrics, notes };
}

// ============================================================
// 质量评估
// ============================================================

export function scoreQuality(input: EtfQualityInput): DimensionResult {
  const metrics: MetricScore[] = [];
  const notes: string[] = [];

  if (input.scaleYi != null) {
    const s = scaleScore(input.scaleYi);
    metrics.push({
      key: "scale",
      label: "基金规模",
      score: s,
      weight: QUALITY_WEIGHTS.scaleYi,
      note: `规模 ${input.scaleYi.toFixed(1)} 亿元 → ${
        s >= 80 ? "流动性充裕" : s >= 70 ? "规模达标" : s >= 50 ? "偏小" : "有清盘/流动性风险"
      }`,
    });
  }

  if (input.dailyTurnoverWan != null) {
    const s = turnoverScore(input.dailyTurnoverWan);
    const yi = (input.dailyTurnoverWan / 10000).toFixed(2);
    metrics.push({
      key: "turnover",
      label: "日均成交额",
      score: s,
      weight: QUALITY_WEIGHTS.dailyTurnoverWan,
      note: `日均成交 ${yi} 亿元 → ${
        s >= 90 ? "成交活跃、冲击小" : s >= 75 ? "可接受" : "偏淡、注意滑点"
      }`,
    });
  }

  if (input.premiumDiscountPct != null) {
    const s = premiumDiscountScore(input.premiumDiscountPct);
    const abs = Math.abs(input.premiumDiscountPct);
    const dir =
      input.premiumDiscountPct > 0.05
        ? "溢价买入等于多花钱"
        : input.premiumDiscountPct < -0.05
        ? "折价买入更划算"
        : "基本平价";
    metrics.push({
      key: "pd",
      label: "折溢价率",
      score: s,
      weight: QUALITY_WEIGHTS.premiumDiscountPct,
      note: `折溢价 ${input.premiumDiscountPct >= 0 ? "+" : ""}${input.premiumDiscountPct.toFixed(
        2
      )}%${abs > 0.5 ? "（偏离偏大，" + dir + "）" : ""}`,
    });
  }

  if (input.trackingErrorPct != null) {
    const s = trackingErrorScore(input.trackingErrorPct);
    metrics.push({
      key: "trackErr",
      label: "跟踪误差",
      score: s,
      weight: QUALITY_WEIGHTS.trackingErrorPct,
      note: `年化跟踪误差 ${input.trackingErrorPct.toFixed(2)}% → ${
        s >= 90 ? "贴合指数" : s >= 75 ? "正常" : "偏离较大"
      }`,
    });
  }

  if (input.feeRatePct != null) {
    const s = feeScore(input.feeRatePct);
    metrics.push({
      key: "fee",
      label: "总费率",
      score: s,
      weight: QUALITY_WEIGHTS.feeRatePct,
      note: `总费率 ${input.feeRatePct.toFixed(2)}% → ${
        s >= 90 ? "低费率" : s >= 75 ? "中等" : "偏高"
      }`,
    });
  }

  const evaluated = metrics.filter((m) => m.score != null);
  if (evaluated.length === 0) {
    notes.push("质量数据缺失，无法评估，按中性处理");
    return { score: null, grade: "?", metrics, notes };
  }

  const wsum = evaluated.reduce((s, m) => s + m.weight, 0);
  const score = clamp(
    evaluated.reduce((s, m) => s + (m.score ?? 0) * m.weight, 0) / wsum
  );

  if (score < 50) notes.push("ETF 工具属性偏弱（规模/流动性/费率），注意买卖冲击成本");

  return { score, grade: gradeFromScore(score), metrics, notes };
}

// ============================================================
// 综合评估
// ============================================================

export interface EvaluateInput {
  valuation: EtfValuationInput;
  quality: EtfQualityInput;
}

/**
 * 综合评估：趋势已给定，综合 = 估值(空间) × 0.55 + 质量(工具) × 0.45。
 * 任一层完全缺失时退化为仅用另一层，并提示。
 */
export function evaluateEtf(input: EvaluateInput): EtfEvaluation {
  const valuation = scoreValuation(input.valuation);
  const quality = scoreQuality(input.quality);

  const warnings: string[] = [];
  let totalScore: number | null = null;

  if (valuation.score != null && quality.score != null) {
    totalScore = clamp(
      valuation.score * COMBINED_WEIGHTS.valuation +
        quality.score * COMBINED_WEIGHTS.quality
    );
  } else if (valuation.score != null) {
    totalScore = valuation.score;
    warnings.push("质量数据缺失，仅按估值维度评估");
  } else if (quality.score != null) {
    totalScore = quality.score;
    warnings.push("估值数据缺失，仅按质量维度评估");
  } else {
    warnings.push("估值与质量数据均缺失，无法评估");
  }

  const grade: BuyGrade | "?" = totalScore != null ? gradeFromScore(totalScore) : "?";

  // 汇总各维度预警
  warnings.push(...valuation.notes.filter((n) => n.includes("偏贵") || n.includes("中性")));
  warnings.push(...quality.notes.filter((n) => n.includes("偏弱") || n.includes("风险")));
  // 折溢价单独提示
  if (
    input.quality.premiumDiscountPct != null &&
    input.quality.premiumDiscountPct > 0.5
  ) {
    warnings.push(
      `溢价 ${input.quality.premiumDiscountPct.toFixed(2)}% 偏高，避免追高买入`
    );
  }

  const summary = buildSummary(grade, totalScore, valuation, quality);

  return {
    valuation,
    quality,
    totalScore,
    grade,
    warnings: [...new Set(warnings)],
    summary,
  };
}

function buildSummary(
  grade: BuyGrade | "?",
  total: number | null,
  v: DimensionResult,
  q: DimensionResult
): string {
  const g = grade === "?" ? "未知" : grade;
  const scoreTxt = total != null ? total.toFixed(0) : "—";
  const vTxt = v.score != null ? v.score.toFixed(0) : "—";
  const qTxt = q.score != null ? q.score.toFixed(0) : "—";
  const gradeDesc: Record<string, string> = {
    A: "估值合理且工具优质，主升浪中值得重点配置",
    B: "性价比较好，可正常参与",
    C: "中性，建议控制仓位或等回调",
    D: "估值偏贵或工具属性弱，谨慎追高",
    "?": "数据不足，无法给出结论",
  };
  return `综合评级 ${g}（${scoreTxt}）｜估值 ${vTxt} · 质量 ${qTxt} —— ${gradeDesc[g]}`;
}
