/**
 * 指数 / 净值衍生指标计算 + 同花顺指数数据编排。
 *
 * 纯函数（输入 {t, close} 序列）用于：
 *  - 年度收益表（calendar-year return）
 *  - 持有期盈利概率（6/12/24/36 月窗口）
 *  - 月度表现
 *  - Sharpe / 日胜率 / 趋势（同比、近3月）
 *
 * fetchThsIndexBundle：把「ETF 跟踪指数名」经同花顺解析为行业/标准指数 thscode，
 * 抓成分股 + 历史 K 线，算出上述指数级指标（好资产/好价格/好时机 维度用）。
 * navDerivatives：对东财 NAV 序列算同类 ETF 自身指标（与指数 proxy 交叉对照）。
 */

import {
  fetchIndexConstituents,
  fetchIndexKline,
  resolveIndustryIndexThsCode,
  type ThsConstituent,
} from "./ths";
import type { EtfNavHistory } from "./etf-fund-data";

export interface YearlyReturn {
  year: string;
  returnPct: number;
}
export interface HoldingPeriodStat {
  months: number;
  /** 盈利窗口占比 %（>0 收益的频率） */
  profitRatio: number | null;
  /** 平均收益率 % */
  avgReturnPct: number | null;
  /** 有效窗口数 */
  samples: number;
}
export interface MonthlyPerf {
  month: string;
  returnPct: number;
}

interface Pt {
  t: number;
  close: number;
}

function toPts(dates: string[], closes: number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < dates.length && i < closes.length; i++) {
    const t = Date.parse(dates[i] + "T00:00:00+08:00");
    const c = closes[i];
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) out.push({ t, close: c });
  }
  return out;
}

export function yearlyReturns(pts: Pt[]): YearlyReturn[] {
  if (pts.length < 2) return [];
  const byYear = new Map<string, { first: number; last: number }>();
  for (const p of pts) {
    const y = new Date(p.t + 8 * 3600 * 1000).getUTCFullYear().toString();
    const cur = byYear.get(y);
    if (!cur) byYear.set(y, { first: p.close, last: p.close });
    else cur.last = p.close;
  }
  const out: YearlyReturn[] = [];
  for (const [y, v] of [...byYear.entries()].sort()) {
    if (v.first > 0) out.push({ year: y, returnPct: (v.last / v.first - 1) * 100 });
  }
  return out;
}

function addMonths(t: number, m: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + m, d.getDate()).getTime();
}

export function holdingPeriodProfit(pts: Pt[], months: number[]): HoldingPeriodStat[] {
  if (pts.length < 2) return [];
  return months.map((mo) => {
    let profit = 0;
    let total = 0;
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const target = addMonths(pts[i].t, mo);
      let j = i + 1;
      while (j < pts.length && pts[j].t < target) j++;
      if (j >= pts.length) break;
      const ret = pts[j].close / pts[i].close - 1;
      if (!Number.isFinite(ret)) continue;
      total++;
      if (ret > 0) profit++;
      sum += ret;
    }
    return {
      months: mo,
      profitRatio: total ? (profit / total) * 100 : null,
      avgReturnPct: total ? (sum / total) * 100 : null,
      samples: total,
    };
  });
}

export function sharpe(pts: Pt[], riskFreePct = 2.5): number | null {
  if (pts.length < 20) return null;
  const rets: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const r = pts[i].close / pts[i - 1].close - 1;
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length;
  const sd = Math.sqrt(variance);
  if (sd <= 0) return null;
  const rfDaily = riskFreePct / 100 / 252;
  return ((mean - rfDaily) / sd) * Math.sqrt(252);
}

export function winRate(pts: Pt[]): number | null {
  if (pts.length < 2) return null;
  let up = 0;
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    const r = pts[i].close / pts[i - 1].close - 1;
    if (!Number.isFinite(r)) continue;
    n++;
    if (r > 0) up++;
  }
  return n ? (up / n) * 100 : null;
}

