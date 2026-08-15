/**
 * ETF 基金数据抓取（东方财富数据源，best-effort 容错）
 *
 * 把「主升浪池里的 ETF」喂进估值+质量评估引擎前，先在这里把原始数据补齐：
 *   - 实时指标（push2，不带 fltt）：规模(f116) / 股息率(f171) / PE/PB(f162/f167，ETF 多为"-")
 *   - 基金概况 HTML（jjgk）：管理费 / 托管费 / 跟踪标的 / 跟踪误差
 *   - 跟踪指数 PE/PB（push2，用跟踪标的映射的指数 secid）
 *
 * 重要：ETF 在 push2 的 f162/f167/f185 常为字符串 "-"（ETF 自身无 PE/PB/成交额），
 * 因此所有数值解析都走 num() 守卫，非数字/非有限值一律置 null，绝不产生 NaN。
 * 估值分位优先用东方财富估值中心 RPT_VALUEANALYSIS_DET 的「指数每日 PE/PB 历史」
 * 本地计算真实百分位（proxy=false）；该表未覆盖的指数（如沪深300/创业板）才退化为
 * 「当前 PE/PB ÷ 估值天花板」代理分位（proxy=true），保持可用且诚实标注。
 *
 * ETF 的东方财富 secid 规则与个股一致：沪市(5/6 开头) 前缀 1.，深市(1 开头) 前缀 0.
 */

import type {
  EtfValuationInput,
  EtfQualityInput,
} from "./etf-evaluate";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 10 年期国债收益率（%）—— 估值安全垫对比基准，可按需调整 */
export const DEFAULT_BOND_YIELD = 2.5;

/** 估值天花板（代理分位用）：PE / PB 超过此值即视为 100% 分位（很贵） */
const PE_CEILING = 30;
const PB_CEILING = 3.5;

export type EtfBoard = "SH" | "SZ" | null;

/** ETF 6 位代码 + 市场 → 东方财富 secid */
export function etfSecid(code: string, board: EtfBoard): string {
  const prefix = board === "SZ" ? "0" : "1"; // 沪市默认 1.，深市 0.
  return `${prefix}.${code}`;
}

// ============================================================
// 常见跟踪指数名 → 东方财富指数 secid（用于取指数 PE/PB 做估值）
// ============================================================

const INDEX_KEYWORDS: Array<{ kw: string; secid: string }> = [
  { kw: "沪深300", secid: "1.000300" },
  { kw: "中证500", secid: "1.000905" },
  { kw: "中证1000", secid: "1.000852" },
  { kw: "上证50", secid: "1.000016" },
  { kw: "上证180", secid: "1.000010" },
  { kw: "科创50", secid: "1.000688" },
  { kw: "科创100", secid: "1.000698" },
  { kw: "创业板指", secid: "0.399006" },
  { kw: "创业板50", secid: "0.399673" },
  { kw: "深证100", secid: "0.399330" },
  { kw: "中证红利", secid: "1.000922" },
  { kw: "上证红利", secid: "1.000015" },
  { kw: "券商", secid: "1.399975" },
  { kw: "证券", secid: "1.399975" },
  { kw: "白酒", secid: "1.399997" },
  { kw: "消费", secid: "1.000932" },
  { kw: "医药", secid: "1.000933" },
  { kw: "医疗", secid: "1.399989" },
  { kw: "新能源车", secid: "1.399976" },
  { kw: "新能源", secid: "1.399808" },
  { kw: "光伏", secid: "1.399808" },
  { kw: "半导体", secid: "1.990001" },
  { kw: "芯片", secid: "1.990001" },
  { kw: "军工", secid: "1.399967" },
  { kw: "银行", secid: "1.399986" },
  { kw: "保险", secid: "1.399808" },
  { kw: "地产", secid: "1.399200" },
  { kw: "煤炭", secid: "1.399998" },
  { kw: "有色", secid: "1.399395" },
  { kw: "钢铁", secid: "1.399440" },
  { kw: "化工", secid: "1.000813" },
  { kw: "农业", secid: "1.399814" },
  { kw: "传媒", secid: "1.399971" },
  { kw: "计算机", secid: "1.399997" },
  { kw: "5G", secid: "1.399994" },
  { kw: "人工智能", secid: "1.930713" },
  { kw: "机器人", secid: "1.399989" },
  { kw: "中证科技", secid: "1.931087" },
  { kw: "纳斯达克", secid: "100.NDX" },
  { kw: "标普", secid: "100.SPX" },
];

