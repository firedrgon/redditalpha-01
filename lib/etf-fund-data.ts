/**
 * ETF 基金数据抓取（东方财富数据源，best-effort 容错）
 *
 * 把「主升浪池里的 ETF」喂进估值+质量评估引擎前，先在这里把原始数据补齐：
 *   - 实时指标（push2，不带 fltt）：规模(f116) / 股息率(f171) / PE/PB(f162/f167，ETF 多为"-")
 *   - 基金概况 HTML（jbgk_{code}.html，UTF-8）：管理费 / 托管费 / 跟踪标的 / 基金公司 / 基金经理 / 成立日期
 *     （注意：正确路径是 jbgk 而非 jjgk，后者 404；实际跟踪误差该页取不到，保持 null）
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
  // f48 = 成交额（元），ETF 有效；f185 对 ETF 恒为 "-"，仅作兼容保留。
  // 交叉验证实测：510300 的 f48=3143413605 元 → 314341 万，与腾讯 gtimg 完全一致。
  const fields = "f43,f48,f57,f58,f116,f162,f167,f171,f185,f164";
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
      `https://fundf10.eastmoney.com/jbgk_${code}.html`,
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

export type IndexType = "broad" | "sector" | "strategy" | null;

/** 已知紧随「基金经理人」之后出现的字段名，用作右边界锚点防止越界吞噬 */
const MANAGER_TAIL =
  "成立来分红|管理费率|托管费率|销售服务费率|成立日期|业绩比较基准|基金托管人|基金管理人|跟踪标的";

/**
 * 解析基金经理（可能多位）。
 * jbgk 页原文形如「基金经理人 成曦 、 刘树荣 成立来分红 …」，
 * 抓取全部并归一化为「成曦、刘树荣」。
 */
function parseManagers(text: string): string | null {
  const tryRe = (re: RegExp): string | null => {
    const mm = text.match(re);
    if (!mm || !mm[1]) return null;
    const v = mm[1]
      .replace(/\s*、\s*/g, "、")
      .replace(/\s+/g, "")
      .replace(/^、|、$/g, "")
      .trim();
    return v.length >= 2 ? v : null;
  };
  return (
    tryRe(
      new RegExp(`基金经理人[：:\\s]*([\\u4e00-\\u9fa5·、\\s]{2,60}?)\\s*(?:${MANAGER_TAIL})`)
    ) ??
    tryRe(
      new RegExp(`基金经理[：:]\\s*([\\u4e00-\\u9fa5·、\\s]{2,60}?)\\s*(?:${MANAGER_TAIL})`)
    ) ??
    tryRe(/基金经理[：:]\s*([\u4e00-\u9fa5·、]{2,20})/)
  );
}

function parseFundHtml(html: string): {
  mgmtFeePct: number | null;
  custodyFeePct: number | null;
  trackIndexName: string | null;
  trackErrorPct: number | null;
  fundCompany: string | null;
  fundManager: string | null;
  establishDate: string | null;
} {
  // 去标签转纯文本，避免标签结构干扰正则（jbgk 页面标签嵌套不稳定）。
  // 必须同时解 &nbsp;（页面用它分隔「基金经理：&nbsp;&nbsp;柳军」）并规整空白，
  // 否则冒号与人名之间残留实体会导致匹配失败。
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const m = (re: RegExp): number | null => {
    const mm = text.match(re);
    return mm ? num(mm[1]) : null;
  };
  const name = (re: RegExp): string | null => {
    const mm = text.match(re);
    return mm && mm[1] ? mm[1].trim() : null;
  };
  return {
    mgmtFeePct: m(/管理费率?[：:\s]*([\d.]+)\s*%/),
    custodyFeePct: m(/托管费率?[：:\s]*([\d.]+)\s*%/),
    trackIndexName: name(/跟踪标的[：:\s]*([\u4e00-\u9fa5A-Za-z0-9]+)/),
    // 注意：jbgk 页出现的「跟踪误差」只是基金合同里的目标描述（如"力争控制在…"），
    // 并非实际跟踪误差数值，多数情况取不到 → 保持 null，由评分层按「缺失」处理。
    trackErrorPct: m(/跟踪误差[：:\s]*([\d.]+)\s*%/),
    // 必须锚定右边界（基金托管人/基金经理/成立日期/管理费率），
    // 否则「懒惰量词 + 可空前瞻」会退化成只匹配 1 个字符。
    fundCompany: name(
      /基金管理人[：:\s]*([\u4e00-\u9fa5A-Za-z0-9()（）·]{2,24}?)\s*(?:基金托管人|基金经理|成立日期|管理费率)/
    ),
    // ETF 常由多位经理共同管理，页面原文为「基金经理人 成曦 、 刘树荣」。
    // 只取第一位会与其他数据源（同花顺常显示另一位）对不上，故抓全部并用「、」连接。
    // 优先锚定「基金经理人」（jbgk 页实际字段名），失败再退「基金经理:」；
    // 两者都锚定右边界，避免匹配到导航栏的「基金经理」链接。
    fundManager: parseManagers(text),
    establishDate: name(/成立日期[：:\s]*(\d{4}-\d{2}-\d{2})/),
  };
}

