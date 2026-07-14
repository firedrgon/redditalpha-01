/**
 * A 股财务数据获取（雪球为主，东方财富降级）
 *
 * 数据源优先级：
 *   1. 雪球 Xueqiu — 行情 + 财务指标 + 利润表 + 资产负债表（需 token）
 *   2. 东方财富 Eastmoney — 公开 API，无需认证（兜底）
 *
 * 返回统一的 FinancialMetrics 结构，与分析流程（lib/analysis.ts）
 * 和策略体系（lib/strategies.ts）共用，市场无关。
 *
 * 雪球 symbol 格式：SH600519 / SZ000001（前置交易所代码）
 * 东方财富 secid 格式：1.600519（沪市前缀1）/ 0.000001（深市前缀0）
 */

import type { FinancialMetrics } from "./finance";
import { toXueqiuSymbol, toYahooSymbol, toTonghuashunSymbol, toTonghuashunCode } from "./market";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* 同花顺数据源（海外可访问，A 股主数据源）                              */
/* ------------------------------------------------------------------ */

interface THSRealheadResp {
  items?: Record<string, string> & { name?: string };
  time?: string;
}

/**
 * 解析同花顺 realhead JSONP 响应。
 * 格式：quotebridge_v6_realhead_hs_600519_last({...})
 */
function parseTHSJsonp(text: string): THSRealheadResp | null {
  const m = text.match(/\((\{[\s\S]*\})\)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as THSRealheadResp;
  } catch {
    return null;
  }
}

/**
 * 从同花顺 basic 页面提取 ROE 和毛利率（GBK 编码 HTML）。
 * basic 页面含：市盈率(dtsyl/jtsyl)、市净率(sjl)、净资产收益率、毛利率
 */
function extractTHSBasicMetrics(html: string): {
  roe: number | null;
  grossMargin: number | null;
  profitMargin: number | null;
} {
  // 净资产收益率：</span><span class="tip f12">10.57%</span>
  let roe: number | null = null;
  const roeM = html.match(/净资产收益率[：:]<\/span>\s*<span[^>]*>([0-9.]+)%<\/span>/);
  if (roeM) roe = parseFloat(roeM[1]) / 100;

  // 毛利率：</span><span class="tip f12">89.76%</span>
  let grossMargin: number | null = null;
  const gmM = html.match(/毛利率[：:]<\/span>\s*<span[^>]*>([0-9.]+)%<\/span>/);
  if (gmM) grossMargin = parseFloat(gmM[1]) / 100;

  // 净利率：</span><span class="tip f12">52.22%</span>
  let profitMargin: number | null = null;
  const pmM = html.match(/(?:净利率|销售净利率)[：:]<\/span>\s*<span[^>]*>([0-9.]+)%<\/span>/);
  if (pmM) profitMargin = parseFloat(pmM[1]) / 100;

  return { roe, grossMargin, profitMargin };
}

/**
 * 从同花顺获取 A 股财务数据（海外可访问，主数据源）。
 *
 * 数据来源：
 *   1. realhead 接口（d.10jqka.com.cn）— 股票名、当前价、PE、PB、总市值
 *   2. basic 页面（basic.10jqka.com.cn）— ROE、毛利率、净利率
 *
 * 返回 null 表示获取失败（由调用方降级到 Yahoo/雪球/东方财富）。
 */