function resolveIndexSecid(trackName: string | null): string | null {
  if (!trackName) return null;
  for (const { kw, secid } of INDEX_KEYWORDS) {
    if (trackName.includes(kw)) return secid;
  }
  return null;
}

// ============================================================
// 数值守卫：拒 "-" / undefined / NaN / 非有限
// ============================================================

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (v.trim() === "" || v.trim() === "-") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 元 → 亿元 */
const toYi = (v: unknown) => {
  const n = num(v);
  return n != null ? n / 1e8 : null;
};
/** 元 → 万元 */
const toWan = (v: unknown) => {
  const n = num(v);
  return n != null ? n / 1e4 : null;
};
/** 百分比原值(×100) → 百分比数字（如 87 → 0.87 表示 0.87%） */
const toPctRaw = (v: unknown) => {
  const n = num(v);
  return n != null ? n / 100 : null;
};

// ============================================================
// 抓取
// ============================================================

interface Push2Resp {
  data?: Record<string, number | string | null>;
}

async function fetchJson<T>(
  url: string,
  referer: string,
  timeoutMs = 12000
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 取 ETF 实时指标（push2，不带 fltt，保留原始单位） */
async function fetchEtfMarket(
  secid: string
): Promise<Push2Resp["data"] | null> {
  const fields = "f43,f57,f58,f116,f162,f167,f171,f185,f164";
  const json = await fetchJson<Push2Resp>(
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}&invt=2`,
    "https://quote.eastmoney.com/"
  );
  return json?.data ?? null;
}

/** 取指数实时 PE/PB（push2，原始单位 ×100） */
export async function fetchIndexPePb(
  secid: string
): Promise<{ pe: number | null; pb: number | null }> {
  const fields = "f162,f167";
  const json = await fetchJson<Push2Resp>(
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}&invt=2`,
    "https://quote.eastmoney.com/"
  );
  const d = json?.data;
  return {
    pe: num(d?.f162) != null ? (num(d?.f162) as number) / 100 : null,
    pb: num(d?.f167) != null ? (num(d?.f167) as number) / 100 : null,
  };
}

/** 取基金概况 HTML（概况页可达；ETF 的 PE/PB 取不到时靠跟踪指数补） */
async function fetchFundHtml(code: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://fundf10.eastmoney.com/jjgk_${code}.html`,
      {
        headers: { "User-Agent": UA, Referer: "https://fundf10.eastmoney.com/" },
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // 东方财富概况页多为 gb2312，UTF-8 解析失败再回退 gbk
    let s = new TextDecoder("utf-8").decode(buf);
    if (!/跟踪标的|管理费/.test(s)) {
      s = new TextDecoder("gbk").decode(buf);
    }
    return s;
  } catch {
    return null;
  }
}

function parseFundHtml(html: string): {
  mgmtFeePct: number | null;
  custodyFeePct: number | null;
  trackIndexName: string | null;
  trackErrorPct: number | null;
} {
  const m = (re: RegExp): number | null => {
    const mm = html.match(re);
    return mm ? num(mm[1]) : null;
  };
  const name = (re: RegExp): string | null => {
    const mm = html.match(re);
    return mm && mm[1] ? mm[1].trim() : null;
  };
  return {
    mgmtFeePct: m(/管理费[：:>\s]*([\d.]+)\s*%/),
    custodyFeePct: m(/托管费[：:>\s]*([\d.]+)\s*%/),
    trackIndexName: name(/跟踪标的[：:>\s]*([\u4e00-\u9fa5A-Za-z0-9]+)/),
    trackErrorPct: m(/跟踪误差[：:>\s]*([\d.]+)\s*%/),
  };
}

// ============================================================
// 真实历史分位：抓指数每日 PE/PB 历史，本地算当前值所处百分位
// （比「当前值 ÷ 硬编码天花板」的代理分位准确得多）
// ============================================================

interface IndexValuationHistory {
  /** 每日 PE(TTM) 序列（按日期升序，已过滤非有限/非正） */
  pe: number[];
  /** 每日 PB(MRQ) 序列（按日期升序） */
  pb: number[];
  /** 最新交易日 PE/PB（即「当前值」） */
  latestPe: number | null;
  latestPb: number | null;
  ok: boolean;
}

