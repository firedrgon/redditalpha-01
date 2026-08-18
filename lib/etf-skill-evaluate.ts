/**
 * ETF 产品智能评估（对齐「ETF产品智能评估」技能 6 维框架）
 *
 * 核心公式：ETF 投资价值 = 好资产 × 好价格 × 好运营 × 好时机 × 好匹配 × 好成本
 *
 * 复用 lib/etf-evaluate.ts 的底层打分函数（估值/质量/费用/规模/流动性/跟踪误差等），
 * 新增 4 项技能要求、现有模块缺失的维度：
 *   - 好资产（asset）：跟踪指数类型（宽基/行业/策略）分散度
 *   - 好运营（operation）：基金公司实力 / 经理 / 成立年限
 *   - 好时机（timing）：是否处于主升浪（复用同花顺主升浪池判定）
 *   - 好匹配（match）：用户输入的投资目标（增长/收入/稳健/均衡）与 ETF 属性契合度
 * 纯函数，无网络依赖；所有输入可 null，缺失项中性处理不崩。评分 0~100 越高越好。
 *
 * 注意：数据源沿用东方财富 / 腾讯（与技能的 AkShare/yfinance 不同引擎，但维度一致）。
 * 免费源限制见 MEMORY：沪深300/创业板等无真实历史分位，走代理分位并标注「估算」。
 */

import {
  clamp,
  gradeFromScore,
  scoreValuation,
  scoreQuality,
  type MetricScore,
  type DimensionResult,
  type BuyGrade,
  type EtfValuationInput,
  type EtfQualityInput,
} from "./etf-evaluate";
import type { IndexType } from "./etf-fund-data";

export type EtfGoal = "growth" | "income" | "stable" | "balanced" | null;

export interface EtfSkillInput {
  /** 好资产：跟踪标的与类型 */
  asset: { trackIndexName: string | null; indexType: IndexType };
  /** 好价格：估值（复用 EtfValuationInput） */
  valuation: EtfValuationInput;
  /** 好运营：基金公司 / 经理 / 成立年限 */
  operation: {
    fundCompany: string | null;
    fundManager: string | null;
    establishYears: number | null;
  };
  /** 好时机：是否主升浪 */
  timing: { inUpTrend: boolean | null; category: "pullback" | "newPool" | null };
  /** 好匹配：用户投资目标 */
  match: { goal: EtfGoal };
  /** 好成本：ETF 工具属性（规模/流动性/折溢价/误差/费率） */
  quality: EtfQualityInput;
}

export type SkillDimKey = "asset" | "price" | "operation" | "timing" | "match" | "cost";

export interface SkillDimension {
  key: SkillDimKey;
  label: string;
  score: number | null;
  grade: BuyGrade | "?";
  metrics: MetricScore[];
  note: string;
}

export interface EtfSkillEvaluation {
  dimensions: SkillDimension[];
  totalScore: number | null;
  grade: BuyGrade | "?";
  warnings: string[];
  suggestions: string[];
  summary: string;
}

/** 头部基金公司白名单（好运营：公司实力加分） */
const TOP_FUND_COMPANIES = [
  "易方达", "华夏", "嘉实", "南方", "博时", "广发", "富国", "华泰柏瑞", "汇添富",
  "招商", "工银瑞信", "华安", "国泰", "银华", "鹏华", "天弘", "建信", "兴全",
  "中欧", "景顺长城",
];

// ============================================================
// 好资产（指数分散度）
// ============================================================
function scoreAsset(input: EtfSkillInput["asset"]): DimensionResult {
  const t = input.indexType;
  if (!t) {
    return {
      score: null,
      grade: "?",
      metrics: [],
      notes: ["跟踪指数类型未知，无法评估资产分散度"],
    };
  }
  const map: Record<Exclude<IndexType, null>, { s: number; desc: string; label: string }> = {
    broad: { s: 90, desc: "宽基指数，分散透明、代表市场整体，单一标的暴雷风险低", label: "指数分散度（宽基）" },
    strategy: { s: 80, desc: "策略指数，有明确因子逻辑（红利/低波/价值等），风格稳定", label: "策略逻辑" },
    sector: { s: 65, desc: "行业/主题指数，集中度高、弹性大但波动也大", label: "行业集中度" },
  };
  const v = map[t];
  return {
    score: v.s,
    grade: gradeFromScore(v.s),
    metrics: [{ key: "asset", label: v.label, score: v.s, weight: 1, note: v.desc }],
    notes: [],
  };
}

