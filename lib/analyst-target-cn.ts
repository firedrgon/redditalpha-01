/**
 * A 股分析师目标价 + 实时现价（东方财富，免 key）
 *
 * 目标价数据源（已实测）：
 *   GET https://reportapi.eastmoney.com/report/list
 *       ?code=600519&qType=0&pageSize=50&pageNo=1
 *       &beginTime=2025-08-08&endTime=2026-08-08&industryCode=*&industry=*&p=1&pageNum=1
 *   返回 { hits, data: [ { orgCode, orgSName, publishDate, indvAimPriceT, indvAimPriceL, ... } ] }
 *   - indvAimPriceT: 研报给出的目标价（上限），字符串，常为空
 *   - indvAimPriceL: 目标价下限，字符串，常与 T 相同
 *
 * 注意：A 股券商研报**大多不给显式目标价**（实测覆盖率约 10%~35%，
 * 越是热门股覆盖越好）。因此目标价缺失是常态，调用方需按 null 处理。
 *
 * 聚合口径：
 *   近 365 天研报 → 取有目标价的 → 按机构（orgCode）去重保留最新一篇
 *   → 均价 / 最高 / 最低 / 机构家数
 *
 * 现价数据源（已实测）：
 *   GET https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f12&secids=1.600519,0.002156
 *   secid 前缀：1=沪市，0=深市
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
}

const EMPTY: CNAnalystTarget = {
  targetPrice: null,
  targetHigh: null,
  targetLow: null,
  analystCount: null,
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

/**
 * 抓取单只 A 股的分析师目标价共识。
 * 任何失败（网络/结构异常/无目标价）均返回全 null，不抛错。
 *
 * @param code 6 位股票代码，如 "600519"
 * @param lookbackDays 研报回溯天数，默认 365
 */
export async function fetchCNAnalystTarget(
  code: string,
  lookbackDays = 365
): Promise<CNAnalystTarget> {
  const clean = String(code).replace(/\D/g, "");
  if (clean.length !== 6) return { ...EMPTY };

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
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * 批量抓取分析师目标价（限制并发，避免打爆东方财富）。
 * @returns Map<6位代码, CNAnalystTarget>，仅包含成功且有目标价的项
 */
export async function fetchCNAnalystTargetsBatch(
  codes: string[],
  concurrency = 6
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

  console.log(`[analyst-target-cn] 目标价 ${out.size}/${list.length} 只有券商给出`);
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
