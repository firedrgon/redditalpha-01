"use client";

/**
 * 「公司质地打分」本地记录（localStorage）。
 *
 * 用途：在 A股热榜 / 收藏列表快速判断「这只是否已打过分」。
 * - 已打分 → 列表展示评分徽章（点击跳转 /stock-quality 看详情）
 * - 未打分 → 列表展示「去打分」按钮（点击跳转去打分）
 *
 * 设计取舍：用 localStorage 而非服务端落库，避免引入 Prisma schema 迁移
 * （项目生产库存在 schema 漂移坑）。打分功能本身无状态、按浏览器记录即可满足
 * 「打分过就展示」的交互需求。如需跨设备共享，后续可改为服务端缓存表。
 */

const KEY = "ra_quality_scores_v1";

export interface QualityScoreEntry {
  ticker: string;
  totalScore: number;
  level: string;
  updatedAt: number;
}

/** 列表/卡片监听此事件，在另一处打完分后即时刷新徽章 */
export const QUALITY_SCORES_EVENT = "ra-quality-scores-updated";

function normalize(t: string): string | null {
  const s = (t || "").trim().toUpperCase();
  return /^\d{6}(\.(SH|SZ|BJ))?$/.test(s) ? s : null;
}

function readAll(): Record<string, QualityScoreEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, QualityScoreEntry>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, QualityScoreEntry>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
}

export function getQualityScore(ticker: string): QualityScoreEntry | null {
  const k = normalize(ticker);
  return k ? readAll()[k] ?? null : null;
}

export function getAllQualityScores(): Record<string, QualityScoreEntry> {
  return readAll();
}

/** 打分成功后写入；统一规范为 6 位 + 交易所后缀大写，并广播事件 */
export function saveQualityScore(
  ticker: string,
  totalScore: number,
  level: string
) {
  const k = normalize(ticker);
  if (!k) return;
  const map = readAll();
  map[k] = { ticker: k, totalScore, level, updatedAt: Date.now() };
  writeAll(map);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUALITY_SCORES_EVENT));
  }
}
