/**
 * Reddit 热门股票数据（ApeWisdom 数据源）。
 *
 * API：https://apewisdom.io/api/v1.0/filter/all-stocks/page/{page}
 * - 免费、无需 API key
 * - 每页 ~100 条，page/1 即 Top 100
 * - 数据：rank / ticker / name / mentions / upvotes / rank_24h_ago / mentions_24h_ago
 *
 * 存储策略：每日盘前抓取一次，存储前清空旧数据（仅保留最新一天快照）。
 */

import { getPrisma } from "@/lib/db/prisma";
import { beijingDate } from "@/lib/hot-stocks";
import { fetchTradingViewTechnicalsBatch, type TechnicalSignals } from "@/lib/technical";
import { fetchQuotes, type Quote } from "@/lib/quote";
import { fetchAnalystTargetsBatch, type AnalystTarget } from "@/lib/analyst-target";

const APEWISDOM_API = "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1";

export interface RedditHotItem {
  rank: number;
  ticker: string;
  name: string;
  nameCn: string | null;
  mentions: number;
  mentions24hAgo: number | null;
  upvotes: number;
  rank24hAgo: number | null;
  /// TradingView 美股技术信号（5 级）
  signalOverall: string | null;
  signalOscillators: string | null;
  signalMovingAvg: string | null;
  /// 当前价格 + 涨跌（USD）
  price: number | null;
  change: number | null;
  changePercent: number | null;
  /// 分析师共识目标均价（USD），来源 stockanalysis.com forecast
  targetPrice: number | null;
  /// 目标价区间（USD）
  targetHigh: number | null;
  targetLow: number | null;
  /// 覆盖分析师数量
  analystCount: number | null;
}

export interface RedditHotFetchResult {
  date: string;
  count: number;
  items: RedditHotItem[];
}

interface ApeWisdomResponse {
  count: number;
  pages: number;
  current_page: number;
  results: Array<{
    rank: number;
    ticker: string;
    name: string;
    mentions: number;
    upvotes: number;
    rank_24h_ago: number | null;
    mentions_24h_ago: number | null;
  }>;
}

/** 东方财富搜索 API token（公开，长期有效） */
const EM_SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const EM_SEARCH_API = "https://searchadapter.eastmoney.com/api/suggest/get";

interface EmSearchResult {
  Code: string;
  Name: string;
  Classify: string;
}

/**
 * 批量获取美股中文名（东方财富搜索 API）。
 * - 并行请求，每批 20 个（避免瞬时并发过高）
 * - 匹配 Classify=UsStock 且 Code 完全匹配的结果
 * - 未找到的返回 null（不影响存储）
 */
async function fetchChineseNames(
  tickers: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const BATCH = 20;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (ticker) => {
        try {
          const url = `${EM_SEARCH_API}?input=${encodeURIComponent(
            ticker
          )}&type=14&token=${EM_SEARCH_TOKEN}`;
          const res = await fetch(url, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return;
          const json = await res.json();
          const data: EmSearchResult[] | null =
            json?.QuotationCodeTable?.Data ?? null;
          if (!Array.isArray(data)) return;
          // 精确匹配 Code（忽略大小写），优先 UsStock 分类
          const match =
            data.find(
              (d) =>
                d.Classify === "UsStock" &&
                d.Code.toUpperCase() === ticker.toUpperCase()
            ) ?? data.find((d) => d.Code.toUpperCase() === ticker.toUpperCase());
          if (match?.Name) {
            result.set(ticker.toUpperCase(), match.Name);
          }
        } catch {
          // 单个失败不影响整体
        }
      })
    );
  }

  console.log(
    `[reddit-hot] 中文名映射: ${result.size}/${tickers.length} 命中`
  );
  return result;
}

/**
 * 从 ApeWisdom 抓取 all-stocks Top 100。
 * 失败返回 null（不抛错，调用方自行处理）。
 */
