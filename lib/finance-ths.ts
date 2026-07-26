/**
 * A 股财务数据获取（同花顺 10jqka 数据源）
 *
 * 本模块是「仅研报路径」的 A 股数据源适配层：以同花顺为主源，对同花顺原生未提供
 * 的字段（如 52 周高低、财报预约披露日、分析师评级分布/家数、同业可比 boardCode、
 * Forward PE、EBITDA、自由现金流等）回退东方财富兜底，最终返回统一的 FinancialMetrics。
 * 五因子策略（lib/finance.ts → fetchCNFinancialMetrics）不受影响，仍单独走东方财富。
 *
 * 数据来源（均为同花顺公开 F10 / 研报接口，无需鉴权，需带 UA + Referer）：
 *   1. index_source   —— 实时指标（PE/PB/EPS/营收同比/净利同比/毛利率/净利率/ROE/资产负债率/股息率）
 *   2. client_stock_importance —— 重要指标（营收/ROE/毛利率/净利率/流动比率/速动比率 历史 + 最新）
 *   3. client_stock_benefit    —— 利润表（营业利润/EBIT、归母净利润、EPS、营收）
 *   4. client_stock_debt       —— 资产负债表（负债合计/股东权益/货币资金）
 *   5. client_stock_cash       —— 现金流量表（经营活动现金流净额）
 *   6. report/statics graph_table —— 分析师目标价序列（含每日实际股价）
 *   7. report/content/list     —— 研报列表（名称/行业/新闻/机构）
 *
 * 单位约定：
 *   - index_source：金额=元（绝对值），比率=百分比原值（如 86.5986 表示 86.5986%，需 /100）
 *   - importance/benefit/debt/cash 财务报表：金额单位=亿（需 ×1e8），比率=百分比（/100）
 *
 * 兜底策略：以下字段同花顺原生未提供，将自动从东方财富 fetchCNFinancialMetrics 取值：
 *   52 周高低、财报预约披露日、分析师评级分布/家数、同业可比 boardCode、Forward PE、
 *   EBITDA、自由现金流、EV/EBITDA、目标价中位数、分析师详细评级、YTD 等。
 * 其余字段（市值由 PE×TTM净利润 推算、现价/涨跌幅取自目标价序列 stock_price）同花顺已有值，
 * 优先使用同花顺。
 */

import type { FinancialMetrics } from "./finance";
import { fetchCNFinancialMetrics } from "./finance-cn";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* 通用抓取                                                            */
/* ------------------------------------------------------------------ */

async function fetchThsJson(
  url: string,
  referer: string,
  timeoutMs = 10000
): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 表单类接口（importance/benefit/debt/cash）解析                       */
/* ------------------------------------------------------------------ */

interface FormPeriod {
  name: string;
  year: number;
  annual: boolean;
  vals: Record<string, number | null>;
}

/** 金额按单位换算：亿 → ×1e8；% → /100；其余原值 */
function toNum(raw: any, unit?: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (unit === "亿") return n * 1e8;
  if (unit === "%") return n / 100;
  return n;
}

function parseForm(json: any): FormPeriod[] {
  const cat: any[] = json?.data?.category ?? [];
  const fin: any[] = json?.data?.finance ?? [];
  return fin.map((f) => {
    const name: string = f.name ?? "";
    const year = parseInt(name.match(/\d{4}/)?.[0] ?? "0", 10);
    const annual = /年报/.test(name);
    const list: any[] = f.list ?? [];
    const vals: Record<string, number | null> = {};
    cat.forEach((c, i) => {
      vals[c.id] = toNum(list[i]?.value, list[i]?.unit);
    });
    return { name, year, annual, vals };
  });
}

/** 取最新一期（表单 finance 数组按时间倒序，[0] 即最新） */
function latestPeriod(periods: FormPeriod[]): FormPeriod | null {
  return periods[0] ?? null;
}