async function fetchTonghuashunMetrics(
  ticker: string
): Promise<FinancialMetrics | null> {
  const thsSymbol = toTonghuashunSymbol(ticker);
  const code = toTonghuashunCode(ticker);
  if (!code) return null;

  // 1. realhead 实时行情
  let name: string | null = null;
  let currentPrice: number | null = null;
  let trailingPE: number | null = null;
  let forwardPE: number | null = null;
  let pb: number | null = null;
  let marketCap: number | null = null;

  try {
    const res = await fetch(
      `https://d.10jqka.com.cn/v6/realhead/${thsSymbol}/last.js`,
      {
        headers: { "User-Agent": UA, Referer: "https://basic.10jqka.com.cn/" },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      }
    );
    if (res.ok) {
      const body = await res.text();
      const data = parseTHSJsonp(body);
      const items = data?.items;
      if (items) {
        name = items.name ?? null;
        // 字段映射（已通过实测确认）
        const f = (k: string): number | null => {
          const v = items[k];
          if (!v) return null;
          const n = parseFloat(v);
          return isNaN(n) ? null : n;
        };
        currentPrice = f("10"); // 当前价
        trailingPE = f("2942"); // PE(动)
        forwardPE = f("3153"); // PE(静) 作为近似
        pb = f("592920"); // PB
        marketCap = f("3475914"); // 总市值
      }
    }
  } catch {
    /* ignore */
  }

  // 2. basic 页面获取 ROE、毛利率、净利率
  let roe: number | null = null;
  let grossMargin: number | null = null;
  let profitMargin: number | null = null;

  try {
    const res = await fetch(`https://basic.10jqka.com.cn/${code}/`, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://basic.10jqka.com.cn/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const html = new TextDecoder("gbk").decode(buf);
      const basic = extractTHSBasicMetrics(html);
      roe = basic.roe;
      grossMargin = basic.grossMargin;
      profitMargin = basic.profitMargin;
      // basic 页面 title 含股票名：贵州茅台(600519) ...
      if (!name) {
        const titleM = html.match(/<title>([^()（）]+)[(（]/);
        if (titleM) name = titleM[1].trim();
      }
      // basic 页面也有 PE，作为 realhead 的补充
      if (trailingPE == null) {
        const peM = html.match(/id="dtsyl"[^>]*>([0-9.]+)/);
        if (peM) trailingPE = parseFloat(peM[1]);
      }
    }
  } catch {
    /* ignore */
  }

  // 如果连名字和价格都没有，认为失败
  if (!name && currentPrice == null && trailingPE == null) {
    return null;
  }

  const metrics: FinancialMetrics = {
    ticker,
    name,
    trailingPE,
    forwardPE,
    pegRatio: null,
    industry: null,
    industryPE: null,
    sector: null,
    industryRank: null,
    currentPrice,
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    targetMedianPrice: null,
    numberOfAnalysts: null,
    recommendationMean: null,
    targetUpside: null,
    revenueGrowthYoY: null,
    quarterlyRevenueGrowth: null,
    roe,
    returnOnEquity5yAvg: null,
    roeHistory: [],
    quickRatio: null,
    currentRatio: null,
    grossMargin,
    profitMargin,
    totalRevenue: null,
    revenueHistory: [],
    marketCap,
    currency: "CNY",
    news: [],
    fetchedAt: new Date().toISOString(),
    dataSource: "tonghuashun",
    warnings: [],
  };

  return metrics;
}

/* ------------------------------------------------------------------ */
/* 雪球 token 获取                                                      */
/* ------------------------------------------------------------------ */

interface TokenCache {
  cookie: string;
  expireAt: number;
}

let tokenCache: TokenCache | null = null;

/**
 * 获取雪球访问 token（cookie）。
 *
 * 雪球接口需要带 cookie 访问，通过访问首页 https://xueqiu.com/ 获取。
 * token 在 serverless 实例生命周期内缓存 50 分钟。
 */
async function getXueqiuCookie(): Promise<string | null> {
  if (tokenCache && tokenCache.expireAt > Date.now()) {
    return tokenCache.cookie;
  }

  try {
    const res = await fetch("https://xueqiu.com/", {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    });

    // 解析 Set-Cookie 中的关键 token
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const rawSetCookie = res.headers.get("set-cookie") ?? "";
    const cookieLines = setCookies.length > 0 ? setCookies : rawSetCookie.split(/,(?=\s*\w+=)/);

    const tokens: string[] = [];
    for (const line of cookieLines) {
      const m = line.match(/^(xq_a_token|xqat|xq_r_token|u=\w+)/);
      if (m) {
        const pair = line.split(";")[0].trim();
        if (pair) tokens.push(pair);
      }
    }

    if (tokens.length === 0) {
      // 部分环境下 set-cookie 不可读，尝试不带 cookie 直接访问
      return null;
    }

    const cookie = tokens.join("; ");
    tokenCache = { cookie, expireAt: Date.now() + 50 * 60 * 1000 };
    return cookie;
  } catch {
    return null;
  }
}

/** 雪球 API 请求（自动带 cookie） */
async function xueqiuGet<T>(path: string): Promise<T | null> {
  const cookie = await getXueqiuCookie();
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: "https://xueqiu.com/",
  };
  if (cookie) headers.Cookie = cookie;

  try {
    const res = await fetch(`https://stock.xueqiu.com${path}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 雪球接口类型                                                        */
/* ------------------------------------------------------------------ */

interface XQQuoteResp {
  data?: {
    quote?: {
      symbol?: string;
      name?: string;
      current?: number;
      pe_ttm?: number;
      pb?: number;
      marketCapital?: number;
      currency?: string;
      type?: string;
      chg?: number;
      percent?: number;
      volume?: number;
      amount?: number;
      turnover_rate?: number;
      amplitude?: number;
      high?: number;
      low?: number;
      open?: number;
      last_close?: number;
      current_year_percent?: number;
    };
  };
}

interface XQIndicatorItem {
  report_date?: string;
  roe?: number; // ROE
  roe_diluted?: number; // 稀释 ROE
  np_per_parent_company_shareholders?: number; // EPS
  np_per_parent_company_shareholders_yoy?: number; // EPS 同比
  total_operating_revenue?: number; // 营业总收入
  total_operating_revenue_yoy?: number; // 营收同比（小数）
  parent_company_net_profit?: number; // 归母净利润
  parent_company_net_profit_yoy?: number; // 归母净利同比
  gross_selling_rate?: number; // 毛利率（小数）
  net_selling_rate?: number; // 净利率（小数）
  quick_ratio?: number; // 速动比率
  current_ratio?: number; // 流动比率
  debt_ratio?: number; // 资产负债率
}

interface XQIndicatorResp {
  data?: { list?: XQIndicatorItem[] };
}

interface XQIncomeItem {
  report_date?: string;
  total_operating_revenue?: number;
  total_operating_revenue_yoy?: number;
  operating_income?: number;
  operating_cost?: number;
  parent_company_net_profit?: number;
  parent_company_net_profit_yoy?: number;
}

interface XQIncomeResp {
  data?: { list?: XQIncomeItem[] };
}

interface XQBalanceItem {
  report_date?: string;
  total_assets?: number;
  total_liabilities?: number;
  total_equity?: number;
  total_current_assets?: number;
  total_current_liabilities?: number;
}

interface XQBalanceResp {
  data?: { list?: XQBalanceItem[] };
}

/* ------------------------------------------------------------------ */
/* 雪球财务数据组装                                                     */
/* ------------------------------------------------------------------ */

/**
 * 从雪球获取 A 股财务数据，组装为 FinancialMetrics。
 * 失败返回 null（由调用方降级到东方财富）。
 */
async function fetchXueqiuMetrics(
  ticker: string
): Promise<FinancialMetrics | null> {
  const symbol = toXueqiuSymbol(ticker);

  // 并行请求行情、财务指标、利润表、资产负债表
  const [quoteResp, indicatorResp, incomeResp, balanceResp] =
    await Promise.all([
      xueqiuGet<XQQuoteResp>(`/v5/stock/quote.json?symbol=${symbol}&extend=detail`),
      xueqiuGet<XQIndicatorResp>(
        `/v5/stock/finance/cn/indicator.json?symbol=${symbol}&type=Q4&count=6&is_detail=true`
      ),
      xueqiuGet<XQIncomeResp>(
        `/v5/stock/finance/cn/income.json?symbol=${symbol}&type=Q4&count=6&is_detail=true`
      ),
      xueqiuGet<XQBalanceResp>(
        `/v5/stock/finance/cn/balance.json?symbol=${symbol}&type=Q4&count=6&is_detail=true`
      ),
    ]);

  const quote = quoteResp?.data?.quote;
  if (!quote) return null;

  const indicators = indicatorResp?.data?.list ?? [];
  const incomes = incomeResp?.data?.list ?? [];
  const balances = balanceResp?.data?.list ?? [];

  // 最新一期财务指标
  const latest = indicators[0];
  // 历史营收（按年，取年报 Q4）
  const revenueHistory = incomes
    .map((item) => ({
      year: item.report_date ? new Date(item.report_date).getFullYear() : 0,
      revenue: item.total_operating_revenue ?? null,
    }))
    .filter((x) => x.year && x.revenue != null)
    .reverse();

  // ROE 历史
  const roeHistory = indicators
    .map((item) => ({
      year: item.report_date ? new Date(item.report_date).getFullYear() : 0,
      roe: item.roe ?? item.roe_diluted ?? null,
    }))
    .filter((x) => x.year && x.roe != null)
    .reverse();

  const returnOnEquity5yAvg =
    roeHistory.length > 0
      ? roeHistory.slice(0, 5).reduce((s, x) => s + (x.roe ?? 0), 0) /
        Math.min(5, roeHistory.length)
      : null;

  const currentPrice = quote.current ?? null;
  const marketCap = quote.marketCapital ?? null;
  const trailingPE = quote.pe_ttm ?? null;

  // A 股 forwardPE 雪球不直接提供，置 null
  const forwardPE = null;
  // A 股 pegRatio = PE / 营收增速（简化，无分析师预期增速）
  const pegRatio = null;

  // 分析师目标价：A 股雪球接口不提供，置 null（分析策略中 targetUpside 判定会 skip）
  const targetMeanPrice = null;
  const targetHighPrice = null;
  const targetLowPrice = null;
  const targetMedianPrice = null;
  const numberOfAnalysts = null;
  const recommendationMean = null;
  const targetUpside = null;

  // 成长性
  const revenueGrowthYoY = latest?.total_operating_revenue_yoy ?? null;
  const quarterlyRevenueGrowth = null;

  // 盈利能力
  const roe = latest?.roe ?? latest?.roe_diluted ?? null;
  const grossMargin = latest?.gross_selling_rate ?? null;
  const profitMargin = latest?.net_selling_rate ?? null;

  // 流动性
  const quickRatio = latest?.quick_ratio ?? null;
  const currentRatio = latest?.current_ratio ?? null;

  // 财报
  const totalRevenue = latest?.total_operating_revenue ?? null;

  const metrics: FinancialMetrics = {
    ticker,
    name: quote.name ?? null,
    trailingPE,
    forwardPE,
    pegRatio,
    industry: null, // 雪球 quote 不直接返回行业
    industryPE: null,
    sector: null,
    industryRank: null,
    currentPrice,
    targetMeanPrice,
    targetHighPrice,
    targetLowPrice,
    targetMedianPrice,
    numberOfAnalysts,
    recommendationMean,
    targetUpside,
    revenueGrowthYoY,
    quarterlyRevenueGrowth,
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
    news: [],
    fetchedAt: new Date().toISOString(),
    dataSource: "xueqiu",
    warnings: [],
  };

  return metrics;
}

/* ------------------------------------------------------------------ */
/* 东方财富降级数据源                                                   */
/* ------------------------------------------------------------------ */

interface EMMarketResp {
  data?: {
    f43?: number; // 最新价
    f44?: number; // 最高
    f45?: number; // 最低
    f46?: number; // 今开
    f57?: string; // 代码
    f58?: string; // 名称
    f60?: number; // 昨收
    f116?: number; // 总市值
    f117?: number; // 流通市值
    f162?: number; // PE(动)
    f167?: number; // PB
    f168?: number; // 换手
    f170?: number; // 涨跌幅
    f171?: number; // 涨跌额
    f184?: number; // 同比
    f185?: number; // ROE
    f186?: number; // 毛利率
    f187?: number; // 净利率
    f188?: number; // 速动比率
    f189?: number; // 流动比率
  };
}

interface EMFinanceRow {
  REPORT_DATE?: string;
  TOTAL_OPERATE_INCOME?: number;
  TOTAL_OPERATE_INCOME_YOY?: number;
  PARENT_NETPROFIT?: number;
  PARENT_NETPROFIT_YOY?: number;
  ROE_DILUTED?: number;
  GROSS_PROFIT_RATIO?: number; // 毛利率（小数）
  NET_PROFIT_RATIO?: number; // 净利率（小数）
  QUICK_RATIO?: number;
  CURRENT_RATIO?: number;
}

interface EMFinanceResp {
  result?: {
    data?: EMFinanceRow[];
  };
}

/**
 * 从东方财富获取 A 股财务数据（公开 API，无需认证）。
 * 作为雪球的降级方案。
 */
async function fetchEastmoneyMetrics(
  ticker: string
): Promise<FinancialMetrics | null> {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return null;
  const [, code, ex] = m;
  // 东方财富 secid：沪市前缀 1，深市前缀 0
  const secid = ex === "SH" ? `1.${code}` : `0.${code}`;
  const emCode = `${code}.${ex}`;

  // 行情
  let quote: EMMarketResp["data"] | null = null;
  try {
    const fields = "f43,f44,f45,f46,f57,f58,f60,f116,f117,f162,f167,f168,f170,f184,f185,f186,f187,f188,f189";
    const res = await fetch(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`,
      { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" }, signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const json = (await res.json()) as { data?: EMMarketResp["data"] };
      quote = json.data ?? null;
    }
  } catch {
    /* ignore */
  }

  if (!quote || !quote.f58) return null;

  // 财务摘要
  let finance: EMFinanceRow | null = null;
  let financeHistory: EMFinanceRow[] = [];
  try {
    const res = await fetch(
      `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=6&sortColumns=REPORT_DATE&sortTypes=-1`,
      { headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" }, signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const json = (await res.json()) as EMFinanceResp;
      financeHistory = json.result?.data ?? [];
      finance = financeHistory[0] ?? null;
    }
  } catch {
    /* ignore */
  }

  // 历史营收
  const revenueHistory = financeHistory
    .map((row) => ({
      year: row.REPORT_DATE ? new Date(row.REPORT_DATE).getFullYear() : 0,
      revenue: row.TOTAL_OPERATE_INCOME ?? null,
    }))
    .filter((x) => x.year && x.revenue != null)
    .reverse();

  const roeHistory = financeHistory
    .map((row) => ({
      year: row.REPORT_DATE ? new Date(row.REPORT_DATE).getFullYear() : 0,
      roe: row.ROE_DILUTED ?? null,
    }))
    .filter((x) => x.year && x.roe != null)
    .reverse();

  const returnOnEquity5yAvg =
    roeHistory.length > 0
      ? roeHistory.slice(0, 5).reduce((s, x) => s + (x.roe ?? 0), 0) /
        Math.min(5, roeHistory.length)
      : null;

  // 东方财富价格单位：分 → 元
  const priceDivisor = 100;

  const metrics: FinancialMetrics = {
    ticker,
    name: quote.f58 ?? null,
    trailingPE: quote.f162 != null ? quote.f162 : null,
    forwardPE: null,
    pegRatio: null,
    industry: null,
    industryPE: null,
    sector: null,
    industryRank: null,
    currentPrice: quote.f43 != null ? quote.f43 / priceDivisor : null,
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    targetMedianPrice: null,
    numberOfAnalysts: null,
    recommendationMean: null,
    targetUpside: null,
    revenueGrowthYoY: finance?.TOTAL_OPERATE_INCOME_YOY ?? null,
    quarterlyRevenueGrowth: null,
    roe: finance?.ROE_DILUTED ?? null,
    returnOnEquity5yAvg,
    roeHistory,
    quickRatio: finance?.QUICK_RATIO ?? null,
    currentRatio: finance?.CURRENT_RATIO ?? null,
    grossMargin: finance?.GROSS_PROFIT_RATIO ?? null,
    profitMargin: finance?.NET_PROFIT_RATIO ?? null,
    totalRevenue: finance?.TOTAL_OPERATE_INCOME ?? null,
    revenueHistory,
    marketCap: quote.f116 != null ? quote.f116 : null,
    currency: "CNY",
    news: [],
    fetchedAt: new Date().toISOString(),
    dataSource: "eastmoney",
    warnings: [],
  };

  return metrics;
}

/* ------------------------------------------------------------------ */
/* Yahoo Finance A 股降级（海外服务器可访问）                           */
/* ------------------------------------------------------------------ */

interface YahooV7QuoteResp {
  quoteResponse?: {
    result?: Array<{
      symbol?: string;
      shortName?: string;
      longName?: string;
      regularMarketPrice?: number;
      trailingPE?: number;
      forwardPE?: number;
      priceToSalesTrailing12Months?: number;
      marketCap?: number;
      currency?: string;
      fiftyTwoWeekHigh?: number;
      fiftyTwoWeekLow?: number;
      regularMarketChangePercent?: number;
      averageAnalystRating?: string;
    }>;
    error?: { code?: string; description?: string };
  };
}

interface YahooQuoteSummaryResp {
  quoteSummary?: {
    result?: Array<{
      summaryDetail?: {
        trailingPE?: { raw?: number };
        forwardPE?: { raw?: number };
        pegRatio?: { raw?: number };
        profitMargins?: { raw?: number };
        grossMargins?: { raw?: number };
        returnOnEquity?: { raw?: number };
        currentRatio?: { raw?: number };
        quickRatio?: { raw?: number };
        revenueGrowth?: { raw?: number };
        marketCap?: { raw?: number };
        fiftyTwoWeekHigh?: { raw?: number };
        fiftyTwoWeekLow?: { raw?: number };
        targetMeanPrice?: { raw?: number };
        targetHighPrice?: { raw?: number };
        targetLowPrice?: { raw?: number };
        targetMedianPrice?: { raw?: number };
        numberOfAnalystOpinions?: { raw?: number };
        recommendationMean?: { raw?: number };
      };
      financialData?: {
        currentRatio?: { raw?: number };
        quickRatio?: { raw?: number };
        returnOnEquity?: { raw?: number };
        revenueGrowth?: { raw?: number };
        grossMargins?: { raw?: number };
        profitMargins?: { raw?: number };
        operatingMargins?: { raw?: number };
        targetMeanPrice?: { raw?: number };
        targetHighPrice?: { raw?: number };
        targetLowPrice?: { raw?: number };
        targetMedianPrice?: { raw?: number };
        numberOfAnalystOpinions?: { raw?: number };
        recommendationMean?: { raw?: number };
        totalRevenue?: { raw?: number };
        revenueGrowthQuarterly?: { raw?: number };
      };
      summaryProfile?: {
        sector?: string;
        industry?: string;
        longName?: string;
        shortName?: string;
      };
      price?: {
        regularMarketPrice?: { raw?: number };
        marketCap?: { raw?: number };
        currency?: string;
        shortName?: string;
        longName?: string;
      };
    }>;
    error?: { code?: string; description?: string };
  };
}

/** Yahoo crumb + cookie 缓存 */
let yahooCrumb: { crumb: string; cookie: string; expireAt: number } | null = null;

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (yahooCrumb && yahooCrumb.expireAt > Date.now()) {
    return { crumb: yahooCrumb.crumb, cookie: yahooCrumb.cookie };
  }
  try {
    // 1. 获取 cookie
    const cookieRes = await fetch("https://fc.yahoo.com/", {
      redirect: "manual",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    const setCookies = cookieRes.headers.getSetCookie?.() ?? [];
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) return null;

    // 2. 用 cookie 获取 crumb
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie },
      signal: AbortSignal.timeout(8000),
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) return null;

    yahooCrumb = { crumb, cookie, expireAt: Date.now() + 50 * 60 * 1000 };
    return { crumb, cookie };
  } catch {
    return null;
  }
}

