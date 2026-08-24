import { NextResponse } from "next/server";
import {
  fetchEtfFundData,
  fetchEtfNavHistory,
  fetchPeerEtfs,
  fetchEtfProfile,
  fetchEtfCcmx,
  type EtfBoard,
  type FundProfile,
  type EtfHolding,
} from "@/lib/etf-fund-data";
import {
  fetchThsIndexBundle,
  navDerivatives,
  computeNavPriceScore,
  type IndexBundle,
} from "@/lib/etf-index-metrics";
import {
  evaluateEtfSkill,
  type EtfGoal,
  type EtfSkillEvaluation,
  type EtfSkillInput,
} from "@/lib/etf-skill-evaluate";
import { getEtfTrendData } from "@/lib/etf-trend";
import { getPrisma } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 首跑需并发抓东方财富，可能较慢，放宽到 60s */
export const maxDuration = 60;

/** 6 位 ETF 代码 → 沪/深：5/6 开头沪，1 开头深 */
function inferBoard(code: string): EtfBoard {
  if (/^[56]/.test(code)) return "SH";
  if (/^1/.test(code)) return "SZ";
  return null;
}

const VALID_GOALS = ["growth", "income", "stable", "balanced"] as const;
type ValidGoal = (typeof VALID_GOALS)[number];

/** 评估流程中可预期的业务错误（带 HTTP 状态码），与未预期的 500 区分 */
class EvaluationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** /api/etf-evaluate 的正常响应体（不含缓存标记字段） */
type EvaluateResult = {
  code: string;
  name: string | null;
  board: EtfBoard;
  goal: EtfGoal;
  fund: Record<string, unknown>;
  nav: unknown;
  peers: unknown;
  /** 基金信息全表（好运营维度） */
  profile: FundProfile | null;
  /** 前十大持仓（东财 ccmx） */
  holdings: EtfHolding[] | null;
  /** 同花顺指数（行业/标准 proxy）成分股 + 历史 K 线衍生指标 */
  thsIndex: IndexBundle | null;
  /** 东财 NAV 衍生指标（与指数 proxy 交叉对照） */
  navDeriv: {
    yearlyReturns: { year: string; returnPct: number }[];
    holdingPeriod: {
      months: number;
      profitRatio: number | null;
      avgReturnPct: number | null;
      samples: number;
    }[];
    sharpe: number | null;
    winRate: number | null;
  } | null;
  /** 好匹配·流动性指标 */
  liquidity: {
    dailyTurnoverWan: number | null;
    turnoverRatePct: number | null;
    floatScaleYi: number | null;
    premiumDiscountPct: number | null;
  } | null;
  evaluation: EtfSkillEvaluation;
};

/**
 * 真正执行一次评估：抓东方财富基金数据 + 净值/同类 + 同花顺主升浪池，再跑六维评分。
 * 失败以 EvaluationError 抛出（带状态码）；best-effort 的子项（nav/peers/trend）缺失不阻塞。
 */
async function computeEtfEvaluation(
  code: string,
  board: EtfBoard,
  goal: EtfGoal
): Promise<EvaluateResult> {
  // 抓基金数据（best-effort，内部已对缺失项做中性处理）
  const fund = await fetchEtfFundData(code, board).catch(() => null);
  if (!fund) {
    throw new EvaluationError(502, "基金数据抓取失败，请稍后重试");
  }

  // 净值历史 + 同类 ETF 对比 + 信息全表 + 前十大持仓 + 同花顺指数（best-effort，缺则降级，不阻塞评估）
  const [nav, peers, profile, holdings, thsIndex] = await Promise.all([
    fetchEtfNavHistory(code).catch(() => null),
    fetchPeerEtfs(fund.raw.trackIndexName, code).catch(() => null),
    fetchEtfProfile(code).catch(() => null),
    fetchEtfCcmx(code).catch(() => null),
    fetchThsIndexBundle(fund.raw.trackIndexName, fund.name).catch(() => null),
  ]);
  const navDeriv = navDerivatives(nav);
  // 好价格兜底：当指数 PE/PB 分位与股息率都取不到时，用净值历史推导「当前价格吸引力」
  const navPriceScore = computeNavPriceScore(nav);

  // 好时机：查该 ETF 是否处于同花顺主升浪池（DB 读取，轻量）
  let inUpTrend: boolean | null = null;
  let category: "pullback" | "newPool" | null = null;
  try {
    const trend = await getEtfTrendData();
    const all = [...(trend?.pullback ?? []), ...(trend?.newPool ?? [])];
    const hit = all.find((it) => it.code === code);
    inUpTrend = hit ? true : false;
    category = hit?.category ?? null;
  } catch {
    inUpTrend = null; // 主升浪数据不可用时中性，不阻塞评估
  }

  const input: EtfSkillInput = {
    asset: { trackIndexName: fund.raw.trackIndexName, indexType: fund.indexType },
    valuation: { ...fund.valuation, navPriceScore },
    operation: {
      fundCompany: fund.fundCompany,
      fundManager: fund.fundManager,
      establishYears: fund.establishYears,
    },
    timing: { inUpTrend, category },
    match: { goal },
    quality: fund.quality,
  };

  const evaluation = evaluateEtfSkill(input);

  // 好匹配·流动性：换手率 = 日成交额(万元) / 流通市值(亿元) → %
  // 流通市值以 ETF 最新规模近似（ETF 份额全流通）；量比(f170)实测为脏值故不取。
  const liqTurnover =
    fund.raw.dailyTurnoverWan != null && fund.raw.scaleYi && fund.raw.scaleYi > 0
      ? (fund.raw.dailyTurnoverWan * 100) / (fund.raw.scaleYi * 1e4)
      : null;

  return {
    code,
    name: fund.name,
    board,
    goal,
    fund: {
      fundCompany: fund.fundCompany,
      fundManager: fund.fundManager,
      establishDate: fund.establishDate,
      trackIndexName: fund.raw.trackIndexName,
      indexType: fund.indexType,
      proxy: fund.raw.proxy,
      feeRatePct: fund.raw.feeRatePct,
      scaleYi: fund.raw.scaleYi,
      indexPe: fund.raw.indexPe,
      indexPb: fund.raw.indexPb,
      indexPePercentile: fund.valuation.indexPePercentile,
      indexPbPercentile: fund.valuation.indexPbPercentile,
      dividendYieldPct: fund.valuation.dividendYieldPct,
      navPriceScore,
      navNow: nav?.navNow ?? null,
      trackingErrorPct: fund.raw.trackingErrorPct,
    },
    nav,
    peers,
    profile,
    holdings,
    thsIndex,
    navDeriv,
    liquidity: {
      dailyTurnoverWan: fund.raw.dailyTurnoverWan,
      turnoverRatePct: liqTurnover,
      floatScaleYi: fund.raw.scaleYi,
      premiumDiscountPct: fund.raw.premiumDiscountPct,
    },
    evaluation,
  };
}

