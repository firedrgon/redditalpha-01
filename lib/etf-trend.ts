/**
 * ETF 主升浪池：抓取 + 分类
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
 *        - ifund_etf_t0                 → show_tag 含 "T+0"
 *        - ifund_biz_last_day_step_signal → show_tag 含 "回踩"   → 趋势回踩
 *        - ifund_biz_new_up_trend       → show_tag 含 "新入池"   → 新入池
 *
 * 抓取为实时按需调用（不落库），约 2 秒内完成（5 个分块并行/串行）。
 */

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
}

export interface EtfTrendResult {
  /** 趋势回踩列表 */
  pullback: EtfTrendItem[];
  /** 新入池列表 */
  newPool: EtfTrendItem[];
  /** 池中 ETF 总数 */
  total: number;
  /** 抓取耗时（ms） */
  elapsedMs: number;
  /** 抓取时间（ISO） */
  fetchedAt: string;
}

/** 6 位 ETF 代码 → 沪/深：5/6 开头沪，1 开头深 */
function inferEtfBoard(code: string): "SH" | "SZ" | null {
  if (/^[56]/.test(code)) return "SH";
  if (/^1/.test(code)) return "SZ";
  return null;
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

interface FundPoolResp {
  status_code?: number;
  data?: {
    total?: number;
    itemList?: unknown[][];
  };
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
  /** "回踩" 等，空字符串表示无信号 */
  stepSignal: string;
  /** "新入池" 等，空字符串表示无信号 */
  newUpTrend: string;
}

/** 第二步：批量获取标签，返回 prefixedCode → 标签映射 */
async function fetchEtfTags(
  prefixedCodes: string[]
): Promise<Map<string, TagEntry>> {
  const map = new Map<string, TagEntry>();

  // 分块串行请求（避免单次请求体过大）
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
      const tagEntry: TagEntry = {
        t0: false,
        stepSignal: "",
        newUpTrend: "",
      };
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
 * 抓取 ETF 主升浪池并按标签分类。
 * - pullback（趋势回踩）：ifund_biz_last_day_step_signal 标签非空
 * - newPool（新入池）：ifund_biz_new_up_trend 标签非空
 * 一只 ETF 可能同时出现在两个分类中（保留各自的标签文案）。
 */
export async function fetchEtfTrendData(): Promise<EtfTrendResult | null> {
  const start = Date.now();

  const pool = await fetchEtfUpTrendPool();
  if (!pool || pool.items.length === 0) {
    return null;
  }

  const tags = await fetchEtfTags(pool.items.map((it) => it.prefixedCode));

  const pullback: EtfTrendItem[] = [];
  const newPool: EtfTrendItem[] = [];

  for (const it of pool.items) {
    const tag = tags.get(it.prefixedCode);
    const t0 = tag?.t0 ?? false;
    const board = inferEtfBoard(it.code);

    if (tag?.stepSignal) {
      pullback.push({
        code: it.code,
        name: it.name,
        prefixedCode: it.prefixedCode,
        board,
        t0,
        tag: tag.stepSignal,
        category: "pullback",
      });
    }
    if (tag?.newUpTrend) {
      newPool.push({
        code: it.code,
        name: it.name,
        prefixedCode: it.prefixedCode,
        board,
        t0,
        tag: tag.newUpTrend,
        category: "newPool",
      });
    }
  }

  return {
    pullback,
    newPool,
    total: pool.total,
    elapsedMs: Date.now() - start,
    fetchedAt: new Date().toISOString(),
  };
}
