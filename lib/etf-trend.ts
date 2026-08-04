/**
 * ETF 主升浪池：抓取 + 去重 + 存储 + 读取
 *
 * 数据源（同花顺 10jqka，已实测）：
 *   1. POST https://fund.10jqka.com.cn/quotation/fund_pool/v2/query
 *      body: { businessKey: "etfUpTrend", businessPoolKey, custom: { fieldList, limit, offset } }
 *      返回: { status_code, data: { total, itemList: [[code, name, prefixedCode], ...] } }
 *      - itemList[i][0] = 6 位交易代码（如 "159725"）
 *      - itemList[i][1] = 基金简称（UTF-8 中文）
 *      - itemList[i][2] = 带市场前缀的标的代码（如 "36:159725" / "20:513050"）
 *
 *   2. POST https://dataq.10jqka.com.cn/dataapi/tagservice/fetch/v1/tag_data
 *      header: Source-Id: hxkline-FW_ETFUpTrend_Page
 *      body: { code_selectors: { include: [{ type: "stock_code", values: [prefixedCode...] }] },
 *              tag_infos: [{ tag_key }, ...] }
 *      返回: { status_code, data: { data: [{ code, values: [{ tag_key, show_tag: [] }] }] } }
 *      标签说明：
 *        - ifund_etf_t0                   → show_tag 含 "T+0"
 *        - ifund_biz_last_day_step_signal → show_tag 含 "回踩"   → 趋势回踩
 *        - ifund_biz_new_up_trend         → show_tag 含 "新入池"   → 新入池
 *
 * 调度：由 /api/cron/signals 在盘前抓取一次并落库（按北京时间日期 upsert）。
 * 同类去重：按归一化后的指数/概念名分组，读取时每组仅展示一只。
 */

import { getPrisma } from "@/lib/db/prisma";
import { beijingDate } from "@/lib/hot-stocks";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const FUND_POOL_URL =
  "https://fund.10jqka.com.cn/quotation/fund_pool/v2/query";
const TAG_DATA_URL =
  "https://dataq.10jqka.com.cn/dataapi/tagservice/fetch/v1/tag_data";

/** ETF 主升浪池的 businessPoolKey */
const ETF_UP_TREND_POOL_KEY = "1f3b943f-c5f4-312f-95b9-64de02642115";

/** 标签服务需附带的 Source-Id（同花顺页面识别） */
const TAG_SOURCE_ID = "hxkline-FW_ETFUpTrend_Page";

/** 单次 tag_data 请求的代码上限（避免请求体过大被拒） */
const TAG_BATCH_SIZE = 100;

export type EtfCategory = "pullback" | "newPool";

export interface EtfTrendItem {
  /** 6 位交易代码，如 "159725" */
  code: string;
  /** 基金简称 */
  name: string;
  /** 带市场前缀的标的代码，如 "36:159725" */
  prefixedCode: string;
  /** 沪/深（用于链接与展示） */
  board: "SH" | "SZ" | null;
  /** 是否 T+0 */
  t0: boolean;
  /** 分类标签文案，如 "回踩" / "新入池" */
  tag: string;
  /** 所属分类 */
  category: EtfCategory;
  /** 同类去重分组键（归一化后的指数/概念名） */
  dedupKey: string;
}

export interface EtfTrendFetchResult {
  /** 含分类标签的全部 ETF（未去重） */
  items: EtfTrendItem[];
  /** 池中 ETF 总数 */
  total: number;
  /** 北京时间日期 YYYY-MM-DD */
  date: string;
  /** 抓取耗时（ms） */
  elapsedMs: number;
}

export interface EtfTrendResult {
  /** 趋势回踩列表（已去重，每组一只） */
  pullback: EtfTrendItem[];
  /** 新入池列表（已去重，每组一只） */
  newPool: EtfTrendItem[];
  /** 池中 ETF 总数 */
  total: number;
  /** 数据日期 YYYY-MM-DD */
  date: string;
  /** 抓取时间（ISO，落库时间） */
  fetchedAt: string;
}