/**
 * GET /api/etf-evaluate?code=510300&goal=growth[&refresh=1]
 * 独立 ETF 评估业务：对齐「ETF产品智能评估」技能 6 维框架
 *   （好资产 × 好价格 × 好运营 × 好时机 × 好匹配 × 好成本）
 * 数据源：东方财富（估值/质量/经理/公司）+ 同花顺主升浪池（好时机判定）。
 *
 * 缓存策略：
 *   - 默认优先返回数据库缓存（按 code+goal 唯一），避免每次进入页面都重抓重算。
 *   - 传 refresh=1 时强制重算并覆盖缓存（前端「重新分析」按钮使用）。
 *   - 未配置 DATABASE_URL（本地内存模式）时自动跳过缓存，每次实时计算。
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = (searchParams.get("code") ?? "").trim();
    const goalRaw = (searchParams.get("goal") ?? "").toLowerCase();
    const refresh = searchParams.get("refresh") === "1" || searchParams.get("refresh") === "true";
    const goal: EtfGoal = (VALID_GOALS as readonly string[]).includes(goalRaw)
      ? (goalRaw as ValidGoal)
      : null;
    const goalKey = goal ?? "";

    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json(
        { error: "请输入 6 位 ETF 代码（如 510300）" },
        { status: 400 }
      );
    }
    const board = inferBoard(code);

    const prisma = getPrisma();

    // 1) 非强制刷新：尝试读取缓存
    if (!refresh && prisma) {
      const hit = await prisma.etfEvaluateCache
        .findUnique({ where: { code_goal: { code, goal: goalKey } } })
        .catch(() => null);
      if (hit?.dataJson) {
        try {
          const parsed = JSON.parse(hit.dataJson);
          // 缓存自愈：早期版本曾因指数 PE/PB 取数 0 污染，把「好价格」维度算成 null 并缓存。
          // 若缓存的好价格维度为空（坏快照），不服务缓存、强制重算以自愈。
          const dims: { key?: string; score?: number | null }[] =
            parsed?.evaluation?.dimensions ?? [];
          const priceStale = dims.some(
            (d) => d.key === "price" && d.score == null
          );
          if (!priceStale) {
            return NextResponse.json({
              ...parsed,
              cached: true,
              cachedAt: hit.updatedAt ? hit.updatedAt.toISOString() : null,
            });
          }
        } catch {
          // JSON 损坏：忽略缓存，走实时计算兜底
        }
      }
    }

    // 2) 实时计算
    let result: EvaluateResult;
    try {
      result = await computeEtfEvaluation(code, board, goal);
    } catch (err) {
      if (err instanceof EvaluationError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    // 3) 写回缓存（best-effort，失败不影响本次响应）
    if (prisma) {
      await prisma.etfEvaluateCache
        .upsert({
          where: { code_goal: { code, goal: goalKey } },
          create: {
            code,
            goal: goalKey,
            name: result.name,
            dataJson: JSON.stringify(result),
            grade: result.evaluation.grade,
            totalScore: result.evaluation.totalScore,
          },
          update: {
            name: result.name,
            dataJson: JSON.stringify(result),
            grade: result.evaluation.grade,
            totalScore: result.evaluation.totalScore,
          },
        })
        .catch(() => {});
    }

    return NextResponse.json({ ...result, cached: false, cachedAt: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
