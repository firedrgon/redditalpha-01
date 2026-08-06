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

const APEWISDOM_API = "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1";

export interface RedditHotItem {
  rank: number;
  ticker: string;
  name: string;
  mentions: number;
  mentions24hAgo: number | null;
  upvotes: number;
  rank24hAgo: number | null;
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
    const items: RedditHotItem[] = (json.results || []).slice(0, 100).map((r) => ({
      rank: r.rank,
      ticker: r.ticker,
      name: r.name,
      mentions: r.mentions,
      mentions24hAgo: r.mentions_24h_ago,
      upvotes: r.upvotes,
      rank24hAgo: r.rank_24h_ago,
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
          mentions: it.mentions,
          mentions24hAgo: it.mentions24hAgo,
          upvotes: it.upvotes,
          rank24hAgo: it.rank24hAgo,
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
      mentions: r.mentions,
      mentions24hAgo: r.mentions24hAgo,
      upvotes: r.upvotes,
      rank24hAgo: r.rank24hAgo,
    })),
  };
}