/** 6 位 ETF 代码 → 沪/深：5/6 开头沪，1 开头深 */
function inferEtfBoard(code: string): "SH" | "SZ" | null {
  if (/^[56]/.test(code)) return "SH";
  if (/^1/.test(code)) return "SZ";
  return null;
}

// ============================================================
// 同类去重：将 ETF 名称归一化为指数/概念分组键
// ============================================================

/** 常见基金公司关键词（归一化时剔除，避免同名指数的不同产品被误判为不同类） */
const FUND_COMPANY_KEYWORDS = [
  "华泰柏瑞", "易方达", "嘉实", "华夏", "南方", "广发", "富国", "工银瑞信", "工银",
  "华安", "国泰", "华宝", "鹏华", "大成", "博时", "银华", "汇添富", "平安", "招商",
  "万家", "建信", "长信", "国联安", "诺安", "银河", "长盛", "国寿", "国联", "中欧",
  "景顺长城", "鹏扬", "兴业", "华富", "国金", "上投摩根", "摩根", "浦银安盛", "浦银",
  "农银汇理", "农银", "中海", "华商", "东财", "财通", "德邦", "信澳", "中信保诚",
  "信诚", "中信建投", "中加", "中融", "前海开源", "前海", "红土创新", "红塔红土",
  "红塔", "创金合信", "金鹰", "浙商", "渤海", "中航", "华润", "安信", "长城",
  "申万菱信", "申万", "西部利得", "西部", "英大", "恒越", "恒生前海", "恒生", "同泰",
  "中金", "太平", "国新", "华富", "百嘉", "明亚", "中银", "兴业全球", "兴全",
];

/** 归一化 ETF 名称 → 去重分组键 */
export function computeDedupKey(name: string): string {
  let s = name.trim();
  // 剔除基金公司
  for (const c of FUND_COMPANY_KEYWORDS) {
    if (s.includes(c)) s = s.split(c).join("");
  }
  // 剔除通用后缀/类型词
  s = s.replace(/ETF|LOF|联接基金|联接|指数基金|指数增强|指数|增强型|增强|基金|策略|主题/g, "");
  // 剔除份额类别后缀 A/B/C/D/E/I/R/H
  s = s.replace(/[ABCDDEIRH]$/, "");
  // 剔除空白
  s = s.replace(/\s+/g, "");
  return s || name.trim();
}

/** 同一组（dedupKey + category）内挑选代表：优先沪市 > T+0 > 代码小（通常成立早、规模大） */
function pickRepresentative(items: EtfTrendItem[]): EtfTrendItem {
  return [...items].sort((a, b) => {
    if (a.board !== b.board) return a.board === "SH" ? -1 : 1;
    if (a.t0 !== b.t0) return a.t0 ? -1 : 1;
    return a.code.localeCompare(b.code);
  })[0];
}

/** 对一个分类的列表按 dedupKey 去重，每组仅保留代表 */
function dedupItems(items: EtfTrendItem[]): EtfTrendItem[] {
  const groups = new Map<string, EtfTrendItem[]>();
  for (const it of items) {
    const arr = groups.get(it.dedupKey) ?? [];
    arr.push(it);
    groups.set(it.dedupKey, arr);
  }
  const reps: EtfTrendItem[] = [];
  for (const arr of groups.values()) {
    reps.push(pickRepresentative(arr));
  }
  // 代表按代码排序，便于稳定展示
  reps.sort((a, b) => a.code.localeCompare(b.code));
  return reps;
}

// ============================================================
// 抓取
// ============================================================

interface FundPoolResp {
  status_code?: number;
  data?: { total?: number; itemList?: unknown[][] };
}
interface TagDataResp {
  status_code?: number;
  data?: {
    data?: Array<{
      code?: string;
      values?: Array<{ tag_key?: string; show_tag?: string[] }>;
    }>;
  };
}

