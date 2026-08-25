/**
 * A 股「公司质地打分」数据层 + 七维评分 rubric
 *
 * 数据源（均为同花顺）：
 *  - fuyao.aicubes.cn 官方金融数据 API（THS_API_KEY，请求头 X-api-key）：
 *      财务三表    /api/a-share/financials/{income-statements,balance-sheets,cash-flow-statements}
 *      五类指标    /api/a-share/financials/indicators
 *      行情快照    /api/a-share/prices/snapshot
 *      历史 K 线    /api/a-share/prices/historical（用于 PB 历史分位）
 *      分红事件    /api/a-share/corporate-actions/adjustment-factors
 *  - 免费 10jqka F10 实时指标（无需鉴权，需 UA+Referer）：index_source 给 PE(静)/PB/股息率/EPS。
 *
 * 说明：fuyao API 当前集合未含「公司主营构成 / 行业排名市占率 / 股东明细」端点，
 * 因此 商业模式、行业地位 两个维度按财务特征代理评估并明确标注「数据有限」，
 * 符合技能的降级策略。估值（PE/PB/股息率）由免费 index_source 补齐。
 */

const THS_BASE = "https://fuyao.aicubes.cn";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* ----------------------------- 工具函数 ----------------------------- */

function thsHeaders(): Record<string, string> {
  return { "X-api-key": process.env.THS_API_KEY ?? "", "Content-Type": "application/json" };
}