/** 跟踪指数类型分类（好资产维度用）：宽基 / 行业主题 / 策略 */
export function classifyIndex(name: string | null): IndexType {
  if (!name) return null;
  const STRATEGY = [
    "红利", "高股息", "股息", "低波", "低波动", "价值", "成长",
    "质量", "动量", "基本面", "等权", "Smart", "ESG",
  ];
  const BROAD = [
    "沪深300", "中证500", "中证1000", "上证50", "上证180", "上证综指",
    "创业板指", "创业板50", "深证100", "深证成指", "科创50", "科创100",
    "中证A50", "中证A500", "国证2000", "MSCI", "标普", "纳斯达克", "恒生",
  ];
  for (const k of STRATEGY) if (name.includes(k)) return "strategy";
  for (const k of BROAD) if (name.includes(k)) return "broad";
  return "sector"; // 其余视为行业/主题
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
  /** 基金运营信息（好运营维度） */
  fundCompany: string | null;
  fundManager: string | null;
  establishDate: string | null;
  establishYears: number | null;
  /** 跟踪指数类型（好资产维度）：宽基 / 行业主题 / 策略 */
  indexType: IndexType;
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
    /** 跟踪指数当前 PE/PB（估值表展示用；ETF 自身无 PE 时即指数值） */
    indexPe: number | null;
    indexPb: number | null;
    trackIndexName: string | null;
    fundCompany: string | null;
    fundManager: string | null;
    establishDate: string | null;
    indexType: IndexType;
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
  // 成交额优先 f48（元，ETF 有效）；f185 对 ETF 恒为 "-"，仅作兼容兜底。
  // 交叉验证发现的真实缺陷：原先只读 f185 → dailyTurnoverWan 恒为 null，
  // 导致「流动性 ≥1 亿成交额」这条硬门槛长期静默失效。
  const dailyTurnoverWan = toWan(market?.f48) ?? toWan(market?.f185);
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

  // 运营信息（好运营维度）
  const fundCompany = parsed?.fundCompany ?? null;
  const fundManager = parsed?.fundManager ?? null;
  const establishDate = parsed?.establishDate ?? null;
  let establishYears: number | null = null;
  if (establishDate) {
    const y = parseInt(establishDate.slice(0, 4), 10);
    if (Number.isFinite(y)) establishYears = new Date().getFullYear() - y;
  }
  // 估值：优先指数 PE/PB
  const trackIndexName = parsed?.trackIndexName ?? null;
  const indexType = classifyIndex(trackIndexName);
  const indexSecid = resolveIndexSecid(trackIndexName);
  let peUsed: number | null = etfPe;
  let pbUsed: number | null = etfPb;

  // 分位：优先用「指数每日 PE/PB 历史」算真实百分位；拿不到历史才退代理
  let pePct: number | null = null;
  let pbPct: number | null = null;
  let peFromHistory = false;

  // 取真实市场当前 PE/PB（push2）仅用于「展示当前值」，不用于分位计算。
  if (indexSecid) {
    const idx = await fetchIndexPePb(indexSecid).catch(() => null);
    if (idx?.pe != null) peUsed = idx.pe;
    if (idx?.pb != null) pbUsed = idx.pb;

    const plain = indexSecid.split(".")[1];
    const hist = await fetchIndexValuationHistory(plain).catch(() => null);
    // ⚠️ 关键：历史估值表 PE_TTM 的绝对量纲与 push2 真实市场 PE 严重不一致
    // （实测 0.25x~7.86x，且因指数而异）。分位必须用「历史表自己的最新值」做当前值，
    // 与历史序列同尺度，才能算对；若用 push2 真实 PE 去比历史表序列，分位会崩。
    if (hist && hist.pe.length > 0) {
      const curPe = hist.latestPe ?? hist.pe[hist.pe.length - 1];
      pePct = computePercentile(curPe, hist.pe);
      peFromHistory = true;
    }
    if (hist && hist.pb.length > 0) {
      const curPb = hist.latestPb ?? hist.pb[hist.pb.length - 1];
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
    fundCompany,
    fundManager,
    establishDate,
    establishYears,
    indexType,
    raw: {
      scaleYi,
      dailyTurnoverWan,
      pe: etfPe,
      pb: etfPb,
      dividendYieldPct,
      feeRatePct,
      trackingErrorPct,
      premiumDiscountPct,
      indexPe: peUsed,
      indexPb: pbUsed,
      trackIndexName,
      fundCompany,
      fundManager,
      establishDate,
      indexType,
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

// ============================================================
// 净值历史（东财 pingzhongdata/{code}.js）：走势图 / 回撤图 / 关键指标
// ============================================================

/** 时间戳(ms) → 北京时间 YYYY-MM-DD（避免 UTC 偏移导致日期错位） */
function fmtCnDate(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface EtfNavPoint {
  date: string;
  nav: number;
}

export interface EtfNavHistory {
  /** 日频净值序列（升序） */
  series: EtfNavPoint[];
  /** 月度降采样（每月末交易日，升序），用于走势/回撤图 */
  monthly: EtfNavPoint[];
  /** 最新单位净值 */
  navNow: number | null;
  /** 成立日（首条日期） */
  establishDate: string | null;
  /** 今年以来收益 % */
  ytdPct: number | null;
  /** 近1年收益 % */
  y1Pct: number | null;
  /** 近3年收益 % */
  y3Pct: number | null;
  /** 近5年收益 % */
  y5Pct: number | null;
  /** 近3月收益 % */
  m3Pct: number | null;
  /** 历史最大回撤 %（负数，如 -65.6） */
  maxDrawdownPct: number | null;
  /** 近1年年化波动率 % */
  annualVolPct: number | null;
  /** 成立以来累计收益 % */
  sinceInceptionPct: number | null;
  /** 成立以来年化收益 % */
  annualizedSinceInceptionPct: number | null;
}

/**
 * 抓 ETF 单位净值历史（东财 pingzhongdata/{code}.js），解析 Data_netWorthTrend，
 * 计算走势/回撤/关键指标。best-effort，任何失败返回 null。
 * 兼容两种格式：对象数组 [{x,y}] 与旧数组 [[ts,nav,acc,ret]]。
 */
export async function fetchEtfNavHistory(
  code: string
): Promise<EtfNavHistory | null> {
  try {
    const res = await fetch(
      `https://fund.eastmoney.com/pingzhongdata/${code}.js`,
      {
        headers: { "User-Agent": UA, Referer: "https://fundf10.eastmoney.com/" },
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const txt = await res.text();
    const m = txt.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return null;
    let raw: unknown[];
    try {
      raw = JSON.parse(m[1]);
    } catch {
      return null;
    }
    const series: { t: number; date: string; nav: number }[] = [];
    for (const p of raw) {
      if (!p || typeof p !== "object") continue;
      const obj = p as Record<string, unknown>;
      const arr = Array.isArray(p);
      const t = (arr ? (obj[0] as number) : (obj.x as number)) ?? null;
      const nav = (arr ? (obj[1] as number) : (obj.y as number)) ?? null;
      if (typeof t === "number" && typeof nav === "number" && nav > 0) {
        series.push({ t, date: fmtCnDate(t), nav });
      }
    }
    if (series.length < 2) return null;

    const navNow = series[series.length - 1].nav;
    const establishDate = series[0].date;
    const lastT = series[series.length - 1].t;

    /** 升序序列中第一条 t >= target 的净值（用于"近N年"收益） */
    const navAt = (daysAgo: number): number | null => {
      const target = lastT - daysAgo * 86400000;
      let lo = 0,
        hi = series.length - 1,
        ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (series[mid].t >= target) {
          ans = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      return ans < 0 ? null : series[ans].nav;
    };
    const pct = (a: number | null) =>
      a != null && a > 0 ? (navNow / a - 1) * 100 : null;

    const y1Pct = pct(navAt(365));
    const y3Pct = pct(navAt(365 * 3));
    const y5Pct = pct(navAt(365 * 5));
    const m3Pct = pct(navAt(90));

    // 今年以来：当年首个交易日
    const curY = new Date(lastT + 8 * 3600 * 1000).getUTCFullYear();
    const ytdTarget = Date.UTC(curY, 0, 1);
    let ytdNav: number | null = null;
    for (const p of series) {
      if (p.t >= ytdTarget) {
        ytdNav = p.nav;
        break;
      }
    }
    const ytdPct =
      ytdNav != null && ytdNav > 0 ? (navNow / ytdNav - 1) * 100 : null;

    // 历史最大回撤（峰谷最大跌幅）
    let runMax = -Infinity,
      maxDD = 0;
    for (const p of series) {
      if (p.nav > runMax) runMax = p.nav;
      const dd = p.nav / runMax - 1;
      if (dd < maxDD) maxDD = dd;
    }
    const maxDrawdownPct = maxDD * 100;

    // 近1年年化波动（日收益率标准差 × √252）
    const oneYrAgoIdx = (() => {
      const target = lastT - 365 * 86400000;
      let lo = 0,
        hi = series.length - 1,
        ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (series[mid].t >= target) {
          ans = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      return ans;
    })();
    let annualVolPct: number | null = null;
    const win = series.slice(oneYrAgoIdx);
    if (win.length >= 20) {
      const rets: number[] = [];
      for (let i = 1; i < win.length; i++) {
        const r = win[i].nav / win[i - 1].nav - 1;
        if (Number.isFinite(r)) rets.push(r);
      }
      if (rets.length >= 20) {
        const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
        const variance =
          rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length;
        annualVolPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
      }
    }

    const firstNav = series[0].nav;
    const sinceInceptionPct =
      firstNav > 0 ? (navNow / firstNav - 1) * 100 : null;
    const days = (lastT - series[0].t) / 86400000;
    const annualizedSinceInceptionPct =
      firstNav > 0 && days > 30
        ? ((navNow / firstNav) ** (365 / days) - 1) * 100
        : null;

    // 月度降采样（每月最后一个交易日）
    const monMap = new Map<string, { t: number; nav: number }>();
    for (const p of series) {
      const k = p.date.slice(0, 7);
      monMap.set(k, { t: p.t, nav: p.nav });
    }
    const monthly = [...monMap.entries()]
      .sort((a, b) => a[1].t - b[1].t)
      .map(([k, v]) => ({ date: `${k}-01`, nav: v.nav }));

    return {
      series: series.map((p) => ({ date: p.date, nav: p.nav })),
      monthly,
      navNow,
      establishDate,
      ytdPct,
      y1Pct,
      y3Pct,
      y5Pct,
      m3Pct,
      maxDrawdownPct,
      annualVolPct,
      sinceInceptionPct,
      annualizedSinceInceptionPct,
    };
  } catch {
    return null;
  }
}

// ============================================================
// 同类 ETF 规模对比（同跟踪指数）
// ============================================================

export interface EtfPeer {
  code: string;
  name: string;
  scaleYi: number | null;
}

/** 从跟踪指数名提取区分度高的 token（去通用前缀/后缀），用于同类匹配 */
function indexToken(name: string): string {
  let s = name.trim();
  for (const p of ["中证", "国证", "上证", "深证"]) {
    if (s.startsWith(p)) s = s.slice(p.length);
  }
  for (const suf of ["指数", "主题", "ETF", "etf", "联接", "LOF", "基金"]) {
    if (s.endsWith(suf)) s = s.slice(0, s.length - suf.length);
  }
  return s.trim();
}

/**
 * 抓同跟踪指数的其他 ETF（东财 push2 板块列表），按规模降序返回最多 8 只。
 * f101/f102 为跟踪标的字段，含 token 即视为同类。best-effort，失败返回 null。
 * 注：push2 在部分网络环境会被限流，生产(Vercel)环境正常；失败时报告降级处理。
 */
export async function fetchPeerEtfs(
  trackIndexName: string | null,
  selfCode?: string
): Promise<EtfPeer[] | null> {
  if (!trackIndexName) return null;
  const token = indexToken(trackIndexName);
  if (token.length < 2) return null;
  try {
    const fs = "b:MK0021,b:MK0022,b:MK0023,b:MK0024";
    const fields = "f12,f14,f20,f101,f102";
    const url =
      "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fs=" +
      encodeURIComponent(fs) +
      "&fields=" +
      fields;
    const json = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
      url,
      "https://quote.eastmoney.com/",
      15000
    );
    const rows = json?.data;
    if (!rows || rows.length === 0) return null;
    const peers: EtfPeer[] = [];
    for (const r of rows) {
      const code = r.f12 != null ? String(r.f12) : "";
      const name = r.f14 != null ? String(r.f14) : "";
      const track = [r.f101, r.f102]
        .filter((v) => v != null && v !== "-")
        .map(String)
        .join(" ");
      if (!code || code === selfCode) continue;
      if (!track.includes(token)) continue;
      const scaleYi = num(r.f20) != null ? (num(r.f20) as number) / 1e8 : null;
      peers.push({ code, name, scaleYi });
    }
    peers.sort((a, b) => (b.scaleYi ?? -1) - (a.scaleYi ?? -1));
    return peers.slice(0, 8);
  } catch {
    return null;
  }
}