/** 通用 POST JSON 抓取 */
async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 15000
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Referer: "https://fund.10jqka.com.cn/",
        ...headers,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[etf-trend] ${url} 响应非 200: ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(
      `[etf-trend] ${url} 请求失败:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** 第一步：获取主升浪池全部 ETF（code / name / prefixedCode） */
async function fetchEtfUpTrendPool(): Promise<{
  items: { code: string; name: string; prefixedCode: string }[];
  total: number;
} | null> {
  const json = await postJson<FundPoolResp>(
    FUND_POOL_URL,
    {
      businessKey: "etfUpTrend",
      businessPoolKey: ETF_UP_TREND_POOL_KEY,
      custom: { fieldList: ["code"], limit: 10000, offset: 0 },
    },
    {}
  );

  if (json?.status_code !== 0 || !Array.isArray(json?.data?.itemList)) {
    console.warn(
      `[etf-trend] fund_pool 返回结构异常: ${JSON.stringify(json).slice(0, 200)}`
    );
    return null;
  }

  const items: { code: string; name: string; prefixedCode: string }[] = [];
  for (const row of json.data.itemList) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const code = String(row[0] ?? "");
    const name = String(row[1] ?? "");
    const prefixedCode = String(row[2] ?? "");
    if (!code || !prefixedCode) continue;
    items.push({ code, name, prefixedCode });
  }

  return { items, total: Number(json.data.total) ?? items.length };
}

interface TagEntry {
  t0: boolean;
  stepSignal: string;
  newUpTrend: string;
}

/** 第二步：批量获取标签，返回 prefixedCode → 标签映射 */
async function fetchEtfTags(
  prefixedCodes: string[]
): Promise<Map<string, TagEntry>> {
  const map = new Map<string, TagEntry>();

  const chunks: string[][] = [];
  for (let i = 0; i < prefixedCodes.length; i += TAG_BATCH_SIZE) {
    chunks.push(prefixedCodes.slice(i, i + TAG_BATCH_SIZE));
  }

  for (const chunk of chunks) {
    const json = await postJson<TagDataResp>(
      TAG_DATA_URL,
      {
        code_selectors: {
          include: [{ type: "stock_code", values: chunk }],
        },
        tag_infos: [
          { tag_key: "ifund_etf_t0" },
          { tag_key: "ifund_biz_last_day_step_signal" },
          { tag_key: "ifund_biz_new_up_trend" },
        ],
      },
      { "Source-Id": TAG_SOURCE_ID },
      20000
    );

    if (json?.status_code !== 0 || !Array.isArray(json?.data?.data)) {
      console.warn(
        `[etf-trend] tag_data 返回结构异常（已跳过本批 ${chunk.length} 条）`
      );
      continue;
    }

    for (const entry of json.data.data) {
      const code = String(entry.code ?? "");
      if (!code) continue;
      const tagEntry: TagEntry = { t0: false, stepSignal: "", newUpTrend: "" };
      for (const v of entry.values ?? []) {
        const tags = Array.isArray(v.show_tag) ? v.show_tag : [];
        if (v.tag_key === "ifund_etf_t0") {
          tagEntry.t0 = tags.length > 0;
        } else if (v.tag_key === "ifund_biz_last_day_step_signal") {
          tagEntry.stepSignal = tags[0] ?? "";
        } else if (v.tag_key === "ifund_biz_new_up_trend") {
          tagEntry.newUpTrend = tags[0] ?? "";
        }
      }
      map.set(code, tagEntry);
    }
  }

  return map;
}

/**
 * 抓取 ETF 主升浪池并按标签分类（含 dedupKey，未去重）。
 * - pullback（趋势回踩）：ifund_biz_last_day_step_signal 标签非空
 * - newPool（新入池）：ifund_biz_new_up_trend 标签非空
 * 一只 ETF 可能同时出现在两个分类中。
 */
export async function fetchEtfTrendData(): Promise<EtfTrendFetchResult | null> {
  const start = Date.now();

  const pool = await fetchEtfUpTrendPool();
  if (!pool || pool.items.length === 0) {
    return null;
  }

  const tags = await fetchEtfTags(pool.items.map((it) => it.prefixedCode));

  const items: EtfTrendItem[] = [];

  for (const it of pool.items) {
    const tag = tags.get(it.prefixedCode);
    const t0 = tag?.t0 ?? false;
    const board = inferEtfBoard(it.code);
    const dedupKey = computeDedupKey(it.name);

    if (tag?.stepSignal) {
      items.push({
        code: it.code,
        name: it.name,
        prefixedCode: it.prefixedCode,
        board,
        t0,
        tag: tag.stepSignal,
        category: "pullback",
        dedupKey,
      });
    }
    if (tag?.newUpTrend) {
      items.push({
        code: it.code,
        name: it.name,
        prefixedCode: it.prefixedCode,
        board,
        t0,
        tag: tag.newUpTrend,
        category: "newPool",
        dedupKey,
      });
    }
  }

  return {
    items,
    total: pool.total,
    date: beijingDate(),
    elapsedMs: Date.now() - start,
  };
}

// ============================================================
// 存储
// ============================================================

/**
 * 将抓取结果写入 DB（按 date+code+category upsert）。返回实际写入条数。
 * DB 不可用时返回 0（不抛错，调用方继续）。
 */
export async function storeEtfTrendData(
  result: EtfTrendFetchResult
): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) {
    console.warn("[etf-trend] 数据库不可用，跳过存储");
    return 0;
  }

  let written = 0;
  for (const it of result.items) {
    try {
      await prisma.etfTrend.upsert({
        where: {
          date_code_category: {
            date: result.date,
            code: it.code,
            category: it.category,
          },
        },
        create: {
          date: result.date,
          code: it.code,
          name: it.name,
          prefixedCode: it.prefixedCode,
          board: it.board,
          t0: it.t0,
          tag: it.tag,
          category: it.category,
          dedupKey: it.dedupKey,
        },
        update: {
          name: it.name,
          prefixedCode: it.prefixedCode,
          board: it.board,
          t0: it.t0,
          tag: it.tag,
          dedupKey: it.dedupKey,
        },
      });
      written++;
    } catch (err) {
      console.error(
        `[etf-trend] 写 ${it.code}/${it.category} 失败:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  console.log(
    `[etf-trend] 已存储 ${written}/${result.items.length} 条 (${result.date})`
  );
  return written;
}