/**
 * 从 Yahoo Finance 获取 A 股财务数据（海外服务器可访问）。
 * 使用 .SS/.SZ 后缀格式。作为雪球/东方财富的降级方案。
 */
async function fetchYahooCNMetrics(
  ticker: string
): Promise<FinancialMetrics | null> {
  const yahooSymbol = toYahooSymbol(ticker);

  const crumbInfo = await getYahooCrumb();
  const headers: Record<string, string> = { "User-Agent": UA };
  if (crumbInfo?.cookie) headers.Cookie = crumbInfo.cookie;
  const crumbParam = crumbInfo?.crumb ? `&crumb=${encodeURIComponent(crumbInfo.crumb)}` : "";

  // 1. v7 quote 获取基本行情
  let name: string | null = null;
  let currentPrice: number | null = null;
  let trailingPE: number | null = null;
  let forwardPE: number | null = null;
  let marketCap: number | null = null;
  let currency = "CNY";

  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooSymbol)}${crumbParam}`;
    const res = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = (await res.json()) as YahooV7QuoteResp;
      const q = data?.quoteResponse?.result?.[0];
      if (q) {
        name = q.shortName || q.longName || null;
        currentPrice = q.regularMarketPrice ?? null;
        trailingPE = q.trailingPE ?? null;
        forwardPE = q.forwardPE ?? null;
        marketCap = q.marketCap ?? null;
        currency = q.currency || "CNY";
      }
    }
  } catch {
    /* ignore, try quoteSummary */
  }

  // 2. quoteSummary 获取财务指标
  let pegRatio: number | null = null;
  let grossMargin: number | null = null;
  let profitMargin: number | null = null;
  let roe: number | null = null;
  let quickRatio: number | null = null;
  let currentRatio: number | null = null;
  let revenueGrowthYoY: number | null = null;
  let totalRevenue: number | null = null;
  let targetMeanPrice: number | null = null;
  let targetHighPrice: number | null = null;
  let targetLowPrice: number | null = null;
  let targetMedianPrice: number | null = null;
  let numberOfAnalysts: number | null = null;
  let recommendationMean: number | null = null;
  let industry: string | null = null;
  let sector: string | null = null;
  let quarterlyRevenueGrowth: number | null = null;

  try {
    const modules = "summaryDetail,financialData,summaryProfile,price";
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}${crumbParam}`;
    const res = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = (await res.json()) as YahooQuoteSummaryResp;
      const result = data?.quoteSummary?.result?.[0];
      if (result) {
        const sd = result.summaryDetail || {};
        const fd = result.financialData || {};
        const sp = result.summaryProfile || {};
        const pr = result.price || {};

        if (!name) name = pr.shortName || pr.longName || sp.shortName || sp.longName || null;
        if (!currentPrice) currentPrice = pr.regularMarketPrice?.raw ?? null;
        if (!marketCap) marketCap = pr.marketCap?.raw ?? sd.marketCap?.raw ?? null;
        if (pr.currency) currency = pr.currency;

        trailingPE = sd.trailingPE?.raw ?? trailingPE;
        forwardPE = sd.forwardPE?.raw ?? forwardPE;
        pegRatio = sd.pegRatio?.raw ?? null;
        grossMargin = sd.grossMargins?.raw ?? fd.grossMargins?.raw ?? null;
        profitMargin = sd.profitMargins?.raw ?? fd.profitMargins?.raw ?? null;
        roe = sd.returnOnEquity?.raw ?? fd.returnOnEquity?.raw ?? null;
        quickRatio = sd.quickRatio?.raw ?? fd.quickRatio?.raw ?? null;
        currentRatio = sd.currentRatio?.raw ?? fd.currentRatio?.raw ?? null;
        revenueGrowthYoY = sd.revenueGrowth?.raw ?? fd.revenueGrowth?.raw ?? null;
        totalRevenue = fd.totalRevenue?.raw ?? null;
        quarterlyRevenueGrowth = fd.revenueGrowthQuarterly?.raw ?? null;
        targetMeanPrice = sd.targetMeanPrice?.raw ?? fd.targetMeanPrice?.raw ?? null;
        targetHighPrice = sd.targetHighPrice?.raw ?? fd.targetHighPrice?.raw ?? null;
        targetLowPrice = sd.targetLowPrice?.raw ?? fd.targetLowPrice?.raw ?? null;
        targetMedianPrice = sd.targetMedianPrice?.raw ?? fd.targetMedianPrice?.raw ?? null;
        numberOfAnalysts = sd.numberOfAnalystOpinions?.raw ?? fd.numberOfAnalystOpinions?.raw ?? null;
        recommendationMean = sd.recommendationMean?.raw ?? fd.recommendationMean?.raw ?? null;
        industry = sp.industry || null;
        sector = sp.sector || null;
      }
    }
  } catch {
    /* ignore */
  }

  // 如果连名字和价格都拿不到，认为失败
  if (!name && currentPrice == null && trailingPE == null) {
    return null;
  }

  const targetUpside =
    targetMeanPrice != null && currentPrice != null && currentPrice > 0
      ? (targetMeanPrice - currentPrice) / currentPrice
      : null;

  const metrics: FinancialMetrics = {
    ticker,
    name,
    trailingPE,
    forwardPE,
    pegRatio,
    industry,
    industryPE: null,
    sector,
    industryRank: null,
    currentPrice,
    targetMeanPrice,
    targetHighPrice,
    targetLowPrice,
    targetMedianPrice,
    numberOfAnalysts,
    recommendationMean,
    targetUpside,
    revenueGrowthYoY,
    quarterlyRevenueGrowth,
    roe,
    returnOnEquity5yAvg: null,
    roeHistory: [],
    quickRatio,
    currentRatio,
    grossMargin,
    profitMargin,
    totalRevenue,
    revenueHistory: [],
    marketCap,
    currency,
    news: [],
    fetchedAt: new Date().toISOString(),
    dataSource: "yahoo",
    warnings: [],
  };

  return metrics;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 获取 A 股财务数据：同花顺优先 → 雪球 → 东方财富 → Yahoo Finance 降级。
 *
 * 同花顺在海外可访问（d.10jqka.com.cn / basic.10jqka.com.cn），作为主数据源。
 * 雪球/东方财富在国内环境快，但 Vercel 海外服务器可能无法访问，作为降级。
 * Yahoo Finance 作为最终降级（海外可访问，支持 A 股 .SS/.SZ 格式）。
 */
