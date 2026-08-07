/**
 * 轻量分析师目标价抓取（stockanalysis.com forecast 页面，免 key）。
 *
 * 仅用于卡片展示，不做重分析：共识目标均价 / 高低区间 / 中位数 / 覆盖分析师数。
 * 抓取策略与 lib/finance.ts 的 fetchStockAnalysisTargets 同源（HTML 表格 + 内嵌 JSON + 文本兜底），
 * 但独立成模块，避免 reddit-hot 链路耦合到沉重的 finance.ts。
 *
 * 注意：stockanalysis 对高频并发敏感，批量接口做了分块限流（默认并发 8）。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface AnalystTarget {
  /** 共识目标均价（avg） */
  targetMean: number | null;
  /** 目标中位数 */
  targetMedian: number | null;
  /** 目标价下限 */
  targetLow: number | null;
  /** 目标价上限 */
  targetHigh: number | null;
  /** 覆盖分析师数量 */
  analystCount: number | null;
}

/**
 * 抓取单只股票的分析师目标价。失败（网络/无数据）返回 null。
 */
export async function fetchAnalystTarget(
  ticker: string
): Promise<AnalystTarget | null> {
  const lower = ticker.trim().toLowerCase();
  if (!lower) return null;
  const url = `https://stockanalysis.com/stocks/${lower}/forecast/`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    let targetMean: number | null = null;
    let targetMedian: number | null = null;
    let targetLow: number | null = null;
    let targetHigh: number | null = null;
    let analystCount: number | null = null;

    // 1) HTML 表格行：<td>Price</td><td>$low</td><td>$avg</td><td>$median</td><td>$high</td>
    const tableRow = html.match(
      /<td[^>]*>Price<\/td>\s*<td[^>]*>\$([\d.]+)<\/td>\s*<td[^>]*>\$([\d.]+)<\/td>\s*<td[^>]*>\$([\d.]+)<\/td>\s*<td[^>]*>\$([\d.]+)<\/td>/i
    );
    if (tableRow) {
      targetLow = parseFloat(tableRow[1]);
      targetMean = parseFloat(tableRow[2]);
      targetMedian = parseFloat(tableRow[3]);
      targetHigh = parseFloat(tableRow[4]);
    }

    // 2) 内嵌 JSON：priceTargets:{source:"spg",avg:...,median:...,low:...,high:...,numPriceTargets:...}
    const pt = html.match(/priceTargets:\{([^}]+)\}/);
    if (pt) {
      const m = pt[1];
      const low = m.match(/low:(\d+(?:\.\d+)?)/)?.[1];
      const high = m.match(/high:(\d+(?:\.\d+)?)/)?.[1];
      const median = m.match(/median:(\d+(?:\.\d+)?)/)?.[1];
      const avg = m.match(/avg:(\d+(?:\.\d+)?)/)?.[1];
      const num = m.match(/numPriceTargets:(\d+)/)?.[1];
      if (targetLow == null && low) targetLow = parseFloat(low);
      if (targetHigh == null && high) targetHigh = parseFloat(high);
      if (targetMedian == null && median) targetMedian = parseFloat(median);
      if (targetMean == null && avg) targetMean = parseFloat(avg);
      if (analystCount == null && num) analystCount = parseInt(num, 10);
    }

    // 3) 内嵌 JSON：currentRatings:{...count:46...}
    const cr = html.match(/currentRatings:\{([^}]+)\}/);
    if (cr) {
      const count = cr[1].match(/count:(\d+)/)?.[1];
      if (analystCount == null && count) analystCount = parseInt(count, 10);
    }

    // 4) 文本兜底
    if (targetMean == null) {
      const avg = html.match(/average price target of \$([\d.]+)/);
      if (avg) targetMean = parseFloat(avg[1]);
    }
    if (targetMean == null) {
      const pt2 = html.match(/Price Target:\s*\$([\d.]+)/);
      if (pt2) targetMean = parseFloat(pt2[1]);
    }
    if (analystCount == null) {
      const a = html.match(/According to (\d+) analysts/);
      if (a) analystCount = parseInt(a[1], 10);
    }
    if (analystCount == null) {
      const a = html.match(/The (\d+) analysts that cover/);
      if (a) analystCount = parseInt(a[1], 10);
    }

    if (
      targetMean == null &&
      targetLow == null &&
      targetHigh == null &&
      targetMedian == null
    ) {
      return null;
    }

    return { targetMean, targetMedian, targetLow, targetHigh, analystCount };
  } catch {
    return null;
  }
}

/**
 * 批量抓取（分块并发，避免瞬时打爆 stockanalysis）。
 * @param tickers 股票代码数组
 * @param concurrency 并发上限（默认 8）
 * @param batchDelayMs 每块之间的微停顿（默认 120ms，礼貌限流）
 * @returns 以 ticker 大写映射的结果 Map
 */
export async function fetchAnalystTargetsBatch(
  tickers: string[],
  concurrency = 8,
  batchDelayMs = 120
): Promise<Map<string, AnalystTarget>> {
  const map = new Map<string, AnalystTarget>();
  const unique = Array.from(
    new Set(tickers.map((t) => t.trim().toUpperCase()))
  );

  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((t) => fetchAnalystTarget(t)));
    batch.forEach((t, idx) => {
      const r = results[idx];
      if (r) map.set(t.toUpperCase(), r);
    });
    if (i + concurrency < unique.length && batchDelayMs > 0) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }
  return map;
}
