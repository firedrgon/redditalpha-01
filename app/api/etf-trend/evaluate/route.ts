import { NextResponse } from "next/server";
import { getEtfTrendData, type EtfTrendItem } from "@/lib/etf-trend";
import { enrichEtfTrend, type EnrichedEtfTrendItem } from "@/lib/etf-evaluate-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 首跑需并发抓东方财富，可能较慢，放宽到 60s */
export const maxDuration = 60;

interface EvalPayload {
  date: string;
  fetchedAt: string;
  evaluatedAt: string;
  /** 评估成功的 ETF 数（已按 code 去重） */
  count: number;
  items: EnrichedEtfTrendItem[];
}

/**
 * 按日期缓存评估结果：同一交易日只抓一次东方财富。
 * - 抓取成功率 >= 50%：缓存 30 分钟（正常命中）
 * - 抓取成功率 < 50%（多为东方财富限流）：短缓存 2 分钟，尽快重试
 */
const cache = new Map<string, { ts: number; ttl: number; payload: EvalPayload }>();
const LONG_TTL = 30 * 60 * 1000;
const SHORT_TTL = 120 * 1000;

/** 评级排序：A 最高、? 最低 */
const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, "?": 0 };

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = v != null ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function applyFilters(payload: EvalPayload, top: number, minGrade: string) {
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
 * 公开接口（行情数据，无需登录）。
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const top = clampInt(searchParams.get("top"), 1, 500, 500);
    const minGrade = (searchParams.get("minGrade") ?? "").toUpperCase();

    const result = await getEtfTrendData();
    if (!result) {
      return NextResponse.json(
        { error: "暂无 ETF 主升浪数据，请先抓取主升浪池（盘前定时或手动刷新）" },
        { status: 404 }
      );
    }

    // 命中当日缓存 → 直接返回（应用 top/minGrade 后）
    const cached = cache.get(result.date);
    if (cached && Date.now() - cached.ts < cached.ttl) {
      return NextResponse.json(applyFilters(cached.payload, top, minGrade));
    }

    // 同一 ETF 可能同时出现在 pullback 与 newPool，按 code 去重后只评估一次
    const seen = new Set<string>();
    const unique: EtfTrendItem[] = [];
    for (const it of [...result.pullback, ...result.newPool]) {
      if (seen.has(it.code)) continue;
      seen.add(it.code);
      unique.push(it);
    }

    const enriched = await enrichEtfTrend(unique, 6);

    const payload: EvalPayload = {
      date: result.date,
      fetchedAt: result.fetchedAt,
      evaluatedAt: new Date().toISOString(),
      count: enriched.length,
      items: enriched,
    };

    // 抓取成功率决定缓存时长（限流时短缓存尽快重试，避免沉淀错误中性结果）
    const okRate =
      enriched.filter((e) => e.fundData != null).length / (enriched.length || 1);
    cache.set(result.date, {
      ts: Date.now(),
      ttl: okRate >= 0.5 ? LONG_TTL : SHORT_TTL,
      payload,
    });

    return NextResponse.json(applyFilters(payload, top, minGrade));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