// ============================================================
// 好运营（基金公司 / 经理 / 年限）
// ============================================================
function scoreOperation(input: EtfSkillInput["operation"]): DimensionResult {
  const metrics: MetricScore[] = [];

  const isTop =
    input.fundCompany != null &&
    TOP_FUND_COMPANIES.some((c) => input.fundCompany!.includes(c));
  const companyScore = input.fundCompany == null ? null : isTop ? 90 : 75;
  if (companyScore != null) {
    metrics.push({
      key: "company",
      label: "基金公司实力",
      score: companyScore,
      weight: 0.5,
      note: `${input.fundCompany}${isTop ? "（头部基金公司，投研能力强）" : "（非头部，关注跟踪与运作能力）"}`,
    });
  }

  if (input.establishYears != null) {
    const s =
      input.establishYears >= 10
        ? 100
        : input.establishYears >= 5
        ? 85
        : input.establishYears >= 3
        ? 70
        : input.establishYears >= 1
        ? 55
        : 40;
    metrics.push({
      key: "age",
      label: "成立年限",
      score: s,
      weight: 0.4,
      note: `成立 ${input.establishYears} 年 → ${
        s >= 85 ? "运作成熟稳定" : s >= 70 ? "运作较稳定" : "相对年轻，历史较短"
      }`,
    });
  }

  if (input.fundManager != null) {
    metrics.push({
      key: "mgr",
      label: "基金经理",
      score: 80,
      weight: 0.1,
      note: `现任经理：${input.fundManager}`,
    });
  }

  if (metrics.length === 0) {
    return {
      score: null,
      grade: "?",
      metrics,
      notes: ["基金公司/经理信息缺失，无法评估运营质量"],
    };
  }
  const ev = metrics.filter((m) => m.score != null);
  const wsum = ev.reduce((s, m) => s + m.weight, 0);
  const score = clamp(ev.reduce((s, m) => s + (m.score ?? 0) * m.weight, 0) / wsum);
  return { score, grade: gradeFromScore(score), metrics, notes: [] };
}

// ============================================================
// 好时机（主升浪趋势）
// ============================================================
function scoreTiming(input: EtfSkillInput["timing"]): DimensionResult {
  if (input.inUpTrend == null) {
    return {
      score: null,
      grade: "?",
      metrics: [],
      notes: ["该 ETF 未纳入主升浪池，入场时机需结合技术面/大盘环境自行判断"],
    };
  }
  const s = input.inUpTrend ? (input.category === "pullback" ? 88 : 82) : 50;
  const label = input.inUpTrend
    ? `处于主升浪（${input.category === "pullback" ? "趋势回踩，买点更佳" : "新入池"}）`
    : "不在主升浪趋势中";
  return {
    score: s,
    grade: gradeFromScore(s),
    metrics: [{ key: "timing", label: "趋势时机", score: s, weight: 1, note: label }],
    notes: input.inUpTrend ? [] : ["当前未处于主升浪，时机一般"],
  };
}

// ============================================================
// 好匹配（投资目标契合度）
// ============================================================
function scoreMatch(
  input: EtfSkillInput["match"],
  asset: EtfSkillInput["asset"],
  valuation: EtfValuationInput
): DimensionResult {
  if (!input.goal) {
    return {
      score: null,
      grade: "?",
      metrics: [],
      notes: ["未选择投资目标，跳过匹配度评估"],
    };
  }
  const goalName: Record<Exclude<EtfGoal, null>, string> = {
    growth: "长期增长",
    income: "收入/分红",
    stable: "稳健",
    balanced: "均衡",
  };
  const idx = asset.trackIndexName ?? "";
  const div = valuation.dividendYieldPct ?? 0;
  let s = 65;
  let why = "";

  if (input.goal === "income") {
    if (idx.includes("红利") || div >= 2.5) {
      s = 90;
      why = "高股息/红利属性，契合收入目标";
    } else if (asset.indexType === "broad") {
      s = 70;
      why = "宽基分红中等，基本契合收入目标";
    } else {
      s = 45;
      why = "偏成长/行业，分红较弱，与收入目标匹配度低";
    }
  } else if (input.goal === "growth") {
    if (
      asset.indexType === "sector" ||
      idx.includes("成长") ||
      idx.includes("科技") ||
      idx.includes("创业")
    ) {
      s = 85;
      why = "成长/行业属性，契合长期增长";
    } else if (asset.indexType === "broad") {
      s = 80;
      why = "宽基长期复利，契合增长目标";
    } else {
      s = 65;
      why = "偏价值/红利，增长弹性有限";
    }
  } else if (input.goal === "stable") {
    if (asset.indexType === "broad" || idx.includes("红利") || idx.includes("低波")) {
      s = 85;
      why = "宽基/红利/低波，波动可控，契合稳健";
    } else if (asset.indexType === "strategy") {
      s = 78;
      why = "策略指数相对稳健";
    } else {
      s = 45;
      why = "单一行业波动大，与稳健目标匹配度低";
    }
  } else {
    // balanced
    if (asset.indexType === "broad" || asset.indexType === "strategy") {
      s = 85;
      why = "宽基/策略，分散均衡";
    } else {
      s = 65;
      why = "单一行业，集中度偏高，均衡性一般";
    }
  }

  return {
    score: s,
    grade: gradeFromScore(s),
    metrics: [
      {
        key: "match",
        label: `匹配「${goalName[input.goal]}」`,
        score: s,
        weight: 1,
        note: why,
      },
    ],
    notes: [],
  };
}