/** fuyao 统一信封：code=0 成功，其余（含 3002 无数据）视为无数据 */
async function thsGet<T>(path: string, qs: Record<string, string> = {}): Promise<T | null> {
  const url = `${THS_BASE}${path}?${new URLSearchParams(qs).toString()}`;
  try {
    const res = await fetch(url, {
      headers: thsHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    if (j?.code !== 0 || !j.data) return null;
    return j as T;
  } catch {
    return null;
  }
}

async function fetchThsIndexSource(code6: string): Promise<any | null> {
  const market = /^([69])/.test(code6) ? "17" : "33";
  const url = `https://basic.10jqka.com.cn/fuyao/financial_reports_visual/finance/v1/index_source?code=${code6}&market=${market}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://basic.10jqka.com.cn/" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 把各种来源的数值统一解析为 number | null；"亏损"/"--"/空/NaN → null */
function num(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === "" || s === "亏损" || s === "--" || s === "NaN" || s.toLowerCase() === "null")
    return null;
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 兼容 index_id 的 calculate_ 前缀变体 */
function getInd(m: Record<string, number | null>, id: string): number | null {
  return m[id] ?? m[`calculate_${id}`] ?? null;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 将用户输入规范为 fuyao 要求的 thscode（如 002739 → 002739.SZ，600519 → 600519.SH） */
export function normalizeThsCode(input: string): string | null {
  const s = input.trim().toUpperCase();
  const m = s.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/);
  if (!m) return null;
  const code = m[1];
  let suffix = m[2];
  if (!suffix) {
    if (/^[69]/.test(code)) suffix = "SH";
    else if (/^[48]/.test(code)) suffix = "BJ";
    else suffix = "SZ";
  }
  return `${code}.${suffix}`;
}

/* ----------------------------- 类型定义 ----------------------------- */

export interface QualityDimension {
  key: string;
  title: string;
  score: number; // 0-100
  level: string; // 优质/良好/中性/偏弱
  bullets: string[];
  dataLimited?: boolean;
}

export interface CompanyQualityValuation {
  price: number | null;
  changePct: number | null;
  peStatic: number | null;
  pb: number | null;
  dividendYield: number | null;
  marketCap: number | null; // 元
  pbPercentile: number | null; // 0-100，当前 PB 在历史中的分位
  verdict: string;
}

export interface CompanyQuality {
  ticker: string;
  name: string;
  totalScore: number;
  level: string;
  oneLiner: string;
  dimensions: QualityDimension[]; // 5 个打分维度
  deductions: string[];
  valuation: CompanyQualityValuation;
  warnings: string[];
  dataSource: string;
  fetchedAt: string;
}

interface RawQualityData {
  name: string | null;
  price: number | null;
  changePct: number | null;
  // 五类指标（最新年报）
  roe: number | null;
  roeDeduct: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  roa: number | null;
  debtRatio: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  cashRatio: number | null;
  interestMultiple: number | null;
  revenueYoY: number | null;
  netProfitYoY: number | null;
  operatingProfitYoY: number | null;
  assetsGrowth: number | null;
  totalAssetsTurnover: number | null;
  inventoryTurnover: number | null;
  receivablesTurnover: number | null;
  cashContent: number | null;
  salesCashRatio: number | null;
  cashOperatingIndex: number | null;
  // 利润表（年報，最新 + 前一年）
  revenue: number | null;
  netProfit: number | null;
  parentNetProfit: number | null;
  eps: number | null;
  revenuePrev: number | null;
  parentNetProfitPrev: number | null;
  // 资产负债表
  assetsTotal: number | null;
  totalDebt: number | null;
  equity: number | null;
  cash: number | null;
  // 现金流量表
  opCashFlow: number | null;
  // 估值（免费 index_source）
  peStatic: number | null;
  pb: number | null;
  dividendYield: number | null;
  // 分红
  dividends: { exDate: string; dps: number }[];
  // 衍生
  shares: number | null;
  marketCap: number | null;
  pbPercentile: number | null;
  warnings: string[];
}

/* ----------------------------- 数据抓取 ----------------------------- */

interface SnapItem {
  thscode: string;
  last_price: number;
  price_change_ratio_pct: number;
  ticker: string;
}
interface FinItem {
  fiscal_year: number;
  fiscal_period: string;
  operating_income?: number;
  operating_profit?: number;
  net_profit?: number;
  parent_holder_net_profit?: number;
  basic_eps?: number;
  assets_total?: number;
  total_debt?: number;
  holder_equity_total?: number;
  cash?: number;
  act_cash_flow_net?: number;
}
interface IndEnvelope {
  data: { abilities: { ability: string; indicators: { index_id: string; value: any }[] }[] };
}

function parseIndicators(json: IndEnvelope): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const abs = json?.data?.abilities ?? [];
  for (const ab of abs) {
    for (const ind of ab.indicators ?? []) {
      out[ind.index_id] = num(ind.value);
    }
  }
  return out;
}

async function computePbPercentile(
  thscode: string,
  equity: number | null,
  shares: number | null
): Promise<number | null> {
  if (!equity || !shares || shares <= 0) return null;
  const bvps = equity / shares;
  if (bvps <= 0) return null;
  const end = Date.now();
  const start = end - 3 * 365 * 24 * 3600 * 1000;
  const k = await thsGet<{ data: { item: { close_price: number }[] } }>(
    `/api/a-share/prices/historical`,
    {
      thscode,
      interval: "1d",
      start: String(start),
      end: String(end),
    }
  );
  const bars = k?.data?.item ?? [];
  if (bars.length < 20) return null;
  const pbs = bars
    .map((b) => b.close_price / bvps)
    .filter((p) => Number.isFinite(p) && p > 0);
  if (pbs.length < 20) return null;
  const cur = bars[bars.length - 1].close_price / bvps;
  const below = pbs.filter((p) => p <= cur).length;
  return Math.round((below / pbs.length) * 100);
}

async function fetchRaw(thscode: string): Promise<RawQualityData> {
  const code6 = thscode.split(".")[0];
  const warnings: string[] = [];
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const [snap, income, balance, cash, idxSrc, corp] = await Promise.allSettled([
    thsGet<{ data: { item: SnapItem[] } }>(`/api/a-share/prices/snapshot`, {
      thscodes: thscode,
    }),
    thsGet<{ data: { item: FinItem[] } }>(`/api/a-share/financials/income-statements`, {
      thscode,
      period: "annual",
      limit: "2",
    }),
    thsGet<{ data: { item: FinItem[] } }>(`/api/a-share/financials/balance-sheets`, {
      thscode,
      period: "annual",
      limit: "2",
    }),
    thsGet<{ data: { item: FinItem[] } }>(`/api/a-share/financials/cash-flow-statements`, {
      thscode,
      period: "annual",
      limit: "2",
    }),
    fetchThsIndexSource(code6),
    thsGet<{ data: { item: { ex_date_ms: number; dividend_per_share: number }[] } }>(
      `/api/a-share/corporate-actions/adjustment-factors`,
      { thscode, from: ymd(threeYearsAgo), to: ymd(new Date()) }
    ),
  ]);

  // 行情快照
  const snapItem = snap.status === "fulfilled" ? snap.value?.data?.item?.[0] : null;
  const price = snapItem?.last_price ?? null;
  const changePct = snapItem?.price_change_ratio_pct ?? null;

  // 三表
  const incItems =
    income.status === "fulfilled" ? income.value?.data?.item ?? [] : [];
  const balItems =
    balance.status === "fulfilled" ? balance.value?.data?.item ?? [] : [];
  const cashItems =
    cash.status === "fulfilled" ? cash.value?.data?.item ?? [] : [];

  const incLatest = incItems[0] ?? null;
  const incPrev = incItems[1] ?? null;
  const balLatest = balItems[0] ?? null;
  const cashLatest = cashItems[0] ?? null;

  // 最新年报指标
  let ind: Record<string, number | null> = {};
  if (incLatest?.fiscal_year) {
    const r = await thsGet<IndEnvelope>(`/api/a-share/financials/indicators`, {
      thscode,
      report: `${incLatest.fiscal_year}-4`,
    });
    if (r?.data) ind = parseIndicators(r);
  } else {
    warnings.push("未取到最新年报，五类指标缺失，相关维度降权");
  }

  const roe = getInd(ind, "index_weighted_avg_roe");
  const roeDeduct = getInd(ind, "index_deduct_weighted_avg_roe");
  const grossMargin = getInd(ind, "sale_gross_margin");
  const netMargin = getInd(ind, "sale_net_interest_ratio");
  const roa = getInd(ind, "total_assets_net_ratio");
  const debtRatio = getInd(ind, "assets_debt_ratio");
  const currentRatio = getInd(ind, "current_ratio");
  const quickRatio = getInd(ind, "quick_ratio");
  const cashRatio = getInd(ind, "cash_ratio");
  const interestMultiple = getInd(ind, "earned_interest_multiple");
  const revenueYoY = getInd(ind, "operating_income_yoy_growth_ratio");
  const netProfitYoY = getInd(ind, "parent_holder_net_profit_yoy_growth_ratio");
  const operatingProfitYoY = getInd(ind, "operating_profit_yoy_growth_ratio");
  const assetsGrowth = getInd(ind, "total_assets_growth_ratio");
  const totalAssetsTurnover = getInd(ind, "total_assets_turnover_ratio");
  const inventoryTurnover = getInd(ind, "inventory_turnover_ratio");
  const receivablesTurnover = getInd(ind, "receive_account_turnover_ratio");
  const cashContent = getInd(ind, "net_profit_cash_content");
  const salesCashRatio = getInd(ind, "operating_cash_flow_net_divide_income");
  const cashOperatingIndex = getInd(ind, "cash_operating_index");

  // 免费 index_source 估值：latest_index 为「指标组」，真实数值在 related_index[] 嵌套数组
  let peStatic: number | null = null;
  let pb: number | null = null;
  let dividendYield: number | null = null;
  const latestIdx = idxSrc.status === "fulfilled" ? (idxSrc.value as any)?.data?.latest_index : null;
  if (Array.isArray(latestIdx)) {
    const flat: { index_id?: string; value?: any }[] = [];
    for (const grp of latestIdx) {
      if (grp?.index_id && grp?.value != null) flat.push(grp); // 组自身可能带指标
      if (Array.isArray(grp?.related_index)) flat.push(...grp.related_index); // 组内明细
    }
    for (const it of flat) {
      if (it?.index_id === "pe_static_newest") peStatic = num(it.value);
      else if (it?.index_id === "pb_newest") pb = num(it.value);
      else if (it?.index_id === "dividend_yield_ratio_newest") dividendYield = num(it.value);
    }
  } else {
    warnings.push("免费估值源(index_source)未取到 PE/PB/股息率");
  }

  // 分红
  const dividends: { exDate: string; dps: number }[] = [];
  if (corp.status === "fulfilled" && corp.value?.data?.item) {
    for (const e of corp.value.data.item) {
      if (e && e.dividend_per_share > 0) {
        dividends.push({
          exDate: ymd(new Date(e.ex_date_ms)),
          dps: e.dividend_per_share,
        });
      }
    }
  }

  // 股本 / 市值 / PB 分位
  const shares =
    incLatest?.parent_holder_net_profit && incLatest?.basic_eps
      ? incLatest.parent_holder_net_profit / incLatest.basic_eps
      : null;
  const marketCap = price != null && shares ? price * shares : null;
  const equity = balLatest?.holder_equity_total ?? null;
  const pbPercentile = await computePbPercentile(thscode, equity, shares);

  return {
    name: null, // 名称由 meta 接口补，下方单独取
    price,
    changePct,
    roe,
    roeDeduct,
    grossMargin,
    netMargin,
    roa,
    debtRatio,
    currentRatio,
    quickRatio,
    cashRatio,
    interestMultiple,
    revenueYoY,
    netProfitYoY,
    operatingProfitYoY,
    assetsGrowth,
    totalAssetsTurnover,
    inventoryTurnover,
    receivablesTurnover,
    cashContent,
    salesCashRatio,
    cashOperatingIndex,
    revenue: incLatest?.operating_income ?? null,
    netProfit: incLatest?.net_profit ?? null,
    parentNetProfit: incLatest?.parent_holder_net_profit ?? null,
    eps: incLatest?.basic_eps ?? null,
    revenuePrev: incPrev?.operating_income ?? null,
    parentNetProfitPrev: incPrev?.parent_holder_net_profit ?? null,
    assetsTotal: balLatest?.assets_total ?? null,
    totalDebt: balLatest?.total_debt ?? null,
    equity,
    cash: balLatest?.cash ?? null,
    opCashFlow: cashLatest?.act_cash_flow_net ?? null,
    peStatic,
    pb,
    dividendYield,
    dividends,
    shares,
    marketCap,
    pbPercentile,
    warnings,
  };
}

/** 补全中文名（meta 检索，失败不影响其余） */
async function resolveName(thscode: string): Promise<string | null> {
  const r = await thsGet<{ data: { item: { thscode: string; name: string }[] } }>(
    `/api/meta/tickers/search`,
    { q: thscode, limit: "5" }
  );
  const item = r?.data?.item?.find((x) => x.thscode === thscode);
  return item?.name ?? null;
}

/* ----------------------------- 评分 rubric ----------------------------- */

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function levelOf(score: number): string {
  if (score >= 85) return "优质";
  if (score >= 70) return "良好";
  if (score >= 55) return "中性";
  return "偏弱";
}

function pct(n: number | null, digits = 1): string {
  return n == null ? "—" : `${(n * 100).toFixed(digits)}%`;
}
function wan(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)} 万`;
  return n.toFixed(2);
}
function yi(n: number | null): string {
  if (n == null) return "—";
  return `${(n / 1e8).toFixed(2)} 亿元`;
}

function scoreFinancial(d: RawQualityData): QualityDimension {
  const { roe, netMargin, grossMargin, debtRatio, cashContent, currentRatio } = d;
  let s = 0;
  const bullets: string[] = [];
  // ROE 28
  if (roe == null) {
    bullets.push("ROE 数据缺失");
  } else if (roe >= 15) { s += 28; bullets.push(`ROE ${roe.toFixed(1)}%（优秀）`); }
  else if (roe >= 10) { s += 22; bullets.push(`ROE ${roe.toFixed(1)}%（良好）`); }
  else if (roe >= 7) { s += 16; bullets.push(`ROE ${roe.toFixed(1)}%（一般）`); }
  else if (roe >= 3) { s += 10; bullets.push(`ROE ${roe.toFixed(1)}%（偏弱）`); }
  else if (roe < 0) { s += 2; bullets.push(`ROE ${roe.toFixed(1)}%（为负）`); }
  else { s += 6; bullets.push(`ROE ${roe.toFixed(1)}%（很低）`); }
  // 负债 20
  if (debtRatio == null) { s += 10; bullets.push("资产负债率缺失"); }
  else if (debtRatio <= 40) { s += 20; bullets.push(`资产负债率 ${debtRatio.toFixed(1)}%（低杠杆）`); }
  else if (debtRatio <= 55) { s += 16; bullets.push(`资产负债率 ${debtRatio.toFixed(1)}%（适中）`); }
  else if (debtRatio <= 65) { s += 12; bullets.push(`资产负债率 ${debtRatio.toFixed(1)}%（偏高）`); }
  else if (debtRatio <= 75) { s += 8; bullets.push(`资产负债率 ${debtRatio.toFixed(1)}%（高杠杆）`); }
  else { s += 4; bullets.push(`资产负债率 ${debtRatio.toFixed(1)}%（过高）`); }
  // 利润含金量 17
  if (cashContent == null) { s += 8; bullets.push("净利润现金含量缺失"); }
  else if (cashContent >= 100) { s += 17; bullets.push(`净利润现金含量 ${cashContent.toFixed(0)}%（利润含金量高）`); }
  else if (cashContent >= 50) { s += 13; bullets.push(`净利润现金含量 ${cashContent.toFixed(0)}%（较好）`); }
  else if (cashContent >= 0) { s += 8; bullets.push(`净利润现金含量 ${cashContent.toFixed(0)}%（偏低）`); }
  else { s += 3; bullets.push(`净利润现金含量 ${cashContent.toFixed(0)}%（利润含金量差）`); }
  // 净利率 17
  if (netMargin == null) { s += 8; }
  else if (netMargin >= 20) { s += 17; bullets.push(`净利率 ${netMargin.toFixed(1)}%（高）`); }
  else if (netMargin >= 10) { s += 13; bullets.push(`净利率 ${netMargin.toFixed(1)}%（良好）`); }
  else if (netMargin >= 5) { s += 9; bullets.push(`净利率 ${netMargin.toFixed(1)}%（一般）`); }
  else if (netMargin >= 0) { s += 5; }
  else { s += 1; bullets.push(`净利率 ${netMargin.toFixed(1)}%（亏损）`); }
  // 毛利率 10
  if (grossMargin == null) { s += 5; }
  else if (grossMargin >= 50) { s += 10; bullets.push(`毛利率 ${grossMargin.toFixed(1)}%（强定价权）`); }
  else if (grossMargin >= 30) { s += 8; }
  else if (grossMargin >= 20) { s += 6; }
  else { s += 3; bullets.push(`毛利率 ${grossMargin.toFixed(1)}%（偏低）`); }
  // 流动比率 8
  if (currentRatio == null) { s += 4; }
  else if (currentRatio >= 1.5) { s += 8; }
  else if (currentRatio >= 1) { s += 5; bullets.push(`流动比率 ${currentRatio.toFixed(2)}（偏紧）`); }
  else { s += 2; bullets.push(`流动比率 ${currentRatio.toFixed(2)}（短期偿债压力大）`); }

  if (d.opCashFlow != null && d.parentNetProfit != null && d.parentNetProfit > 0) {
    bullets.push(`经营现金流 ${yi(d.opCashFlow)}，为净利润（${yi(d.parentNetProfit)}）的 ${(d.opCashFlow / d.parentNetProfit).toFixed(1)} 倍`);
  }
  return { key: "finance", title: "财务质量", score: clamp(s), level: levelOf(clamp(s)), bullets };
}

function scoreGrowth(d: RawQualityData): QualityDimension {
  const { revenueYoY, netProfitYoY } = d;
  let s = 0;
  const bullets: string[] = [];
  // 营收增长 40
  if (revenueYoY == null) { s += 20; bullets.push("营收增速缺失"); }
  else if (revenueYoY >= 20) { s += 40; bullets.push(`营收同比 +${revenueYoY.toFixed(1)}%`); }
  else if (revenueYoY >= 10) { s += 32; bullets.push(`营收同比 +${revenueYoY.toFixed(1)}%`); }
  else if (revenueYoY >= 0) { s += 20; bullets.push(`营收同比 +${revenueYoY.toFixed(1)}%`); }
  else if (revenueYoY >= -10) { s += 10; bullets.push(`营收同比 ${revenueYoY.toFixed(1)}%（下滑）`); }
  else { s += 4; bullets.push(`营收同比 ${revenueYoY.toFixed(1)}%（大幅下滑）`); }
  // 净利增长 45
  if (netProfitYoY == null) { s += 22; bullets.push("净利增速缺失"); }
  else if (netProfitYoY >= 50) { s += 45; bullets.push(`归母净利同比 +${netProfitYoY.toFixed(1)}%`); }
  else if (netProfitYoY >= 20) { s += 36; bullets.push(`归母净利同比 +${netProfitYoY.toFixed(1)}%`); }
  else if (netProfitYoY >= 0) { s += 22; bullets.push(`归母净利同比 +${netProfitYoY.toFixed(1)}%`); }
  else if (netProfitYoY >= -20) { s += 9; bullets.push(`归母净利同比 ${netProfitYoY.toFixed(1)}%`); }
  else { s += 3; bullets.push(`归母净利同比 ${netProfitYoY.toFixed(1)}%（大幅下滑）`); }
  // 质量 15
  const turnaround = (d.parentNetProfit ?? 0) > 0 && (d.parentNetProfitPrev ?? 1) < 0;
  if (revenueYoY != null && netProfitYoY != null && revenueYoY > 0 && netProfitYoY > 0) {
    s += netProfitYoY > revenueYoY ? 15 : 10;
    if (turnaround) bullets.push("由亏转盈，需观察盈利持续性（警惕基数/景气红利）");
  } else if ((revenueYoY ?? 0) > 0 || (netProfitYoY ?? 0) > 0) {
    s += 6;
  } else { s += 0; bullets.push("营收与净利均未增长"); }

  if (d.operatingProfitYoY != null) bullets.push(`营业利润同比 ${d.operatingProfitYoY >= 0 ? "+" : ""}${d.operatingProfitYoY.toFixed(1)}%`);
  if (d.assetsGrowth != null) bullets.push(`总资产增速 ${d.assetsGrowth >= 0 ? "+" : ""}${d.assetsGrowth.toFixed(1)}%`);
  return { key: "growth", title: "成长质量", score: clamp(s), level: levelOf(clamp(s)), bullets };
}

/** 数据有限维度：按财务特征代理评分并明确标注 */
function scoreBusinessModel(d: RawQualityData): QualityDimension {
  let s = 58;
  const bullets: string[] = [];
  bullets.push("详细主营构成/商业模式数据需同花顺 F10 主营构成接口（当前 API 集未直接提供），本维度按财务特征代理评估，仅供参考。");
  if (d.grossMargin != null) {
    if (d.grossMargin >= 40) { s += 12; bullets.push(`毛利率 ${d.grossMargin.toFixed(1)}%，具备一定产品定价权/壁垒`); }
    else if (d.grossMargin >= 25) { s += 4; bullets.push(`毛利率 ${d.grossMargin.toFixed(1)}%（中等）`); }
    else { s -= 6; bullets.push(`毛利率 ${d.grossMargin.toFixed(1)}% 偏低，生意偏同质化/重资产`); }
  }
  if (d.netMargin != null && d.netMargin > 0) s += 5;
  if (d.debtRatio != null && d.debtRatio > 70) s -= 8;
  if (d.revenue != null) bullets.push(`年营收规模 ${yi(d.revenue)}，业务体量${d.revenue > 1e10 ? "大" : d.revenue > 1e9 ? "中等" : "偏小"}`);
  return { key: "business", title: "商业模式与壁垒", score: clamp(s), level: levelOf(clamp(s)), bullets, dataLimited: true };
}

function scoreIndustry(d: RawQualityData): QualityDimension {
  let s = 56;
  const bullets: string[] = [];
  bullets.push("行业排名/市占率数据需同花顺行业接口（当前 API 集未含），本维度按市值规模与盈利稳定性代理评估。");
  const mc = d.marketCap;
  if (mc != null) {
    if (mc >= 2e11) { s += 14; bullets.push(`总市值约 ${yi(mc)}，属大盘/龙头梯队`); }
    else if (mc >= 5e10) { s += 8; bullets.push(`总市值约 ${yi(mc)}，属中大盘`); }
    else if (mc >= 1e10) { s += 3; bullets.push(`总市值约 ${yi(mc)}，中小盘`); }
    else { s -= 4; bullets.push(`总市值约 ${yi(mc)}，小盘`); }
  }
  if (d.roe != null && d.roe > 10) { s += 8; bullets.push("ROE 高于 10%，相对同业具备效率优势"); }
  if (d.netMargin != null && d.netMargin > 0) s += 4;
  if (d.parentNetProfit != null && d.parentNetProfit < 0) s -= 8;
  return { key: "industry", title: "行业地位与竞争优势", score: clamp(s), level: levelOf(clamp(s)), bullets, dataLimited: true };
}

function scoreGovernance(d: RawQualityData): QualityDimension {
  let s = 0;
  const bullets: string[] = [];
  // 分红历史 45
  const divCount = d.dividends.length;
  if (divCount >= 3) { s += 45; bullets.push(`近 3 年有 ${divCount} 次现金分红，股东回报稳定`); }
  else if (divCount === 2) { s += 34; bullets.push(`近 3 年 ${divCount} 次现金分红`); }
  else if (divCount === 1) { s += 22; bullets.push(`近 3 年 ${divCount} 次现金分红`); }
  else { s += 8; bullets.push("近 3 年无现金分红（可能因累积亏损未弥补或利润波动）"); }
  // 股息率 30
  if (d.dividendYield == null) { s += 12; }
  else if (d.dividendYield >= 3) { s += 30; bullets.push(`股息率 ${d.dividendYield.toFixed(2)}%（高）`); }
  else if (d.dividendYield >= 1.5) { s += 22; bullets.push(`股息率 ${d.dividendYield.toFixed(2)}%`); }
  else if (d.dividendYield >= 0.5) { s += 14; }
  else { s += 6; bullets.push(`股息率 ${d.dividendYield.toFixed(2)}%（低）`); }
  // 利润含金量/资本配置 25
  if (d.cashContent != null && d.cashContent >= 80) { s += 12; bullets.push("经营现金流对利润覆盖好，资本配置偏稳健"); }
  else if (d.cashContent != null && d.cashContent < 0) { s += 2; }
  else s += 8;
  if (d.debtRatio != null && d.debtRatio > 70) { s -= 6; bullets.push("高杠杆下资本开支需关注财务弹性"); }
  bullets.push("注：股东明细/实控人/回购等治理数据需同花顺 F10 股东接口（当前 API 集未含），本维度以分红与现金流代理评估。");
  return { key: "governance", title: "治理与资本配置", score: clamp(s), level: levelOf(clamp(s)), bullets, dataLimited: true };
}

function buildDeductions(d: RawQualityData): string[] {
  const out: string[] = [];
  if (d.debtRatio != null && d.debtRatio > 70)
    out.push(`高杠杆：资产负债率 ${d.debtRatio.toFixed(1)}%，财务弹性受限`);
  if (d.parentNetProfit != null && d.parentNetProfit < 0)
    out.push(`最新年报归母净利润为负（${yi(d.parentNetProfit)}）`);
  if (d.parentNetProfitPrev != null && d.parentNetProfitPrev < 0 && (d.parentNetProfit ?? 0) > 0)
    out.push("由亏转盈，需区分景气修复与真实竞争力提升");
  if (d.cashContent != null && d.cashContent < 0)
    out.push(`利润含金量差：净利润现金含量 ${d.cashContent.toFixed(0)}%`);
  if (d.receivablesTurnover != null && d.receivablesTurnover < 3 && (d.revenue ?? 0) > 0)
    out.push("应收账款周转慢，关注回款与坏账风险");
  if (d.dividends.length === 0)
    out.push("近 3 年无现金分红，股东当期回报不足");
  if (d.roe != null && d.roe < 7)
    out.push(`ROE 偏低（${d.roe.toFixed(1)}%），资本回报不突出`);
  if (out.length === 0) out.push("未识别出显著扣分项（数据口径内）");
  return out;
}

function buildValuationVerdict(d: RawQualityData): CompanyQualityValuation {
  const pctStr = d.pbPercentile == null ? "—" : `${d.pbPercentile}%`;
  let verdict: string;
  if (d.pbPercentile == null) {
    verdict = "估值分位暂不可得，建议结合 PE/PB 绝对值自行判断。";
  } else if (d.pbPercentile <= 30) {
    verdict = `PB 处历史低位（分位 ${d.pbPercentile}%），若质地稳健则「好公司+好价格」概率提升，可重点跟踪。`;
  } else if (d.pbPercentile <= 60) {
    verdict = `PB 处历史中枢（分位 ${d.pbPercentile}%），估值中性，等待更好价格或业绩催化。`;
  } else {
    verdict = `PB 处历史偏高（分位 ${d.pbPercentile}%），即使质地好也需警惕「好公司、偏贵价格」。`;
  }
  if (d.peStatic != null && d.peStatic > 40) verdict += ` 静态 PE ${d.peStatic.toFixed(1)} 倍偏高`;
  else if (d.peStatic != null) verdict += ` 静态 PE ${d.peStatic.toFixed(1)} 倍`;
  return {
    price: d.price,
    changePct: d.changePct,
    peStatic: d.peStatic,
    pb: d.pb,
    dividendYield: d.dividendYield,
    marketCap: d.marketCap,
    pbPercentile: d.pbPercentile,
    verdict,
  };
}

/* ----------------------------- 编排入口 ----------------------------- */

export async function fetchCompanyQuality(input: string): Promise<CompanyQuality | null> {
  const thscode = normalizeThsCode(input);
  if (!thscode) return null;

  const raw = await fetchRaw(thscode);
  const name = (await resolveName(thscode)) ?? thscode;

  const dims: QualityDimension[] = [
    scoreBusinessModel(raw),
    scoreIndustry(raw),
    scoreGrowth(raw),
    scoreFinancial(raw),
    scoreGovernance(raw),
  ];

  const total = clamp(
    dims.reduce((s, d) => s + d.score, 0) / dims.length
  );
  const deductions = buildDeductions(raw);
  const valuation = buildValuationVerdict(raw);

  // 一句话结论：好公司 vs 好股票
  const weakDims = dims.filter((d) => d.score < 55).map((d) => d.title);
  let oneLiner: string;
  if (total >= 75 && weakDims.length === 0) {
    oneLiner = "质地优质、各维度均衡，属「好公司」；结合估值分位判断是否为「好价格」。";
  } else if (total >= 60) {
    oneLiner = `质地中性偏上${weakDims.length ? "，短板在" + weakDims.join("/") : ""}；好公司与否需结合估值与行业周期综合判断。`;
  } else {
    oneLiner = `质地偏弱（${weakDims.join("/")}），当前更偏「需谨慎」标的，建议先改善项再考虑。`;
  }
  if (valuation.pbPercentile != null && valuation.pbPercentile <= 30)
    oneLiner += " 当前估值处历史低位，可重点跟踪买点。";

  return {
    ticker: thscode,
    name,
    totalScore: total,
    level: levelOf(total),
    oneLiner,
    dimensions: dims,
    deductions,
    valuation,
    warnings: raw.warnings,
    dataSource: "同花顺 fuyao API + 10jqka F10",
    fetchedAt: new Date().toISOString(),
  };
}
