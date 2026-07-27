/**
 * 同花顺 A股热榜：抓取 + 存储
 *
 * 数据源（已实测）：
 *   GET https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal
 * 返回结构：
 *   { "status_code": 0, "data": { "stock_list": [
 *     { "market": 33, "code": "002156", "rate": "354998.0",
 *       "rise_and_fall": 9.7680, "name": "通富微电", "order": 1,
 *       "tag": { "concept_tag": ["国家大基金持股","存储芯片"], "popularity_tag": "7天6板" } }
 *   ] } }
 * 字段说明：
 *   - code:            6 位股票代码
 *   - name:           股票名称
 *   - rate:           热度值（字符串，需 parseFloat）
 *   - rise_and_fall:  涨跌幅 %
 *   - order:          排名（1 起）
 *   - tag.concept_tag: 概念标签数组
 *   - tag.popularity_tag: 人气标签，如 "7天6板" / "持续上榜"
 */

import { getPrisma } from "@/lib/db/prisma";
import {
  fetchCNTradingViewTechnicalsBatch,
  fetchChipSituation,
  extractChipKeyword,
} from "@/lib/technical";
import type { TechnicalSignals } from "@/lib/technical";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HOT_LIST_URL =
  "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal";

export interface HotStockItem {
  rank: number;
  code: string;
  name: string;
  heat: number | null;
  changePct: number | null;
  /** SH(沪) / SZ(深)，由代码前缀推断 */
  board: "SH" | "SZ" | null;
  conceptTags: string[];
  popularityTag: string | null;
  /** TradingView 中国区技术信号（enrich 时填充） */
  signalOverall?: TechnicalSignals["overall"] | null;
  signalOscillators?: TechnicalSignals["oscillators"] | null;
  signalMovingAvg?: TechnicalSignals["movingAverages"] | null;
  /** 同花顺筹码状态 */
  chipSituation?: string | null;
  chipKeyword?: string | null;
}

export interface HotStocksResult {
  /** 北京时间日期 YYYY-MM-DD */
  date: string;
  count: number;
  items: HotStockItem[];
  fetchedAt: number;
}

/** 6 位代码 → 沪/深（用于 TradingView 链接与展示） */
function inferBoard(code: string): "SH" | "SZ" | null {
  if (/^(60|68|90|58)/.test(code)) return "SH";
  if (/^(00|30|20|08)/.test(code)) return "SZ";
  return null;
}

/** 北京时间日期字符串 YYYY-MM-DD（用 UTC+8 计算，避免服务器时区歧义） */
export function beijingDate(d: Date = new Date()): string {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600000);
  return bj.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return isNaN(n) ? null : n;
}

/**
 * 请求同花顺热榜接口并解析为结构化列表。
 * 失败（网络/结构异常）返回 null，调用方应保留旧数据。
 */
