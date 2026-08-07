/**
 * A 股分析师目标价 + 实时现价（免 key）
 *
 * ── 目标价主源：百度财经开放接口（已实测，覆盖率碾压研报聚合）────────────
 *   GET https://finance.baidu.com/opendata?openapi=1&dspName=iphone&tn=tangram
 *       &client=app&query={code}&code={code}&word={code}&resource_id=5429
 *       &ma_ver=4&finClientType=pc
 *   响应结构深且索引不固定 → 递归搜 `organRating`：
 *     { organNum, avgPrice, maxPrice, minPrice, curPrice,
 *       body:[{organ,date,rating,price}] }
 *   这是券商机构一致预期口径，实测 600519=119家 / 000001=126家 / 601318=83家。
 *   注意：单次响应约 600KB（整页数据包），批量时需控制并发。
 *   同源的 HTML 页面 finance.baidu.com/stock/ab-{code} 在服务器环境会 403，
 *   但本 opendata 接口不受影响（lib/finance.ts 已长期在用）。
 *
 * ── 目标价降级源：东方财富研报聚合 ──────────────────────────────────
 *   GET https://reportapi.eastmoney.com/report/list?code=600519&qType=0...
 *   取近 365 天研报中 indvAimPriceT/L 有值的，按机构（orgCode）去重保留最新
 *   一篇后求均价/上下沿。A 股券商研报大多不给显式目标价，实测覆盖率仅
 *   10%~35%（000001 平安银行为 0），故仅作百度失败时的兜底。
 *
 * ── 现价数据源（已实测）───────────────────────────────────────────
 *   GET https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f12
 *       &secids=1.600519,0.002156      （secid 前缀：1=沪市，0=深市）
 *   百度 organRating.curPrice 亦可作兜底。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface CNAnalystTarget {
  /** 机构一致目标价（均价，元） */
  targetPrice: number | null;
  /** 目标价上沿（元） */
  targetHigh: number | null;
  /** 目标价下沿（元） */
  targetLow: number | null;
  /** 给出目标价的机构家数 */
  analystCount: number | null;
  /** 数据源标识，便于排查 */
  source?: "baidu" | "eastmoney" | null;
  /** 数据源附带的现价（元），仅百度提供，可作现价兜底 */
  currentPrice?: number | null;
}

const EMPTY: CNAnalystTarget = {
  targetPrice: null,
  targetHigh: null,
  targetLow: null,
  analystCount: null,
  source: null,
  currentPrice: null,
};