// ============================================================
// 读取（从 DB，应用同类去重）
// ============================================================

/**
 * 读取某日 ETF 主升浪数据（已按 dedupKey 去重，每组一只）。
 * 不传 date 时取当日；当日无数据则回退到最近一次快照。
 */
export async function getEtfTrendData(date?: string): Promise<EtfTrendResult | null> {
  const prisma = getPrisma();
  if (!prisma) {
    return null;
  }

  const targetDate = date ?? beijingDate();
  let rows = await prisma.etfTrend.findMany({
    where: { date: targetDate },
  });

  let usedDate = targetDate;
  let fetchedAt: string | null = null;

  // 当日无数据 → 回退到最近一次快照
  if (rows.length === 0) {
    const latest = await prisma.etfTrend.findFirst({
      orderBy: { date: "desc" },
    });
    if (!latest) {
      return null;
    }
    usedDate = latest.date;
    rows = await prisma.etfTrend.findMany({ where: { date: usedDate } });
  }

  if (rows.length === 0) {
    return null;
  }

  // 取该批数据的落库时间（取最新一条的 fetchedAt）
  fetchedAt = rows
    .map((r) => r.fetchedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0]
    ?.toISOString() ?? null;

  // 统计池总数（取当日 pullback+newPool 去重 code 数；近似总数用最新日期的 distinct code）
  const totalCodes = new Set(rows.map((r) => r.code)).size;

  const toItem = (r: typeof rows[number]): EtfTrendItem => ({
    code: r.code,
    name: r.name,
    prefixedCode: r.prefixedCode,
    board: (r.board as "SH" | "SZ" | null) ?? null,
    t0: r.t0,
    tag: r.tag,
    category: r.category as EtfCategory,
    dedupKey: r.dedupKey,
  });

  const pullbackAll = rows
    .filter((r) => r.category === "pullback")
    .map(toItem);
  const newPoolAll = rows
    .filter((r) => r.category === "newPool")
    .map(toItem);

  return {
    pullback: dedupItems(pullbackAll),
    newPool: dedupItems(newPoolAll),
    total: totalCodes,
    date: usedDate,
    fetchedAt: fetchedAt ?? new Date().toISOString(),
  };
}