// ============================================================
// 综合：6 维加权
// ============================================================
const SKILL_WEIGHTS: Record<SkillDimKey, number> = {
  asset: 0.15,
  price: 0.25,
  operation: 0.15,
  timing: 0.1,
  match: 0.1,
  cost: 0.25,
};

export function evaluateEtfSkill(input: EtfSkillInput): EtfSkillEvaluation {
  const asset = scoreAsset(input.asset);
  const price = scoreValuation(input.valuation); // 好价格
  const operation = scoreOperation(input.operation);
  const timing = scoreTiming(input.timing);
  const match = scoreMatch(input.match, input.asset, input.valuation);
  const cost = scoreQuality(input.quality); // 好成本

  const dims: SkillDimension[] = [
    { key: "asset", label: "好资产", score: asset.score, grade: asset.grade, metrics: asset.metrics, note: asset.notes[0] ?? "" },
    { key: "price", label: "好价格", score: price.score, grade: price.grade, metrics: price.metrics, note: price.notes[0] ?? "" },
    { key: "operation", label: "好运营", score: operation.score, grade: operation.grade, metrics: operation.metrics, note: operation.notes[0] ?? "" },
    { key: "timing", label: "好时机", score: timing.score, grade: timing.grade, metrics: timing.metrics, note: timing.notes[0] ?? "" },
    { key: "match", label: "好匹配", score: match.score, grade: match.grade, metrics: match.metrics, note: match.notes[0] ?? "" },
    { key: "cost", label: "好成本", score: cost.score, grade: cost.grade, metrics: cost.metrics, note: cost.notes[0] ?? "" },
  ];

  // 综合：按权重加权（仅对非空维度），缺失维度不参与（权重按比例归一化）
  const evaluated = dims.filter((d) => d.score != null);
  let totalScore: number | null = null;
  if (evaluated.length > 0) {
    const wsum = evaluated.reduce((s, d) => s + SKILL_WEIGHTS[d.key], 0);
    totalScore = clamp(
      evaluated.reduce((s, d) => s + (d.score ?? 0) * SKILL_WEIGHTS[d.key], 0) / wsum
    );
  }
  const grade: BuyGrade | "?" = totalScore != null ? gradeFromScore(totalScore) : "?";

  // 风险预警
  const warnings: string[] = [];
  if (asset.score != null && asset.score < 65) warnings.push("跟踪单一行业/主题，集中度偏高");
  if (price.score != null && price.score < 40) warnings.push("估值偏贵，上行空间有限");
  if (operation.score != null && operation.score < 60) warnings.push("基金运营质量偏弱（公司/年限/经理）");
  if (timing.score != null && timing.score < 60) warnings.push("当前未处于主升浪，时机一般");
  if (cost.score != null && cost.score < 60) warnings.push("ETF 工具属性偏弱（规模/流动性/费率）");
  const missing = dims.filter((d) => d.score == null).map((d) => d.label);
  if (missing.length) warnings.push(`以下维度数据缺失未计入：${missing.join("、")}`);

  // 组合建议（分散投资 / 成本 / 估值 / 时机）
  const suggestions: string[] = [];
  if (asset.score != null && asset.score < 70)
    suggestions.push("该 ETF 集中度较高，建议与宽基 ETF 组合以分散风险，避免单行业押注。");
  if (cost.score != null) {
    const fee = input.quality.feeRatePct ?? null;
    if (fee != null && fee > 0.5)
      suggestions.push(`总费率 ${fee.toFixed(2)}% 偏高，长期持有成本需注意，可对比同类低费率产品。`);
  }
  if (price.score != null && price.score < 50)
    suggestions.push("当前估值分位偏高，建议分批建仓或等待回调，勿一次性追高。");
  if (timing.score == null)
    suggestions.push("该 ETF 未纳入主升浪池，入场时机请结合技术面与大盘环境自行判断。");
  if (operation.score != null && operation.score < 60)
    suggestions.push("基金公司或成立年限偏弱，建议关注规模与清盘/流动性风险。");
  suggestions.push("不要把所有资金集中于单只 ETF，按风险承受配置「宽基 + 行业 + 策略」组合更稳健。");

  const summary = buildSkillSummary(grade, totalScore, dims);
  return {
    dimensions: dims,
    totalScore,
    grade,
    warnings: [...new Set(warnings)],
    suggestions,
    summary,
  };
}

function buildSkillSummary(
  grade: BuyGrade | "?",
  total: number | null,
  dims: SkillDimension[]
): string {
  const g = grade === "?" ? "未知" : grade;
  const scoreTxt = total != null ? total.toFixed(0) : "—";
  const parts = dims
    .filter((d) => d.score != null)
    .map((d) => `${d.label}${d.score!.toFixed(0)}`)
    .join(" · ");
  const gradeDesc: Record<string, string> = {
    A: "综合优秀，可重点考虑",
    B: "性价比较好，可正常参与",
    C: "中性，建议控制仓位或等回调",
    D: "偏弱，谨慎追高",
    "?": "数据不足，无法给出结论",
  };
  return `综合评级 ${g}（${scoreTxt}）｜${parts} —— ${gradeDesc[g]}`;
}
