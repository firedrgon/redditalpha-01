import { NextResponse } from "next/server";
import { getOrEvaluate } from "@/lib/etf-evaluate-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 首跑需并发抓东方财富，可能较慢，放宽到 60s */
export const maxDuration = 60;

/** 评级排序：A 最高、? 最低 */
const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, "?": 0 };

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = v != null ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function applyFilters(
  payload: Awaited<ReturnType<typeof getOrEvaluate>>,
  top: number,
  minGrade: string
) {
  let items = payload.items;
  const minRank = minGrade ? GRADE_RANK[minGrade] : undefined;
  if (minRank != null) {
    items = items.filter(
      (it) =>
        it.evaluation.grade !== "?" &&
        (GRADE_RANK[it.evaluation.grade] ?? 0) >= minRank
    );
  }
  const total = payload.items.length;
  if (top < items.length) items = items.slice(0, top);
  return { ...payload, total, returned: items.length, items };
}

/**
 * GET /api/etf-trend/evaluate
 * 主升浪池 ETF 的「估值 + 质量」综合评估（趋势/筛选由上游同花顺主升浪池给定）。
 * 查询参数：
 *   - top=N        最多返回 N 只（按综合分降序，默认 500）
 *   - minGrade=A|B|C|D  仅返回评级不低于该档的 ETF
 * 缓存由 lib/etf-evaluate-cache 按主升浪池日期维护（POST 刷新后已预热）。
 * 公开接口（行情数据，无需登录）。
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const top = clampInt(searchParams.get("top"), 1, 500, 500);
    const minGrade = (searchParams.get("minGrade") ?? "").toUpperCase();

    const payload = await getOrEvaluate();
    return NextResponse.json(applyFilters(payload, top, minGrade));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 主升浪池无数据 → 404；其他 → 500
    const status = msg.includes("暂无") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