export async function fetchCNFinancialMetrics(
  ticker: string
): Promise<FinancialMetrics> {
  const warnings: string[] = [];

  // 1. 同花顺（海外可访问，主数据源）
  try {
    const ths = await fetchTonghuashunMetrics(ticker);
    if (ths) return ths;
    warnings.push("同花顺数据获取失败");
  } catch (err) {
    warnings.push(`同花顺异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. 雪球降级
  try {
    const xq = await fetchXueqiuMetrics(ticker);
    if (xq) {
      if (warnings.length > 0) xq.warnings = [...xq.warnings, ...warnings];
      return xq;
    }
    warnings.push("雪球数据获取失败");
  } catch (err) {
    warnings.push(`雪球异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. 东方财富降级
  try {
    const em = await fetchEastmoneyMetrics(ticker);
    if (em) {
      if (warnings.length > 0) em.warnings = [...em.warnings, ...warnings];
      return em;
    }
    warnings.push("东方财富数据获取失败");
  } catch (err) {
    warnings.push(`东方财富异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Yahoo Finance 降级（海外服务器可访问）
  try {
    const yh = await fetchYahooCNMetrics(ticker);
    if (yh) {
      if (warnings.length > 0) yh.warnings = [...yh.warnings, ...warnings];
      return yh;
    }
    warnings.push("Yahoo Finance 数据获取失败");
  } catch (err) {
    warnings.push(`Yahoo异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. 全 null fallback
  return {
    ticker,
    name: null,
    trailingPE: null,
    forwardPE: null,
    pegRatio: null,
    industry: null,
    industryPE: null,
    sector: null,
    industryRank: null,
    currentPrice: null,
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    targetMedianPrice: null,
    numberOfAnalysts: null,
    recommendationMean: null,
    targetUpside: null,
    revenueGrowthYoY: null,
    quarterlyRevenueGrowth: null,
    roe: null,
    returnOnEquity5yAvg: null,
    roeHistory: [],
    quickRatio: null,
    currentRatio: null,
    grossMargin: null,
    profitMargin: null,
    totalRevenue: null,
    revenueHistory: [],
    marketCap: null,
    currency: "CNY",
    news: [],
    fetchedAt: new Date().toISOString(),
    dataSource: "fallback",
    warnings: ["A 股数据源（同花顺/雪球/东方财富/Yahoo）均获取失败", ...warnings],
  };
}