/**
 * 抓指数的每日 PE/PB 历史（东方财富估值中心 RPT_VALUEANALYSIS_DET）。
 * 用指数 6 位代码（非 push2 secid）查询；一次拉全（≤5000 行）。按日期升序返回，
 * 末行即最新，latestPe/latestPb 为「当前值」。
 * 注意：该表并非覆盖所有指数（沪深300/创业板等主流指数常缺失），缺失时 ok=false。
 */
export async function fetchIndexValuationHistory(plainCode: string): Promise<IndexValuationHistory> {
  const filter = `(SECURITY_CODE="${plainCode}")`;
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get" +
    `?reportName=RPT_VALUEANALYSIS_DET&columns=SECURITY_CODE,TRADE_DATE,PE_TTM,PB_MRQ` +
    `&filter=${encodeURIComponent(filter)}&pageSize=5000&sortColumns=TRADE_DATE&sortTypes=1`;
  const json = await fetchJson<{ result?: { data?: Array<Record<string, unknown>> } }>(
    url,
    "https://data.eastmoney.com/",
    15000
  );
  const rows = json?.result?.data;
  if (!rows || rows.length === 0)
    return { pe: [], pb: [], latestPe: null, latestPb: null, ok: false };
  const pe: number[] = [];
  const pb: number[] = [];
  let latestPe: number | null = null;
  let latestPb: number | null = null;
  for (const r of rows) {
    const p = num(r.PE_TTM);
    const b = num(r.PB_MRQ);
    if (p != null && p > 0) {
      pe.push(p);
      latestPe = p; // 升序，最后一条有效值即最新
    }
    if (b != null && b > 0) {
      pb.push(b);
      latestPb = b;
    }
  }
  return { pe, pb, latestPe, latestPb, ok: pe.length > 0 };
}

/**
 * 当前值在历史序列中的百分位（0~100，越高越贵）：
 * 历史上 ≤ 当前值的交易日占比。
 * 先剔除极端离群点（>5×中位数 或 <中位数/5），避免脏数据（如个别交易日 PE 异常）
 * 污染分位。分位是「排名」概念，与绝对数值量纲无关，故即使序列整体量纲与
 * 实时行情略有差异，只要同一序列内自洽，分位依然有效。
 */
export function computePercentile(current: number, history: number[]): number | null {
  if (!history.length || !Number.isFinite(current) || current <= 0) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const lo = med / 5;
  const hi = med * 5;
  const base = history.filter((h) => h >= lo && h <= hi);
  const use = base.length >= 10 ? base : history;
  const below = use.filter((h) => h <= current).length;
  return (below / use.length) * 100;
}

// ============================================================
// 代理分位（兜底）：当前 PE/PB ÷ 估值天花板
// ============================================================

export function proxyPercentile(pe: number | null, pb: number | null): {
  pePct: number | null;
  pbPct: number | null;
} {
  const clampPct = (v: number) => Math.max(0, Math.min(100, v));
  return {
    pePct: pe != null && pe > 0 ? clampPct((pe / PE_CEILING) * 100) : null,
    pbPct: pb != null && pb > 0 ? clampPct((pb / PB_CEILING) * 100) : null,
  };
}

// ============================================================
// 主入口
// ============================================================

export interface EtfFundData {
  code: string;
  name: string | null;
  valuation: EtfValuationInput;
  quality: EtfQualityInput;
  /** 抓取到的原始值（供调试/展示） */
  raw: {
    scaleYi: number | null;
    dailyTurnoverWan: number | null;
    pe: number | null;
    pb: number | null;
    dividendYieldPct: number | null;
    feeRatePct: number | null;
    trackingErrorPct: number | null;
    premiumDiscountPct: number | null;
    trackIndexName: string | null;
    proxy: boolean;
  };
}

/**
 * 把已抓取到的原始数据组装成评估引擎输入（纯解析，无网络）。
 * 估值优先用「跟踪指数」的 PE/PB；拿不到指数时退化为 ETF 自身 PE/PB（代理）。
 * 拆分为纯函数便于离线单测（见 scripts/etf-evaluate-demo.ts）。
 */
