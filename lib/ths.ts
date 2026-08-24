/**
 * 同花顺金融数据 API 客户端（fuyao.aicubes.cn）
 *
 * 关键能力（已用真实请求验证）：
 *  - 指数成分股：GET /api/a-share-index/constituents/ths-stock-list
 *  - 指数历史日 K 线：GET /api/a-share-index/prices/historical（跨度 ≤10 年，指数无复权语义）
 *  - 标的检索（中文名 → thscode）：GET /api/meta/tickers/search
 *  - 指数行情快照 / A 股行情快照等
 *
 * 重要边界（实测）：
 *  - 仅覆盖 A 股个股与指数；ETF 自身的 thscode（如 159051.SZ）在行情/历史 K 线接口返回
 *    "Unknown thscode"，因此本客户端只用于「指数级」数据（行业/主题 proxy + 标准指数）。
 *  - 某 ETF 的精确跟踪指数（如「中证全指医疗器械指数」）常不在同花顺目录，此时自动回退到
 *    同花顺行业/概念指数（881xxx.TI，如「医疗器械」）作为行业 proxy。
 *
 * 鉴权：请求头 X-api-key，Base https://fuyao.aicubes.cn。key 仅来自环境变量 THS_API_KEY，
 * 不写进代码或前端。统一响应信封 { code, message, data }，HTTP 恒 200，业务错误经 code 表达。
 */

const THS_BASE = "https://fuyao.aicubes.cn";

function thsHeaders(): Record<string, string> {
  const key = process.env.THS_API_KEY;
  return { "X-api-key": key ?? "", "Content-Type": "application/json" };
}

interface ThsEnvelope<T> {
  code: number;
  message: string;
  data?: T;
}

async function thsGet<T>(
  path: string,
  qs: Record<string, string> = {}
): Promise<T | null> {
  const url = `${THS_BASE}${path}?${new URLSearchParams(qs).toString()}`;
  try {
    const res = await fetch(url, {
      headers: thsHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as ThsEnvelope<T>;
    if (json.code !== 0 || !json.data) return null;
    return json.data;
  } catch {
    return null;
  }
}

export interface ThsTicker {
  thscode: string;
  ticker: string;
  name: string;
}

/** 标的检索：按中文名/代码模糊搜，可选资产类型过滤 */
export async function thsSearch(
  q: string,
  assetType?: string
): Promise<ThsTicker[]> {
  const qs: Record<string, string> = { q, limit: "20" };
  if (assetType) qs.asset_type = assetType;
  const d = await thsGet<{ item?: ThsTicker[] }>(
    "/api/meta/tickers/search",
    qs
  );
  return d?.item ?? [];
}

/**
 * 从指数名/ETF 名提取行业/主题关键词，用于同名指数缺失时回退检索。
 * 例：「中证全指医疗器械指数」→「医疗器械」；「沪深300」→「300」（仅作兜底，罕见触发）。
 */
function indexKeyword(name: string): string {
  let s = name.trim();
  for (const p of ["中证", "国证", "上证", "深证", "沪深", "全指"]) {
    if (s.startsWith(p)) s = s.slice(p.length);
  }
  for (const suf of ["指数ETF", "指数", "ETF", "etf", "主题", "联接", "LOF", "基金"]) {
    if (s.endsWith(suf)) s = s.slice(0, s.length - suf.length);
  }
  return s.trim();
}

/**
 * 把「ETF 跟踪指数名」解析为同花顺 thscode。
 * 流程：① 精确名搜 a-share-index；② 失败则取行业关键词搜，优先选同花顺行业/概念指数（.TI）。
 * 返回 proxy=true 表示用的是同花顺行业指数 proxy（非精确跟踪指数）。
 */
export async function resolveIndustryIndexThsCode(
  trackIndexName: string | null,
  etfName: string | null
): Promise<{ thsCode: string | null; indexName: string | null; proxy: boolean }> {
  if (!trackIndexName) return { thsCode: null, indexName: null, proxy: false };

  const exact = await thsSearch(trackIndexName, "a-share-index");
  if (exact.length) {
    return { thsCode: exact[0].thscode, indexName: exact[0].name, proxy: false };
  }

  const kw = indexKeyword(trackIndexName) || (etfName ? indexKeyword(etfName) : "");
  if (kw && kw.length >= 2) {
    const r = await thsSearch(kw, "a-share-index");
    const pref = r.filter(
      (x) => x.thscode.endsWith(".TI") && (x.name === kw || x.name.includes(kw))
    );
    const pick = pref[0] || r.find((x) => x.thscode.endsWith(".TI")) || r[0] || null;
    if (pick) return { thsCode: pick.thscode, indexName: pick.name, proxy: true };
  }
  return { thsCode: null, indexName: null, proxy: false };
}

export interface ThsConstituent {
  thscode: string;
  ticker: string;
  name: string;
}

/** 指数成分股名单（同花顺不返回权重，权重需另由东财 ccmx 补） */
export async function fetchIndexConstituents(
  thsCode: string
): Promise<ThsConstituent[]> {
  const d = await thsGet<{
    item?: Array<{ thscode: string; ticker: string; name: string }>;
  }>("/api/a-share-index/constituents/ths-stock-list", { thscode: thsCode });
  return d?.item ?? [];
}

export interface ThsKlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function fmtDate(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/** 指数历史日 K 线（无复权；volume 指数常为空，close 为主用字段） */
export async function fetchIndexKline(
  thsCode: string,
  startMs: number,
  endMs: number
): Promise<ThsKlineBar[]> {
  const d = await thsGet<{
    item?: Array<{
      date_ms: number;
      open_price: number;
      high_price: number;
      low_price: number;
      close_price: number;
      volume: number;
    }>;
  }>("/api/a-share-index/prices/historical", {
    thscode: thsCode,
    interval: "1d",
    start: String(startMs),
    end: String(endMs),
  });
  const arr = d?.item ?? [];
  return arr
    .filter((b) => Number.isFinite(b.close_price))
    .map((b) => ({
      date: fmtDate(b.date_ms),
      open: b.open_price,
      high: b.high_price,
      low: b.low_price,
      close: b.close_price,
      volume: b.volume,
    }));
}