export function monthlyPerf(pts: Pt[]): MonthlyPerf[] {
  if (pts.length < 2) return [];
  const byMonth = new Map<string, { first: number; last: number }>();
  for (const p of pts) {
    const d = new Date(p.t + 8 * 3600 * 1000);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const c = byMonth.get(k);
    if (!c) byMonth.set(k, { first: p.close, last: p.close });
    else c.last = p.close;
  }
  const months = [...byMonth.entries()].sort().slice(-13);
  const out: MonthlyPerf[] = [];
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1][1].last;
    const v = months[i][1].last;
    if (prev > 0) out.push({ month: months[i][0], returnPct: (v / prev - 1) * 100 });
  }
  return out.slice(-12);
}

export function trend(pts: Pt[]): {
  yoyPct: number | null;
  recent3mPct: number | null;
} {
  if (pts.length < 2) return { yoyPct: null, recent3mPct: null };
  const last = pts[pts.length - 1];
  const before = (t: number): Pt => {
    let best = pts[0];
    for (const p of pts) {
      if (p.t <= t) best = p;
      else break;
    }
    return best;
  };
  const yoy = before(addMonths(last.t, -12));
  const m3 = before(addMonths(last.t, -3));
  return {
    yoyPct: yoy.close > 0 ? (last.close / yoy.close - 1) * 100 : null,
    recent3mPct: m3.close > 0 ? (last.close / m3.close - 1) * 100 : null,
  };
}

export interface IndexBundle {
  available: boolean;
  thsCode: string | null;
  indexName: string | null;
  /** true = 用的是同花顺行业指数 proxy（非精确跟踪指数） */
  isProxy: boolean;
  constituents: ThsConstituent[];
  yearlyReturns: YearlyReturn[];
  holdingPeriod: HoldingPeriodStat[];
  monthlyPerf: MonthlyPerf[];
  sharpe: number | null;
  winRate: number | null;
  trend: { yoyPct: number | null; recent3mPct: number | null };
}

const EMPTY_BUNDLE: IndexBundle = {
  available: false,
  thsCode: null,
  indexName: null,
  isProxy: false,
  constituents: [],
  yearlyReturns: [],
  holdingPeriod: [],
  monthlyPerf: [],
  sharpe: null,
  winRate: null,
  trend: { yoyPct: null, recent3mPct: null },
};

/**
 * 抓「ETF 跟踪指数」对应的同花顺指数数据并算衍生指标。
 * 找不到精确指数时按行业 proxy 兜底；都没有则返回 available=false（页面优雅降级）。
 */
export async function fetchThsIndexBundle(
  trackIndexName: string | null,
  etfName: string | null
): Promise<IndexBundle> {
  if (!trackIndexName) return EMPTY_BUNDLE;

  const { thsCode, indexName, proxy } = await resolveIndustryIndexThsCode(
    trackIndexName,
    etfName
  );
  if (!thsCode) return EMPTY_BUNDLE;

  const now = Date.now();
  const start = now - 6 * 365 * 86400000; // 抓 6 年，足够算近年年度收益
  const [cons, kline] = await Promise.all([
    fetchIndexConstituents(thsCode).catch(() => []),
    fetchIndexKline(thsCode, start, now).catch(() => []),
  ]);

  const pts = toPts(
    kline.map((b) => b.date),
    kline.map((b) => b.close)
  );

  return {
    available: true,
    thsCode,
    indexName,
    isProxy: proxy,
    constituents: cons.slice(0, 20),
    yearlyReturns: yearlyReturns(pts),
    holdingPeriod: holdingPeriodProfit(pts, [6, 12, 24, 36]),
    monthlyPerf: monthlyPerf(pts),
    sharpe: sharpe(pts),
    winRate: winRate(pts),
    trend: trend(pts),
  };
}

/** 由东财 NAV 序列算 ETF 自身衍生指标（与指数 proxy 交叉对照） */
export function navDerivatives(nav: EtfNavHistory | null): {
  yearlyReturns: YearlyReturn[];
  holdingPeriod: HoldingPeriodStat[];
  sharpe: number | null;
  winRate: number | null;
} {
  if (!nav || !nav.series || nav.series.length < 2) {
    return { yearlyReturns: [], holdingPeriod: [], sharpe: null, winRate: null };
  }
  const pts = toPts(
    nav.series.map((p) => p.date),
    nav.series.map((p) => p.nav)
  );
  return {
    yearlyReturns: yearlyReturns(pts),
    holdingPeriod: holdingPeriodProfit(pts, [6, 12, 24, 36]),
    sharpe: sharpe(pts),
    winRate: winRate(pts),
  };
}