interface EmReportRow {
  orgCode?: string;
  orgSName?: string;
  publishDate?: string;
  indvAimPriceT?: string;
  indvAimPriceL?: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 递归搜索嵌套对象中指定 key 的值（返回第一个命中） */
function findNestedKey(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (key in rec) return rec[key];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findNestedKey(item, key);
      if (found !== undefined) return found;
    }
  } else {
    for (const v of Object.values(rec)) {
      const found = findNestedKey(v, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * 【主源】百度财经开放接口获取机构一致目标价。
 * 覆盖率远高于研报聚合，且附带现价。失败返回全 null。
 *
 * 本函数是项目内百度目标价的**唯一实现**，lib/finance.ts 的
 * fetchBaiduFinanceAnalystRating 是它的薄适配层，勿再另写一份。
 *
 * @param clean 6 位纯数字股票代码
 */
export async function fetchBaiduAnalystTarget(
  clean: string
): Promise<CNAnalystTarget> {
  const url =
    `https://finance.baidu.com/opendata?openapi=1&dspName=iphone&tn=tangram` +
    `&client=app&query=${clean}&code=${clean}&word=${clean}` +
    `&resource_id=5429&ma_ver=4&finClientType=pc`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ...EMPTY };

    const json = await res.json();
    const organRating = findNestedKey(json, "organRating");
    if (!organRating || typeof organRating !== "object") return { ...EMPTY };

    const or = organRating as Record<string, unknown>;
    const targetPrice = toNum(or.avgPrice);
    const targetHigh = toNum(or.maxPrice);
    const targetLow = toNum(or.minPrice);
    if (targetPrice == null && targetHigh == null && targetLow == null) {
      return { ...EMPTY };
    }

    return {
      targetPrice,
      targetHigh,
      targetLow,
      analystCount: toNum(or.organNum),
      source: "baidu",
      currentPrice: toNum(or.curPrice),
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * 抓取单只 A 股的分析师目标价共识：百度财经优先，失败降级东方财富研报聚合。
 * 任何失败（网络/结构异常/无目标价）均返回全 null，不抛错。
 *
 * @param code 6 位股票代码，如 "600519"
 * @param lookbackDays 东财降级路径的研报回溯天数，默认 365
 */
export async function fetchCNAnalystTarget(
  code: string,
  lookbackDays = 365
): Promise<CNAnalystTarget> {
  const clean = String(code).replace(/\D/g, "");
  if (clean.length !== 6) return { ...EMPTY };

  const baidu = await fetchBaiduAnalystTarget(clean);
  if (baidu.targetPrice != null) return baidu;

  return fetchEastmoneyAnalystTarget(clean, lookbackDays);
}

/**
 * 【降级源】东方财富研报聚合目标价。
 * A 股券商研报大多不给显式目标价，覆盖率有限，仅作百度失败兜底。
 */
async function fetchEastmoneyAnalystTarget(
  clean: string,
  lookbackDays = 365
): Promise<CNAnalystTarget> {
  const end = new Date();
  const begin = new Date(end.getTime() - lookbackDays * 86400000);
  const url =
    `https://reportapi.eastmoney.com/report/list?` +
    `code=${clean}&qType=0&pageSize=50&pageNo=1&pageNum=1&p=1` +
    `&beginTime=${ymd(begin)}&endTime=${ymd(end)}` +
    `&industryCode=*&industry=*&rating=&ratingChange=&fields=&orgCode=&rcode=`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return { ...EMPTY };

    const json = (await res.json()) as { data?: EmReportRow[] };
    const rows = Array.isArray(json?.data) ? json.data : [];
    if (!rows.length) return { ...EMPTY };

    // 同一机构可能多篇研报 → 只保留最新一篇，避免高频覆盖的券商拉偏均值
    const byOrg = new Map<string, { price: number; publishDate: string }>();
    for (const r of rows) {
      const price = toNum(r.indvAimPriceT) ?? toNum(r.indvAimPriceL);
      if (price == null) continue;
      const key = r.orgCode || r.orgSName || "";
      if (!key) continue;
      const publishDate = r.publishDate ?? "";
      const prev = byOrg.get(key);
      if (!prev || publishDate > prev.publishDate) byOrg.set(key, { price, publishDate });
    }

    const vals = [...byOrg.values()].map((v) => v.price);
    if (!vals.length) return { ...EMPTY };

    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      targetPrice: Math.round((sum / vals.length) * 100) / 100,
      targetHigh: Math.max(...vals),
      targetLow: Math.min(...vals),
      analystCount: vals.length,
      source: "eastmoney",
      currentPrice: null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * 批量抓取分析师目标价（限制并发）。
 * 百度单次响应约 600KB，并发不宜过高，默认 5。
 * @returns Map<6位代码, CNAnalystTarget>，仅包含成功且有目标价的项
 */
export async function fetchCNAnalystTargetsBatch(
  codes: string[],
  concurrency = 5
): Promise<Map<string, CNAnalystTarget>> {
  const out = new Map<string, CNAnalystTarget>();
  const list = [...new Set(codes.map((c) => String(c).replace(/\D/g, "")))].filter(
    (c) => c.length === 6
  );
  if (!list.length) return out;

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, list.length) },
    async () => {
      while (cursor < list.length) {
        const code = list[cursor++];
        const t = await fetchCNAnalystTarget(code);
        if (t.targetPrice != null) out.set(code, t);
      }
    }
  );
  await Promise.all(workers);

  let baiduN = 0;
  let emN = 0;
  for (const t of out.values()) {
    if (t.source === "baidu") baiduN++;
    else if (t.source === "eastmoney") emN++;
  }
  console.log(
    `[analyst-target-cn] 目标价 ${out.size}/${list.length}（百度 ${baiduN} / 东财兜底 ${emN}）`
  );
  return out;
}

/** 6 位代码 → 东方财富 secid 前缀（1=沪，0=深） */
function secidOf(code: string): string {
  return /^(60|68|90|58|11)/.test(code) ? `1.${code}` : `0.${code}`;
}

/**
 * 批量获取 A 股现价（一次请求最多 100 只，自动分块）。
 * @returns Map<6位代码, 现价（元）>
 */
export async function fetchCNPricesBatch(
  codes: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const list = [...new Set(codes.map((c) => String(c).replace(/\D/g, "")))].filter(
    (c) => c.length === 6
  );
  if (!list.length) return out;

  const CHUNK = 80;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const url =
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f12` +
      `&secids=${chunk.map(secidOf).join(",")}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        data?: { diff?: { f2?: number | string; f12?: string }[] };
      };
      for (const d of json?.data?.diff ?? []) {
        const price = toNum(d.f2);
        if (d.f12 && price != null) out.set(String(d.f12), price);
      }
    } catch {
      // 单块失败忽略，其余继续
    }
  }

  console.log(`[analyst-target-cn] 现价 ${out.size}/${list.length}`);
  return out;
}
