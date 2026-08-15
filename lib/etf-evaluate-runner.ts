/**
 * 把「估值 + 质量」评估挂到主升浪池的 ETF 上。
 *
 * 输入是 etf-trend.ts 已经产出的 EtfTrendItem（趋势/筛选已由上游完成），
 * 这里只负责：抓基金数据 → 跑评估引擎 → 把结果挂回 item。
 * 支持并发抓取（默认 5），单只失败不影响整体。
 */

import type { EtfTrendItem } from "./etf-trend";
import { fetchEtfFundData, type EtfFundData } from "./etf-fund-data";
import {
  evaluateEtf,
  type EtfEvaluation,
  type EtfValuationInput,
  type EtfQualityInput,
} from "./etf-evaluate";

export interface EnrichedEtfTrendItem extends EtfTrendItem {
  evaluation: EtfEvaluation;
  fundData: EtfFundData | null;
}

/** 简易并发池 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (idx < items.length) {
        const cur = idx++;
        results[cur] = await fn(items[cur], cur);
      }
    });
  await Promise.all(workers);
  return results;
}

/**
 * 对单只 ETF 做估值+质量评估。
 * 数据缺失时评估引擎会中性处理，fundData 可能非 null（部分字段 null）。
 */
export async function evaluateTrendEtf(
  item: EtfTrendItem
): Promise<EnrichedEtfTrendItem> {
  let fundData: EtfFundData | null = null;
  let valuation: EtfValuationInput;
  let quality: EtfQualityInput;

  try {
    fundData = await fetchEtfFundData(item.code, item.board);
    valuation = fundData.valuation;
    quality = fundData.quality;
  } catch {
    // 抓取整体失败 → 全 null 输入，引擎按中性处理
    valuation = {
      indexPePercentile: null,
      indexPbPercentile: null,
      dividendYieldPct: null,
      bondYieldPct: null,
      epsRevisionUpPct: null,
      proxy: false,
    };
    quality = {
      scaleYi: null,
      dailyTurnoverWan: null,
      premiumDiscountPct: null,
      trackingErrorPct: null,
      feeRatePct: null,
    };
  }

  const evaluation = evaluateEtf({ valuation, quality });
  return { ...item, evaluation, fundData };
}

/**
 * 批量评估主升浪池 ETF。
 * @param items 已去重的主升浪池 ETF 列表
 * @param concurrency 并发抓取数（默认 5）
 */
export async function enrichEtfTrend(
  items: EtfTrendItem[],
  concurrency = 5
): Promise<EnrichedEtfTrendItem[]> {
  const enriched = await mapPool(items, concurrency, (it) =>
    evaluateTrendEtf(it)
  );
  // 按综合分降序，方便前端/报告排序展示
  enriched.sort((a, b) => {
    const sa = a.evaluation.totalScore ?? -1;
    const sb = b.evaluation.totalScore ?? -1;
    return sb - sa;
  });
  return enriched;
}
