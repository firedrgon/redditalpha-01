import { NextResponse } from "next/server";
import { getOrEvaluate } from "@/lib/etf-evaluate-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 首跑需并发抓东方财富，可能较慢，放宽到 60s */
export const maxDuration = 60;

/** 综合评级排序：A 最高、? 最低 */
const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, "?": 0 };

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = v != null ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function clampNum(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = v != null ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

interface Filters {
  top: number;
  minGrade: string;
  minValuationGrade: string;
  maxPePercentile: number; // 0 = 不限
  maxPbPercentile: number; // 0 = 不限
}

function applyFilters(
  payload: Awaited<ReturnType<typeof getOrEvaluate>>,
  f: Filters
) {
  let items = payload.items;
  const total = payload.items.length;

  // 综合评级门槛（整体 A/B/C/D）
  const minRank = f.minGrade ? GRADE_RANK[f.minGrade] : undefined;
  if (minRank != null) {
    items = items.filter(
      (it) =>
        it.evaluation.grade !== "?" &&
        (GRADE_RANK[it.evaluation.grade] ?? 0) >= minRank
    );
  }

  // 估值维度评级门槛（只看估值贵不贵）
  const minVRank = f.minValuationGrade ? GRADE_RANK[f.minValuationGrade] : undefined;
  if (minVRank != null) {
    items = items.filter(
      (it) =>
        it.evaluation.valuation.grade !== "?" &&
        (GRADE_RANK[it.evaluation.valuation.grade] ?? 0) >= minVRank
    );
  }

  // PE / PB 分位上限筛选。
  // 行为：cap>0 时开启。
  //   - 分位为 null（数据真缺失）→ 剔除并计入 missingPercentile（告知用户，不静默吞掉）
  //   - 分位非 null（无论「真实历史分位」还是「代理分位」）→ 按分位值判断：
  //       p<=cap 保留，否则剔除（计入 filteredOutByCap）
  // 关键：代理分位（proxy=true）也要参与筛选，否则主升浪池里最主流的
  // 沪深300/创业板等 ETF（其真实历史分位在源表缺失、被迫走代理）会被「排除在筛选外」，
  // 表现为「点合理≤60% 这些 ETF 凭空消失 / 点低估≤30% 列表几乎空」，即筛选不生效。
  // 代理分位不准的局限由前端「分位为估算」标注提示，不做逻辑层面的强行豁免。
  let filteredOutByCap = 0; // 分位超上限被剔除
  let missingPercentile = 0; // 分位数据缺失被剔除

  const applyPercentileCap = (
    getPct: (it: (typeof items)[number]) => number | null,
    cap: number
  ) => {
    if (cap <= 0) return;
    const kept: typeof items = [];
    for (const it of items) {
      const p = getPct(it);
      if (p == null) {
        missingPercentile++;
        continue;
      }
      if (p <= cap) kept.push(it);
      else filteredOutByCap++;
    }
    items = kept;
  };

  applyPercentileCap(
    (it) => it.fundData?.valuation.indexPePercentile ?? null,
    f.maxPePercentile
  );
  applyPercentileCap(
    (it) => it.fundData?.valuation.indexPbPercentile ?? null,
    f.maxPbPercentile
  );

  if (f.top < items.length) items = items.slice(0, f.top);
  return {
    ...payload,
    total,
    returned: items.length,
    filteredOutByCap,
    missingPercentile,
    items,
  };
}

/**
 * GET /api/etf-trend/evaluate
 * 主升浪池 ETF 的「估值 + 质量」综合评估（趋势/筛选由上游同花顺主升浪池给定）。
 * 查询参数：
 *   - top=N                 最多返回 N 只（按综合分降序，默认 500）
 *   - minGrade=A|B|C|D      综合评级不低于该档
 *   - minValuationGrade=A|B|C|D  估值维度评级不低于该档（只看贵不贵）
 *   - maxPePercentile=0~100 PE 历史分位上限（剔除过贵，0=不限）
 *   - maxPbPercentile=0~100 PB 历史分位上限（0=不限）
 * 缓存由 lib/etf-evaluate-cache 按主升浪池日期维护（POST 刷新后已预热）。
 * 公开接口（行情数据，无需登录）。
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const filters: Filters = {
      top: clampInt(searchParams.get("top"), 1, 500, 500),
      minGrade: (searchParams.get("minGrade") ?? "").toUpperCase(),
      minValuationGrade: (searchParams.get("minValuationGrade") ?? "").toUpperCase(),
      maxPePercentile: clampNum(searchParams.get("maxPePercentile"), 0, 100, 0),
      maxPbPercentile: clampNum(searchParams.get("maxPbPercentile"), 0, 100, 0),
    };
    const payload = await getOrEvaluate();
    return NextResponse.json(applyFilters(payload, filters));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 主升浪池无数据 → 404；其他 → 500
    const status = msg.includes("暂无") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
