import { NextResponse } from "next/server";
import {
  fetchEtfFundData,
  fetchEtfNavHistory,
  fetchPeerEtfs,
  type EtfBoard,
} from "@/lib/etf-fund-data";
import {
  evaluateEtfSkill,
  type EtfGoal,
  type EtfSkillInput,
} from "@/lib/etf-skill-evaluate";
import { getEtfTrendData } from "@/lib/etf-trend";

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

/**
 * GET /api/etf-evaluate?code=510300&goal=growth
 * 独立 ETF 评估业务：对齐「ETF产品智能评估」技能 6 维框架
 *   （好资产 × 好价格 × 好运营 × 好时机 × 好匹配 × 好成本）
 * 数据源：东方财富（估值/质量/经理/公司）+ 同花顺主升浪池（好时机判定）。
 * 参数：
 *   - code  6 位 ETF 代码（必填，如 510300）
 *   - goal  growth|income|stable|balanced（可选，投资目标，用于好匹配维度）
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = (searchParams.get("code") ?? "").trim();
    const goalRaw = (searchParams.get("goal") ?? "").toLowerCase();
    const goal: EtfGoal = (VALID_GOALS as readonly string[]).includes(goalRaw)
      ? (goalRaw as ValidGoal)
      : null;

    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json(
        { error: "请输入 6 位 ETF 代码（如 510300）" },
        { status: 400 }
      );
    }
    const board = inferBoard(code);

    // 抓基金数据（best-effort，内部已对缺失项做中性处理）
    const fund = await fetchEtfFundData(code, board).catch(() => null);
    if (!fund) {
      return NextResponse.json(
        { error: "基金数据抓取失败，请稍后重试" },
        { status: 502 }
      );
    }

    // 净值历史 + 同类 ETF 对比（best-effort，缺则报告降级，不阻塞评估）
    const [nav, peers] = await Promise.all([
      fetchEtfNavHistory(code).catch(() => null),
      fetchPeerEtfs(fund.raw.trackIndexName, code).catch(() => null),
    ]);

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
      valuation: fund.valuation,
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

    return NextResponse.json({
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
        navNow: nav?.navNow ?? null,
      },
      nav: nav,
      peers: peers,
      evaluation,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
