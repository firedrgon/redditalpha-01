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
  // 关键修正：分位为 null（数据缺失）或 proxy=true（代理估算，不可信）的 ETF
  // 一律「不据此筛选」——既不通过也不静默消失，而是计入下方计数返回给前端提示，
  // 避免之前「点低估≤30% 结果几乎为空」的体验问题。
  let filteredOutUnknown = 0; // 分位为 null（数据缺失）
  let filteredOutEstimated = 0; // 分位为代理估算（不可信，不用于筛选）

  const applyPercentileCap = (
    getPct: (it: (typeof items)[number]) => number | null,
    isProxy: (it: (typeof items)[number]) => boolean,
    cap: number
  ) => {
    if (cap <= 0) return;
    const kept: typeof items = [];
    for (const it of items) {
      const p = getPct(it);
      if (p == null) {
        filteredOutUnknown++;
        continue;
      }
      if (isProxy(it)) {
        filteredOutEstimated++;
        continue;
      }
      if (p <= cap) kept.push(it);
    }
    items = kept;
  };

  applyPercentileCap(
    (it) => it.fundData?.valuation.indexPePercentile ?? null,
    (it) => it.fundData?.valuation.proxy === true,
    f.maxPePercentile
  );
  applyPercentileCap(
    (it) => it.fundData?.valuation.indexPbPercentile ?? null,
    (it) => it.fundData?.valuation.proxy === true,
    f.maxPbPercentile
  );

  if (f.top < items.length) items = items.slice(0, f.top);
  return {
    ...payload,
    total,
    returned: items.length,
    filteredOutUnknown,
    filteredOutEstimated,
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