export async function fetchRedditHotStocks(): Promise<RedditHotFetchResult | null> {
  try {
    const res = await fetch(APEWISDOM_API, {
      headers: { Accept: "application/json" },
      // ApeWisdom 数据每小时更新，抓取时实时拉取
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[reddit-hot] ApeWisdom API 返回 ${res.status}`);
      return null;
    }

    const json: ApeWisdomResponse = await res.json();
    const rawItems = (json.results || []).slice(0, 100);

    // 并行获取中文名（东方财富搜索 API，best-effort，失败不影响主流程）
    let nameCnMap = new Map<string, string>();
    try {
      nameCnMap = await fetchChineseNames(rawItems.map((r) => r.ticker));
    } catch (e) {
      console.warn("[reddit-hot] 中文名获取失败(已忽略):", e);
    }

    const items: RedditHotItem[] = rawItems.map((r) => ({
      rank: r.rank,
      ticker: r.ticker,
      name: r.name,
      nameCn: nameCnMap.get(r.ticker.toUpperCase()) ?? null,
      mentions: r.mentions,
      mentions24hAgo: r.mentions_24h_ago,
      upvotes: r.upvotes,
      rank24hAgo: r.rank_24h_ago,
      signalOverall: null,
      signalOscillators: null,
      signalMovingAvg: null,
      price: null,
      change: null,
      changePercent: null,
      targetPrice: null,
      targetHigh: null,
      targetLow: null,
      analystCount: null,
    }));

    const date = beijingDate();
    console.log(
      `[reddit-hot] 抓取成功: ${items.length} 只 (共 ${json.count} 只，取 Top ${items.length})`
    );
    return { date, count: items.length, items };
  } catch (err) {
    console.error(
      `[reddit-hot] 抓取失败:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * 为 Reddit 热榜股票补充技术信号（TradingView 美股）与当前价格 + 涨跌。
 * - 技术信号：一次 scanner 批量请求拿全部（NASDAQ/NYSE 双 prefix 尝试）
 * - 价格 + 涨跌：fetchQuotes 并行拉取（Finnhub/FMP/Yahoo/腾讯 兜底链）
 * 任一只失败仅置 null，不影响其他。失败整体忽略，仅存基础数据。
 *
 * @param items fetchRedditHotStocks 返回的原始列表（会被就地补充字段）
 * @param limit 补充范围（取排名前 limit 条，默认 100 = 全部）
 * @returns 同一数组（已补充字段）
 */
export async function enrichRedditHotStocks(
  items: RedditHotItem[],
  limit = 100
): Promise<RedditHotItem[]> {
  const top = items.slice(0, limit);
  const tickers = top.map((it) => it.ticker);

  // 1) 批量技术信号：一次 TradingView scanner 请求拿全部
  const sigMap: Map<string, TechnicalSignals> = await fetchTradingViewTechnicalsBatch(
    tickers,
    15000
  ).catch(() => new Map<string, TechnicalSignals>());
  for (const it of top) {
    const sig = sigMap.get(it.ticker.toUpperCase());
    it.signalOverall = sig?.overall ?? null;
    it.signalOscillators = sig?.oscillators ?? null;
    it.signalMovingAvg = sig?.movingAverages ?? null;
  }

  // 2) 批量价格 + 涨跌
  const quoteMap: Record<string, Quote> = await fetchQuotes(tickers).catch(
    () => ({}) as Record<string, Quote>
  );
  for (const it of top) {
    const q = quoteMap[it.ticker.toUpperCase()];
    it.price = q?.price ?? null;
    it.change = q?.change ?? null;
    it.changePercent = q?.changePercent ?? null;
  }

  // 3) 分析师目标价（stockanalysis forecast，分块并发 best-effort）
  const targetMap: Map<string, AnalystTarget> = await fetchAnalystTargetsBatch(
    tickers
  ).catch(() => new Map<string, AnalystTarget>());
  for (const it of top) {
    const t = targetMap.get(it.ticker.toUpperCase());
    it.targetPrice = t?.targetMean ?? null;
    it.targetHigh = t?.targetHigh ?? null;
    it.targetLow = t?.targetLow ?? null;
    it.analystCount = t?.analystCount ?? null;
  }

  console.log(
    `[reddit-hot] enrich 完成: 信号 ${sigMap.size}/${tickers.length}，价格 ${Object.keys(quoteMap).length}/${tickers.length}，目标价 ${targetMap.size}/${tickers.length}`
  );
  return items;
}

/**
 * 将抓取结果写入 DB：先清空全表历史数据，再插入本次快照。
 * 用事务保证原子性。抓取结果为空时跳过清空（防误删）。
 */
export async function storeRedditHotStocks(
  result: RedditHotFetchResult
): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) {
    console.warn("[reddit-hot] 数据库不可用，跳过存储");
    return 0;
  }

  if (result.items.length === 0) {
    console.warn("[reddit-hot] 抓取结果为空，跳过清空+存储");
    return 0;
  }

  try {
    const written = await prisma.$transaction(async (tx) => {
      await tx.redditHotStock.deleteMany({});
      await tx.redditHotStock.createMany({
        data: result.items.map((it) => ({
          date: result.date,
          rank: it.rank,
          ticker: it.ticker,
          name: it.name,
          nameCn: it.nameCn,
          mentions: it.mentions,
          mentions24hAgo: it.mentions24hAgo,
          upvotes: it.upvotes,
          rank24hAgo: it.rank24hAgo,
          signalOverall: it.signalOverall,
          signalOscillators: it.signalOscillators,
          signalMovingAvg: it.signalMovingAvg,
          price: it.price,
          change: it.change,
          changePercent: it.changePercent,
          targetPrice: it.targetPrice,
          targetHigh: it.targetHigh,
          targetLow: it.targetLow,
          analystCount: it.analystCount,
        })),
        skipDuplicates: true,
      });
      return result.items.length;
    });
    console.log(
      `[reddit-hot] 已清空旧数据并存储 ${written} 条 (${result.date})`
    );
    return written;
  } catch (err) {
    console.error(
      `[reddit-hot] 存储失败:`,
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}

/**
 * 从 DB 读取当日 Reddit 热榜；当日无数据则回退到最近一次快照。
 */
export async function getRedditHotStocks(
  limit: number = 100
): Promise<{ date: string; count: number; stocks: RedditHotItem[] }> {
  const prisma = getPrisma();
  if (!prisma) {
    return { date: "", count: 0, stocks: [] };
  }

  const today = beijingDate();
  let date = today;
  let rows = await prisma.redditHotStock.findMany({
    where: { date: today },
    orderBy: { rank: "asc" },
    take: limit,
  });

  // 当日暂无数据 → 回退到最近一次快照
  if (rows.length === 0) {
    const latest = await prisma.redditHotStock.findFirst({
      orderBy: { date: "desc" },
    });
    if (latest) {
      date = latest.date;
      rows = await prisma.redditHotStock.findMany({
        where: { date },
        orderBy: { rank: "asc" },
        take: limit,
      });
    }
  }

  return {
    date,
    count: rows.length,
    stocks: rows.map((r) => ({
      rank: r.rank,
      ticker: r.ticker,
      name: r.name,
      nameCn: r.nameCn,
      mentions: r.mentions,
      mentions24hAgo: r.mentions24hAgo,
      upvotes: r.upvotes,
      rank24hAgo: r.rank24hAgo,
      signalOverall: r.signalOverall,
      signalOscillators: r.signalOscillators,
      signalMovingAvg: r.signalMovingAvg,
      price: r.price,
      change: r.change,
      changePercent: r.changePercent,
      targetPrice: r.targetPrice,
      targetHigh: r.targetHigh,
      targetLow: r.targetLow,
      analystCount: r.analystCount,
    })),
  };
}