/** 取最新年报期（用于年度口径的营收/净利/EBIT/ROE 历史） */
function latestAnnual(periods: FormPeriod[]): FormPeriod | null {
  const an = periods.filter((p) => p.annual).sort((a, b) => b.year - a.year);
  return an[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* index_source 解析（实时指标，值已是元/百分比原值）                   */
/* ------------------------------------------------------------------ */

function parseIndex(json: any): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const it of json?.data?.latest_index ?? []) {
    const v = it?.value;
    out[it?.index_id] =
      v == null || v === "" ? null : parseFloat(String(v));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 目标价序列解析（含每日实际股价）                                     */
/* ------------------------------------------------------------------ */

interface TargetInfo {
  price: number | null;
  change: number | null;
  mean: number | null;
  high: number | null;
  low: number | null;
}

function parseTarget(json: any): TargetInfo {
  const list: any[] = (json?.data?.list ?? [])
    .slice()
    .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
  // 找到最新一条含实际股价的记录，以及其前一日（算涨跌幅）
  let last: any = null;
  let prev: any = null;
  for (const e of list) {
    if (e?.stock_price != null && !isNaN(Number(e.stock_price))) {
      prev = last;
      last = e;
    }
  }
  const num = (v: any) =>
    v != null && !isNaN(Number(v)) ? Number(v) : null;
  let change: number | null = null;
  if (last && prev && prev.stock_price) {
    change = (last.stock_price - prev.stock_price) / prev.stock_price;
  }
  return {
    price: last ? num(last.stock_price) : null,
    change,
    mean: last ? num(last.avg_price) : null,
    high: last ? num(last.max_price) : null,
    low: last ? num(last.min_price) : null,
  };
}

/* ------------------------------------------------------------------ */
/* 研报列表解析（名称/行业/新闻）                                       */
/* ------------------------------------------------------------------ */

function parseReports(json: any): {
  name: string | null;
  industry: string | null;
  news: FinancialMetrics["news"];
} {
  const list: any[] = json?.data?.list ?? [];
  const news = list
    .map((r) => {
      const title = (r?.title ?? "").trim();
      if (!title) return null;
      let date: string | undefined;
      if (r?.publish_time) {
        const d = new Date(
          String(r.publish_time).replace(" ", "T") + "+08:00"
        );
        if (!isNaN(d.getTime())) date = d.toISOString();
      }
      return {
        title,
        source: r?.org_name ?? "同花顺研报",
        date,
        url: undefined,
      };
    })
    .filter(Boolean) as FinancialMetrics["news"];
  return {
    name: list[0]?.stock_name ?? null,
    industry: list[0]?.industry ?? null,
    news,
  };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 从同花顺获取 A 股完整财务数据，返回统一 FinancialMetrics 结构。
 * 任一子接口失败仅置相关字段为 null，不整体中断。
 */
export async function fetchThsCore(
  ticker: string
): Promise<FinancialMetrics> {
  const m = ticker.match(/^(\d{6})(?:\.(SH|SZ|SS))?$/i);
  const code = m ? m[1] : ticker.replace(/\D/g, "").slice(0, 6);
  // 沪市(6/9 开头) market=17；深市(0/2/3 开头) market=33
  const market = /^([69])/.test(code) ? 17 : 33;

  const base = `https://basic.10jqka.com.cn/fuyao/f10_migrate/analysis/v1/form?code=${code}&method=report&period=0&page=1&limit=10`;
  const ref = "https://basic.10jqka.com.cn/";

  const [
    indexJson,
    impJson,
    benJson,
    debtJson,
    cashJson,
    targetJson,
    repJson,
  ] = await Promise.allSettled([
    fetchThsJson(
      `https://basic.10jqka.com.cn/fuyao/financial_reports_visual/finance/v1/index_source?code=${code}&market=${market}`,
      ref
    ),
    fetchThsJson(`${base}&id=client_stock_importance`, ref),
    fetchThsJson(`${base}&id=client_stock_benefit`, ref),
    fetchThsJson(`${base}&id=client_stock_debt`, ref),
    fetchThsJson(`${base}&id=client_stock_cash`, ref),
    fetchThsJson(
      `https://eq.10jqka.com.cn/content/report/research_report/v2/report/statics/stock/graph_table?type=1y&stock_code=${code}`,
      "https://eq.10jqka.com.cn/"
    ),
    fetchThsJson(
      `https://eq.10jqka.com.cn/content/report/research_report/v2/report/content/list/get?stock_code=${code}&report_type=single`,
      "https://eq.10jqka.com.cn/"
    ),
  ]);

  const idx =
    indexJson.status === "fulfilled" ? parseIndex(indexJson.value) : {};
  const imp =
    impJson.status === "fulfilled"
      ? parseForm(impJson.value)
      : [];
  const ben =
    benJson.status === "fulfilled" ? parseForm(benJson.value) : [];
  const debt =
    debtJson.status === "fulfilled" ? parseForm(debtJson.value) : [];
  const cash =
    cashJson.status === "fulfilled" ? parseForm(cashJson.value) : [];
  const target =
    targetJson.status === "fulfilled"
      ? parseTarget(targetJson.value)
      : { price: null, change: null, mean: null, high: null, low: null };
  const rep =
    repJson.status === "fulfilled"
      ? parseReports(repJson.value)
      : { name: null, industry: null, news: [] };

  // —— 实时指标（index_source，元/% 原值）——
  const peTtm = idx.pe_ttm_newest ?? null;
  const trailingEps = idx.eps_calculate_newest ?? null;
  const revenueGrowthYoY =
    idx.operating_income_total_yoy_newest != null
      ? idx.operating_income_total_yoy_newest / 100
      : null;
  const netProfitGrowthPct = idx.parent_holder_net_profit_yoy_newest ?? null; // 保留 % 原值供 PEG
  const grossMargin =
    idx.sale_gross_margin_newest != null
      ? idx.sale_gross_margin_newest / 100
      : null;
  const profitMargin =
    idx.sale_net_ratio_newest != null
      ? idx.sale_net_ratio_newest / 100
      : null;
  const roeIdx =
    idx.roe_newest != null ? idx.roe_newest / 100 : null;
  const dividendYield =
    idx.dividend_yield_ratio_newest != null
      ? idx.dividend_yield_ratio_newest / 100
      : null;

  // —— 重要指标（importance）最新 + 年报历史 ——
  const impLatest = latestPeriod(imp);
  const impAnnual = latestAnnual(imp);
  const currentRatio = impLatest?.vals.current_ratio ?? null;
  const quickRatio = impLatest?.vals.quick_ratio ?? null;

  // ROE：优先年报（更贴近年度口径），否则用 index_source 季度值
  const roe =
    impAnnual?.vals.index_weighted_avg_roe ?? roeIdx;

  // 营收 / ROE 历史（年报口径）
  const revenueHistory = imp
    .filter((p) => p.annual && p.vals.operating_income_total != null)
    .sort((a, b) => a.year - b.year)
    .map((p) => ({ year: p.year, revenue: p.vals.operating_income_total! }));
  const roeHistory = imp
    .filter((p) => p.annual && p.vals.index_weighted_avg_roe != null)
    .sort((a, b) => a.year - b.year)
    .map((p) => ({ year: p.year, roe: p.vals.index_weighted_avg_roe! }));
  const returnOnEquity5yAvg =
    roeHistory.length > 0
      ? roeHistory
          .slice(-5)
          .reduce((s, r) => s + (r.roe ?? 0), 0) / roeHistory.slice(-5).length
      : null;

  // —— 利润表（benefit）年度口径 ——
  const benAnnual = latestAnnual(ben);
  const benLatest = latestPeriod(ben);
  const totalRevenue = benAnnual?.vals.operating_income_total ?? null;
  const netIncome = benAnnual?.vals.parent_holder_net_profit ?? null;
  const operatingIncome = benAnnual?.vals.operating_profit ?? null; // ≈ EBIT
  const trailingEpsBen = benAnnual?.vals.basic_eps ?? null;

  // TTM 净利润（用于推算总市值）：2025年报 − 2025一季报 + 2026一季报
  let ttmNetIncome: number | null = null;
  const byName = (nm: string) => ben.find((p) => p.name.includes(nm));
  const a2025 = byName("2025年报");
  const q2025 = byName("2025一季报");
  const q2026 = byName("2026一季报");
  if (
    a2025?.vals.parent_holder_net_profit != null &&
    q2025?.vals.parent_holder_net_profit != null &&
    q2026?.vals.parent_holder_net_profit != null
  ) {
    ttmNetIncome =
      (a2025.vals.parent_holder_net_profit ?? 0) -
      (q2025.vals.parent_holder_net_profit ?? 0) +
      (q2026.vals.parent_holder_net_profit ?? 0);
  }

  // —— 资产负债表（debt）——
  const debtLatest = latestPeriod(debt);
  const totalDebt = debtLatest?.vals.total_debt ?? null;
  const totalEquity = debtLatest?.vals.holder_equity_total ?? null;
  const totalCash = debtLatest?.vals.cash ?? null;

  // —— 现金流量表（cash）——
  const cashLatest = latestPeriod(cash);
  const operatingCashFlow = cashLatest?.vals.act_cash_flow_net ?? null;
  // 同花顺现金流量表未单列自由现金流 → null（如需可近似 经营−购建固定资产，但保守置空）

  // —— 目标价序列 ——
  const currentPrice = target.price;
  const changePercent = target.change;
  const targetMeanPrice = target.mean;
  const targetHighPrice = target.high;
  const targetLowPrice = target.low;

  // —— 企业价值与估值倍数 ——
  // 总市值 = PE(TTM) × TTM净利润（由定义推导）
  let marketCap: number | null = null;
  if (peTtm != null && ttmNetIncome != null) {
    marketCap = peTtm * ttmNetIncome;
  }

  let enterpriseValue: number | null = null;
  if (marketCap != null && totalDebt != null && totalCash != null) {
    enterpriseValue = marketCap + totalDebt - totalCash;
  }
  const evEbit =
    enterpriseValue != null && operatingIncome && operatingIncome > 0
      ? enterpriseValue / operatingIncome
      : null;

  const debtToEquity =
    totalDebt != null && totalEquity != null && totalEquity > 0
      ? totalDebt / totalEquity
      : null;

  const pegRatio =
    peTtm != null && peTtm > 0 && netProfitGrowthPct != null && netProfitGrowthPct > 0
      ? peTtm / netProfitGrowthPct
      : null;

  const targetUpside =
    targetMeanPrice != null && currentPrice != null && currentPrice > 0
      ? (targetMeanPrice - currentPrice) / currentPrice
      : null;

  const warnings: string[] = [];
  if (marketCap == null)
    warnings.push("总市值由 PE×TTM净利润推算（同花顺未直接提供市值）");
  if (currentPrice == null) warnings.push("现价取自目标价序列，可能滞后");

  // EPS 优先利润表，否则实时指标
  const epsFinal = trailingEpsBen ?? trailingEps;

  return {
    ticker: ticker.toUpperCase(),
    name: rep.name,
    trailingPE: peTtm,
    forwardPE: null,
    pegRatio,
    industry: rep.industry,
    boardCode: null, // 同花顺无东方财富行业板块代码，同业对比将跳过
    industryPE: null,
    sector: null,
    industryRank: null,
    currentPrice,
    targetMeanPrice,
    targetHighPrice,
    targetLowPrice,
    targetMedianPrice: null,
    numberOfAnalysts: null, // 同花顺给定接口未提供分析师家数
    recommendationMean: null, // 同花顺给定接口未提供评级分布
    targetUpside,
    revenueGrowthYoY,
    quarterlyRevenueGrowth: revenueGrowthYoY,
    roe,
    returnOnEquity5yAvg,
    roeHistory,
    quickRatio,
    currentRatio,
    grossMargin,
    profitMargin,
    totalRevenue,
    revenueHistory,
    marketCap,
    currency: "CNY",
    changePercent,
    netIncome,
    operatingIncome,
    trailingEps: epsFinal,
    forwardEps: null,
    dividendYield,
    ebitda: null, // 同花顺利润表未单列 EBITDA
    evEbit,
    evEbitda: null,
    enterpriseValue,
    operatingCashFlow,
    freeCashFlow: null,
    totalCash,
    totalDebt,
    debtToEquity,
    week52High: null, // 同花顺给定接口未提供 52 周高低
    week52Low: null,
    ytdPercent: null,
    nextEarningsDate: null, // 同花顺给定接口未提供财报预约披露日
    analystRatings: null,
    news: rep.news,
    fetchedAt: new Date().toISOString(),
    dataSource: "ths",
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 兜底合并：同花顺优先，缺口字段用东方财富补齐                          */
/* ------------------------------------------------------------------ */

function mergeMetrics(
  ths: FinancialMetrics,
  em: FinancialMetrics
): FinancialMetrics {
  const merged: Record<string, any> = { ...em };
  for (const k of Object.keys(ths) as (keyof FinancialMetrics)[]) {
    const v = (ths as any)[k];
    if (v !== null && v !== undefined) merged[k] = v;
  }
  merged.dataSource = "ths";
  merged.warnings = [
    ...(ths.warnings ?? []),
    ...(em.warnings ?? []).map((w) => `东方财富兜底：${w}`),
  ];
  return merged as FinancialMetrics;
}

/**
 * A 股研报路径主入口：同花顺优先，缺口字段回退东方财富。
 * - 同花顺任一子接口失败仅置相关字段 null；
 * - 缺失（null）字段由东方财富 fetchCNFinancialMetrics 补齐；
 * - 两者皆失败返回 null，由上游走失败流程。
 */
export async function fetchCNThsFinancialMetrics(
  ticker: string
): Promise<FinancialMetrics | null> {
  const upper = ticker.toUpperCase();
  const [ths, em] = await Promise.all([
    fetchThsCore(upper).catch(() => null),
    fetchCNFinancialMetrics(upper).catch(() => null),
  ]);

  if (!ths && !em) return null;
  if (!ths) {
    return {
      ...em!,
      dataSource: "eastmoney",
      warnings: [
        ...(em!.warnings ?? []),
        "同花顺数据源不可用，整体回退东方财富",
      ],
    };
  }
  if (!em) return ths; // 东方财富兜底失败，仅用同花顺
  return mergeMetrics(ths, em);
}
