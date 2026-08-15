/**
 * ETF 主升浪「估值+质量」评估的缓存与预热。
 *
 * 把评估结果按「主升浪池日期」缓存在模块级 Map 里（per serverless instance），
 * 供两个路由共享：
 *   - GET /api/etf-trend/evaluate  读缓存，未命中则评估并写回
 *   - POST /api/etf-trend          手动刷新池后预热（warmEtfEvaluationCache），使刷新完评级即时可用
 *
 * 缓存时长按东方财富抓取成功率自适应：
 *   - 成功率 >= 50%：30 分钟（正常命中）
 *   - 成功率 < 50%（多为限流）：2 分钟，尽快重试，避免沉淀错误的「中性」评级
 */

import { getEtfTrendData, type EtfTrendItem } from "./etf-trend";
import { enrichEtfTrend, type EnrichedEtfTrendItem } from "./etf-evaluate-runner";

export interface EvalPayload {
  date: string;
  fetchedAt: string;
  evaluatedAt: string;
  /** 评估成功的 ETF 数（已按 code 去重） */
  count: number;
  items: EnrichedEtfTrendItem[];
}

const cache = new Map<string, { ts: number; ttl: number; payload: EvalPayload }>();
const LONG_TTL = 30 * 60 * 1000;
const SHORT_TTL = 120 * 1000;

/** 读当日缓存（命中且未过期返回 payload，否则清掉并返回 null） */
export function getCachedEval(date: string): EvalPayload | null {
  const c = cache.get(date);
  if (!c) return null;
  if (Date.now() - c.ts < c.ttl) return c.payload;
  cache.delete(date);
  return null;
}

function setCachedEval(date: string, payload: EvalPayload, okRate: number): void {
  cache.set(date, {
    ts: Date.now(),
    ttl: okRate >= 0.5 ? LONG_TTL : SHORT_TTL,
    payload,
  });
}

/** 读池 → 按 code 去重 → 并发评估 → 写缓存 → 返回 payload */
async function buildPayload(): Promise<EvalPayload> {
  const result = await getEtfTrendData();
  if (!result) throw new Error("暂无 ETF 主升浪数据，请先抓取主升浪池");

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

  // 抓取成功率决定缓存时长（限流时短缓存尽快重试）
  const okRate =
    enriched.filter((e) => e.fundData != null).length / (enriched.length || 1);
  setCachedEval(result.date, payload, okRate);
  return payload;
}

/**
 * 读缓存；未命中则评估并写回。供 GET 路由使用。
 * 抛错条件：主升浪池无数据（调用方映射为 404）。
 */
export async function getOrEvaluate(): Promise<EvalPayload> {
  const result = await getEtfTrendData();
  if (!result) throw new Error("暂无 ETF 主升浪数据，请先抓取主升浪池");
  const hit = getCachedEval(result.date);
  if (hit) return hit;
  return buildPayload();
}

/**
 * 预热：当日未缓存则评估一次；已缓存或失败则静默跳过。
 * 供 POST 刷新主升浪池后调用，使刷新完评级即时可用。
 */
export async function warmEtfEvaluationCache(): Promise<void> {
  const result = await getEtfTrendData();
  if (!result) return;
  if (getCachedEval(result.date)) return;
  try {
    await buildPayload();
  } catch {
    /* 预热失败不影响主流程 */
  }
}