export async function fetchHotStocks(): Promise<HotStocksResult | null> {
  const startTime = Date.now();
  try {
    console.log(`[hot-stocks] 请求同花顺热榜: ${HOT_LIST_URL}`);
    const res = await fetch(HOT_LIST_URL, {
      headers: {
        "User-Agent": UA,
        Referer: "https://dq.10jqka.com.cn/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[hot-stocks] 同花顺响应非 200: ${res.status}`);
      return null;
    }

    const json = (await res.json()) as {
      status_code?: number;
      data?: { stock_list?: unknown[] };
    };

    const list = json?.data?.stock_list;
    if (!Array.isArray(list)) {
      console.warn(`[hot-stocks] 返回结构异常: ${JSON.stringify(json).slice(0, 200)}`);
      return null;
    }

    const items: HotStockItem[] = list
      .map((raw): HotStockItem | null => {
        const it = raw as Record<string, any>;
        const code = String(it.code ?? "");
        const name = String(it.name ?? "");
        if (!code || !name) return null;
        const tag = it.tag ?? {};
        return {
          rank: num(it.order) ?? 0,
          code,
          name,
          heat: num(it.rate),
          changePct: num(it.rise_and_fall),
          board: inferBoard(code),
          conceptTags: Array.isArray(tag.concept_tag)
            ? (tag.concept_tag as unknown[]).map(String)
            : [],
          popularityTag: tag.popularity_tag ? String(tag.popularity_tag) : null,
        };
      })
      .filter((x): x is HotStockItem => x !== null);

    console.log(`[hot-stocks] 成功 (${Date.now() - startTime}ms): ${items.length} 条`);
    return {
      date: beijingDate(),
      count: items.length,
      items,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.error(
      `[hot-stocks] 失败 (${Date.now() - startTime}ms):`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * 为热榜股票补充技术信号（TradingView 中国区）与筹码状态（同花顺）。
 * 为控制外部请求量，只对前 limit 条（默认 50，与前端展示量一致）获取；
 * 信号用一次批量请求拿全部，筹码按并发上限逐只获取。任一只失败仅置 null，不影响其他。
 *
 * @param items fetchHotStocks 返回的原始列表（会被就地补充字段）
 * @param limit 补充范围（取排名前 limit 条）
 * @returns 同一数组（已补充字段）
 */
export async function enrichHotStocks(
  items: HotStockItem[],
  limit = 50
): Promise<HotStockItem[]> {
  const top = items.slice(0, limit);
  // 仅对能构造出合法 A 股 ticker 的项补充
  const targets = top.filter((it) => it.board === "SH" || it.board === "SZ");
  const tickers = targets.map((it) => `${it.code}.${it.board}`);

  // 1) 批量技术信号：一次 TradingView 请求拿全部
  const sigMap = await fetchCNTradingViewTechnicalsBatch(tickers).catch(
    () => new Map<string, TechnicalSignals>()
  );

  // 2) 筹码状态：逐只并发（限制并发数，避免同花顺限流）
  const CHIP_CONCURRENCY = 8;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CHIP_CONCURRENCY, targets.length) },
    async () => {
      while (cursor < targets.length) {
        const i = cursor++;
        const it = targets[i];
        const tk = tickers[i];
        try {
          const sig = sigMap.get(tk) ?? null;
          it.signalOverall = sig?.overall ?? null;
          it.signalOscillators = sig?.oscillators ?? null;
          it.signalMovingAvg = sig?.movingAverages ?? null;
          const chip = await fetchChipSituation(tk);
          it.chipSituation = chip;
          it.chipKeyword = extractChipKeyword(chip);
        } catch {
          // 单只失败保持 null
        }
      }
    }
  );
  await Promise.all(workers);

  return items;
}

/**
 * 将当日热榜写入 DB（按 date+code upsert）。返回实际写入条数。
 * DB 不可用时返回 0（不抛错，调用方继续）。
 */
export async function storeHotStocks(result: HotStocksResult): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) {
    console.warn("[hot-stocks] 数据库不可用，跳过存储");
    return 0;
  }

  let written = 0;
  for (const it of result.items) {
    try {
      await prisma.hotStock.upsert({
        where: { date_code: { date: result.date, code: it.code } },
        create: {
          date: result.date,
          rank: it.rank,
          code: it.code,
          name: it.name,
          heat: it.heat,
          changePct: it.changePct,
          board: it.board,
          conceptTags: it.conceptTags.length ? it.conceptTags.join(",") : null,
          popularityTag: it.popularityTag,
          signalOverall: it.signalOverall ?? null,
          signalOscillators: it.signalOscillators ?? null,
          signalMovingAvg: it.signalMovingAvg ?? null,
          chipSituation: it.chipSituation ?? null,
          chipKeyword: it.chipKeyword ?? null,
        },
        update: {
          rank: it.rank,
          name: it.name,
          heat: it.heat,
          changePct: it.changePct,
          board: it.board,
          conceptTags: it.conceptTags.length ? it.conceptTags.join(",") : null,
          popularityTag: it.popularityTag,
          signalOverall: it.signalOverall ?? null,
          signalOscillators: it.signalOscillators ?? null,
          signalMovingAvg: it.signalMovingAvg ?? null,
          chipSituation: it.chipSituation ?? null,
          chipKeyword: it.chipKeyword ?? null,
        },
      });
      written++;
    } catch (err) {
      console.error(
        `[hot-stocks] 写 ${it.code} 失败:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  console.log(`[hot-stocks] 已存储 ${written}/${result.items.length} 条 (${result.date})`);
  return written;
}