export async function assembleEtfFundData(
  code: string,
  board: EtfBoard,
  market: Push2Resp["data"] | null,
  html: string | null,
  bondYieldPct: number = DEFAULT_BOND_YIELD
): Promise<EtfFundData> {
  const scaleYi = toYi(market?.f116);
  const dailyTurnoverWan = toWan(market?.f185);
  const etfPe = num(market?.f162) != null ? (num(market?.f162) as number) / 100 : null;
  const etfPb = num(market?.f167) != null ? (num(market?.f167) as number) / 100 : null;
  const dividendYieldPct = toPctRaw(market?.f171);

  // 折溢价：IOPV 与现价偏差（best-effort，多数 ETF 无 f164）
  let premiumDiscountPct: number | null = null;
  const f43 = num(market?.f43);
  const f164 = num(market?.f164);
  if (f43 != null && f164 != null && f164 > 0) {
    premiumDiscountPct = ((f43 - f164) / f164) * 100;
  }

  // 费率 / 跟踪误差 / 跟踪标的（来自概况 HTML）
  const parsed = html ? parseFundHtml(html) : null;
  const feeRatePct =
    parsed?.mgmtFeePct != null && parsed?.custodyFeePct != null
      ? parsed.mgmtFeePct + parsed.custodyFeePct
      : parsed?.mgmtFeePct ?? null;
  const trackingErrorPct = parsed?.trackErrorPct ?? null;

  // 估值：优先指数 PE/PB
  const trackIndexName = parsed?.trackIndexName ?? null;
  const indexSecid = resolveIndexSecid(trackIndexName);
  let peUsed: number | null = etfPe;
  let pbUsed: number | null = etfPb;

  // 分位：优先用「指数每日 PE/PB 历史」算真实百分位；拿不到历史才退代理
  let pePct: number | null = null;
  let pbPct: number | null = null;
  let peFromHistory = false;

  if (indexSecid) {
    const idx = await fetchIndexPePb(indexSecid).catch(() => null);
    if (idx?.pe != null) peUsed = idx.pe;
    if (idx?.pb != null) pbUsed = idx.pb;

    const plain = indexSecid.split(".")[1];
    const hist = await fetchIndexValuationHistory(plain).catch(() => null);
    if (hist && hist.pe.length > 0) {
      const curPe = peUsed ?? hist.latestPe ?? hist.pe[hist.pe.length - 1];
      pePct = computePercentile(curPe, hist.pe);
      peFromHistory = true;
    }
    if (hist && hist.pb.length > 0) {
      const curPb = pbUsed ?? hist.latestPb ?? hist.pb[hist.pb.length - 1];
      pbPct = computePercentile(curPb, hist.pb);
    }
  }

  // 历史分位缺失的维度 → 代理分位兜底（当前 PE/PB ÷ 天花板）
  const proxyP = proxyPercentile(peUsed, pbUsed);
  if (pePct == null) pePct = proxyP.pePct;
  if (pbPct == null) pbPct = proxyP.pbPct;
  // 仅当 PE 真实分位可用时，整体视为「真实分位」（PE 是估值主指标）
  const proxy = !peFromHistory;

  return {
    code,
    name: market?.f58 != null ? String(market.f58) : null,
    valuation: {
      indexPePercentile: pePct,
      indexPbPercentile: pbPct,
      dividendYieldPct,
      bondYieldPct,
      epsRevisionUpPct: null, // 暂无便捷数据源
      proxy,
    },
    quality: {
      scaleYi,
      dailyTurnoverWan,
      premiumDiscountPct,
      trackingErrorPct,
      feeRatePct,
    },
    raw: {
      scaleYi,
      dailyTurnoverWan,
      pe: etfPe,
      pb: etfPb,
      dividendYieldPct,
      feeRatePct,
      trackingErrorPct,
      premiumDiscountPct,
      trackIndexName,
      proxy,
    },
  };
}

/**
 * 抓单只 ETF 的数据并组装成评估引擎输入（网络版）。
 * 并行抓 ETF 实时 + 基金概况，再交给 assembleEtfFundData 解析。
 */
export async function fetchEtfFundData(
  code: string,
  board: EtfBoard,
  bondYieldPct: number = DEFAULT_BOND_YIELD
): Promise<EtfFundData> {
  const secid = etfSecid(code, board);
  const [market, html] = await Promise.all([
    fetchEtfMarket(secid).catch(() => null),
    fetchFundHtml(code).catch(() => null),
  ]);
  return assembleEtfFundData(code, board, market, html, bondYieldPct);
}
