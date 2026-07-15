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
import { toXueqiuSymbol, toYahooSymbol, toTonghuashunSymbol, toTonghuashunCode, toTencentSymbol } from "./market";

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
/* 腾讯财经数据源（全球可访问，行情数据）                                */
/* ------------------------------------------------------------------ */

/**
 * 从腾讯财经获取 A 股行情数据（全球可访问，无需认证）。
 *
 * 接口：https://qt.gtimg.cn/q=sh600276
 * 返回 GBK 编码的 JS 变量：v_sh600276="1~恒瑞医药~600276~54.82~..."
 *
 * 字段映射（~分隔）：
 *   [1]=名称 [2]=代码 [3]=当前价 [4]=昨收 [5]=今开
 *   [33]=最高 [34]=最低 [39]=PE(动) [46]=PB [45]=总市值(亿)
 */
async function fetchTencentMetrics(
  ticker: string
): Promise<FinancialMetrics | null> {
  const symbol = toTencentSymbol(ticker);

  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    const text = new TextDecoder("gbk").decode(buf);

    // 解析：v_sh600276="1~恒瑞医药~600276~54.82~...";
    const m = text.match(/v_\w+="([^"]+)"/);
    if (!m) return null;

    const fields = m[1].split("~");
    if (fields.length < 50) return null;

    const name = fields[1] || null;
    const parseNum = (s: string | undefined): number | null => {
      if (!s) return null;
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };

    const currentPrice = parseNum(fields[3]);
    // 腾讯总市值单位是"亿"，转换为元
    const marketCapYi = parseNum(fields[45]);
    const marketCap = marketCapYi != null ? marketCapYi * 1e8 : null;

    if (!name && currentPrice == null) return null;

    const metrics: FinancialMetrics = {
      ticker,
      name,
      trailingPE: parseNum(fields[39]),
      forwardPE: null,
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
      roe: null,
      returnOnEquity5yAvg: null,
      roeHistory: [],
      quickRatio: null,
      currentRatio: null,
      grossMargin: null,
      profitMargin: null,
      totalRevenue: null,
      revenueHistory: [],
      marketCap,
      currency: "CNY",
      news: [],
      fetchedAt: new Date().toISOString(),
      dataSource: "tencent",
      warnings: [],
    };

    return metrics;
  } catch {
    return null;
  }
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
/* 东方财富 F10 财务补充（速动比率/营收增长/5年ROE/行业PE/PEG 数据）     */
/* ------------------------------------------------------------------ */

interface EMZyzbRow {
  REPORT_DATE?: string;
  REPORT_TYPE?: string; // "年报" | "一季报" | "中报" | "三季报"
  ROEJQ?: number; // 加权 ROE（百分比，如 4.15 表示 4.15%）
  XSMLL?: number; // 销售毛利率（百分比）
  XSJLL?: number; // 销售净利率（百分比）
  TOTALOPERATEREVE?: number; // 营业总收入
  TOTALOPERATEREVETZ?: number; // 营收同比增长（百分比）
  PARENTNETPROFIT?: number; // 归母净利润
  PARENTNETPROFITTZ?: number; // 净利润同比增长（百分比）
  LD?: number; // 流动比率
  SD?: number; // 速动比率
  BPS?: number; // 每股净资产
}

interface EMZyzbResp {
  data?: EMZyzbRow[];
}

interface EMCpdRow {
  BOARD_CODE?: string; // 行业板块代码，如 BK0465
  BOARD_NAME?: string; // 行业名，如 "化学制药"
  PUBLISHNAME?: string; // 行业别名
  YSTZ?: number; // 营收同比增长（百分比）
  SJLTZ?: number; // 净利润同比增长（百分比）
  WEIGHTAVG_ROE?: number; // 加权 ROE（百分比）
  XSMLL?: number; // 销售毛利率（百分比）
  TOTAL_OPERATE_INCOME?: number;
  PARENT_NETPROFIT?: number;
  REPORTDATE?: string;
}

interface EMCpdResp {
  result?: { data?: EMCpdRow[] };
}

interface FinanceSupplement {
  revenueGrowthYoY: number | null;
  quarterlyRevenueGrowth: number | null; // 季度/TTM 营收增长（小数）
  netProfitGrowthPct: number | null; // 净利润同比增长（百分比原值，用于 PEG 计算）
  roe: number | null;
  returnOnEquity5yAvg: number | null;
  roeHistory: { year: number; roe: number | null }[];
  grossMargin: number | null;
  profitMargin: number | null;
  quickRatio: number | null;
  currentRatio: number | null;
  totalRevenue: number | null;
  revenueHistory: { year: number; revenue: number | null }[];
  industry: string | null;
  industryPE: number | null;
  // 分析师共识（来自东方财富研报接口）
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalysts: number | null;
  recommendationMean: number | null; // 1=买入 2=增持 3=中性 4=减持 5=卖出
}

/* ------------------------------------------------------------------ */
/* 东方财富研报接口（分析师目标价 + 评级）                                */
/* ------------------------------------------------------------------ */

interface EMReportItem {
  orgSName?: string; // 研究机构
  publishDate?: string;
  emRatingName?: string; // 评级文字：买入/增持/中性/减持/卖出
  sRatingName?: string; // 评级文字备份
  indvAimPriceT?: string | number; // 目标价
  indvAimPriceL?: string | number; // 目标价（底线）
  predictThisYearPe?: string | number;
  predictNextYearPe?: string | number;
}

interface EMReportResp {
  hits?: number;
  data?: EMReportItem[];
}

interface AnalystConsensus {
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalysts: number | null;
  recommendationMean: number | null;
}

// 评级文字 → 数值（与 Yahoo 约定一致：1=强力买入, 2=买入, 3=持有, 4=卖出, 5=强力卖出）
const RATING_VALUE_MAP: Record<string, number> = {
  买入: 1,
  推荐: 1,
  强买: 1,
  强力买入: 1,
  增持: 2,
  优于大势: 2,
  谨慎推荐: 2,
  中性: 3,
  同步大市: 3,
  持有: 3,
  减持: 4,
  回避: 5,
  卖出: 5,
};

/* ------------------------------------------------------------------ */
/* 百度股市通 HTML 页面解析（优先数据源）                                */
/* ------------------------------------------------------------------ */

/**
 * 百度股市通页面提取的全部数据（财务指标 + 分析师共识）。
 * 来自 https://finance.baidu.com/stock/ab-{code} 的 SSR HTML。
 */
interface BaiduStockData {
  name: string | null;
  currentPrice: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  marketCap: number | null;
  roe: number | null;
  grossMargin: number | null;
  profitMargin: number | null;
  revenueGrowthYoY: number | null;
  // 分析师共识
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalysts: number | null;
  recommendationMean: number | null;
}

/**
 * 从百度股市通页面提取股票数据（HTML 解析，非 API）。
 *
 * 页面：https://finance.baidu.com/stock/ab-{code}
 * 百度股市通是 SSR 页面，数据嵌入在 HTML 中（__INITIAL_STATE__ 或文本标签）。
 *
 * 解析策略：
 *   1. 优先从 window.__INITIAL_STATE__ / __NEXT_DATA__ 的 JSON 中提取
 *   2. 降级到正则匹配页面可见文本（"市盈率" "目标价" 等关键词附近数字）
 *
 * 返回 null 表示页面不可访问（如服务器 IP 被 403）或解析失败。
 * 由调用方降级到东方财富数据源。
 */
async function fetchBaiduStockPageData(
  ticker: string
): Promise<BaiduStockData | null> {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return null;
  const [, code] = m;

  try {
    const res = await fetch(
      `https://finance.baidu.com/stock/ab-${code}`,
      {
        headers: {
          "User-Agent": UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          Referer: "https://finance.baidu.com/",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }
    );
    // 百度对部分服务器 IP 返回 403，降级到东方财富
    if (!res.ok) return null;

    const html = await res.text();
    if (!html || html.length < 500) return null;

    const result: BaiduStockData = {
      name: null,
      currentPrice: null,
      trailingPE: null,
      forwardPE: null,
      priceToBook: null,
      marketCap: null,
      roe: null,
      grossMargin: null,
      profitMargin: null,
      revenueGrowthYoY: null,
      targetMeanPrice: null,
      targetHighPrice: null,
      targetLowPrice: null,
      numberOfAnalysts: null,
      recommendationMean: null,
    };

    // 方式1：从 SSR JSON 提取（__INITIAL_STATE__ 或 __NEXT_DATA__）
    const jsonMatch =
      html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/) ||
      html.match(
        /<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/
      );

    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        // 递归查找数值字段（百度字段名不固定，按候选名匹配）
        const findNum = (
          obj: unknown,
          keys: string[]
        ): number | null => {
          if (obj == null) return null;
          if (typeof obj === "object") {
            const o = obj as Record<string, unknown>;
            for (const k of keys) {
              const v = o[k];
              if (typeof v === "number" && v > 0) return v;
              if (typeof v === "string" && v && !isNaN(Number(v))) {
                const n = Number(v);
                if (n > 0) return n;
              }
            }
            for (const v of Object.values(o)) {
              const r = findNum(v, keys);
              if (r != null) return r;
            }
          }
          return null;
        };
        const findStr = (
          obj: unknown,
          keys: string[]
        ): string | null => {
          if (obj == null) return null;
          if (typeof obj === "object") {
            const o = obj as Record<string, unknown>;
            for (const k of keys) {
              const v = o[k];
              if (typeof v === "string" && v) return v;
            }
            for (const v of Object.values(o)) {
              const r = findStr(v, keys);
              if (r != null) return r;
            }
          }
          return null;
        };

        result.name = findStr(data, ["name", "stockName", "secName"]);
        result.currentPrice = findNum(data, [
          "currentPrice",
          "price",
          "lastClose",
          "close",
        ]);
        result.trailingPE = findNum(data, [
          "peTtm",
          "trailingPE",
          "pe",
          "dynamicPE",
        ]);
        result.forwardPE = findNum(data, ["forwardPE", "peForward"]);
        result.priceToBook = findNum(data, [
          "pb",
          "priceToBook",
          "pbRatio",
        ]);
        result.marketCap = findNum(data, [
          "marketCap",
          "totalMarketValue",
          "mv",
        ]);
        result.roe = findNum(data, ["roe", "returnOnEquity"]);
        result.grossMargin = findNum(data, [
          "grossMargin",
          "grossProfitMargin",
        ]);
        result.profitMargin = findNum(data, [
          "netProfitMargin",
          "profitMargin",
        ]);
        result.revenueGrowthYoY = findNum(data, [
          "revenueGrowth",
          "revenueYoY",
          "incomeGrowth",
        ]);
        result.targetMeanPrice = findNum(data, [
          "targetPrice",
          "targetMeanPrice",
          "aimPrice",
          "avgTargetPrice",
        ]);
        result.targetHighPrice = findNum(data, [
          "targetHighPrice",
          "maxTargetPrice",
        ]);
        result.targetLowPrice = findNum(data, [
          "targetLowPrice",
          "minTargetPrice",
        ]);
        result.numberOfAnalysts = findNum(data, [
          "analystCount",
          "orgCount",
          "institutionCount",
        ]);
        result.recommendationMean = findNum(data, [
          "ratingValue",
          "recommendationMean",
          "avgRating",
        ]);
      } catch {
        /* JSON 解析失败，降级到正则 */
      }
    }

    // 方式2：正则匹配页面可见文本
    // 匹配 "标签名 ... 数字" 模式（标签和数字间可能有标签/空白）
    const matchNum = (label: string): number | null => {
      // 市盈率(动) 39.86  或  <span>市盈率</span><span>39.86</span>
      const re = new RegExp(
        `${label}[^0-9-]*([0-9]+\\.?[0-9]*)`
      );
      const mm = html.match(re);
      if (mm) {
        const n = parseFloat(mm[1]);
        if (!isNaN(n) && n > 0) return n;
      }
      return null;
    };

    if (result.trailingPE == null)
      result.trailingPE = matchNum("市盈率");
    if (result.priceToBook == null)
      result.priceToBook = matchNum("市净率");
    if (result.roe == null) result.roe = matchNum("净资产收益率");
    if (result.grossMargin == null)
      result.grossMargin = matchNum("毛利率");
    if (result.profitMargin == null)
      result.profitMargin = matchNum("净利率");
    if (result.revenueGrowthYoY == null)
      result.revenueGrowthYoY = matchNum("营收增长");
    if (result.targetMeanPrice == null)
      result.targetMeanPrice = matchNum("目标价");
    if (result.marketCap == null)
      result.marketCap = matchNum("总市值");

    // 评级文字匹配
    if (result.recommendationMean == null) {
      const ratingMatch = html.match(
        /(?:综合评级|机构评级|一致评级)[^<]*<[^>]*>(买入|增持|中性|减持|卖出|推荐|持有|强买|回避)/
      );
      if (ratingMatch) {
        const v = RATING_VALUE_MAP[ratingMatch[1]];
        if (v != null) result.recommendationMean = v;
      }
    }

    // 分析师数：正则匹配 "X家机构" "X位分析师"
    if (result.numberOfAnalysts == null) {
      const naMatch = html.match(/(\d+)\s*(?:家机构|位分析师|个机构)/);
      if (naMatch) {
        const n = parseInt(naMatch[1], 10);
        if (!isNaN(n) && n > 0) result.numberOfAnalysts = n;
      }
    }

    // 至少有 1 个有效字段才认为成功
    const hasData = Object.values(result).some(
      (v) => v != null && v !== ""
    );
    return hasData ? result : null;
  } catch {
    return null;
  }
}



/**
 * 从东方财富研报接口获取分析师共识（目标价 + 评级）。
 *
 * 接口：https://reportapi.eastmoney.com/report/list
 *   qType=0 个股研报，返回近期机构研究报告列表。
 *
 * 聚合规则：
 *   - 取最近 50 条研报（约近 1 年）
 *   - 目标价：从含 indvAimPriceT 的研报中取均值/最高/最低
 *   - 评级：取最近 10 条评级映射为 1-5 数值求均值
 *   - 分析师数：按研究机构去重统计
 */
async function fetchEastmoneyAnalystConsensus(
  ticker: string
): Promise<AnalystConsensus | null> {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return null;
  const [, code] = m;

  // 取近 2 年研报，pageSize=50 覆盖足够样本
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const begin = `${now.getFullYear() - 2}-01-01`;

  try {
    const res = await fetch(
      `https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=50&pageNo=1&code=${code}&beginTime=${begin}&endTime=${end}&qType=0`,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://data.eastmoney.com/",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as EMReportResp;
    const reports = json.data ?? [];
    if (reports.length === 0) return null;

    // 目标价聚合
    const targets: number[] = [];
    for (const r of reports) {
      const raw =
        r.indvAimPriceT ?? r.indvAimPriceL ?? null;
      if (raw == null || raw === "") continue;
      const n = typeof raw === "number" ? raw : parseFloat(raw);
      if (!isNaN(n) && n > 0) targets.push(n);
    }
    const targetMeanPrice =
      targets.length > 0
        ? targets.reduce((s, v) => s + v, 0) / targets.length
        : null;
    const targetHighPrice =
      targets.length > 0 ? Math.max(...targets) : null;
    const targetLowPrice =
      targets.length > 0 ? Math.min(...targets) : null;

    // 评级聚合：取最近 10 条评级
    const ratingValues: number[] = [];
    for (const r of reports.slice(0, 10)) {
      const name = r.emRatingName ?? r.sRatingName;
      if (!name) continue;
      const v = RATING_VALUE_MAP[name];
      if (v != null) ratingValues.push(v);
    }
    const recommendationMean =
      ratingValues.length > 0
        ? ratingValues.reduce((s, v) => s + v, 0) / ratingValues.length
        : null;

    // 分析师数：按机构去重
    const orgs = new Set<string>();
    for (const r of reports) {
      if (r.orgSName) orgs.add(r.orgSName);
    }
    const numberOfAnalysts = orgs.size > 0 ? orgs.size : null;

    return {
      targetMeanPrice,
      targetHighPrice,
      targetLowPrice,
      numberOfAnalysts,
      recommendationMean,
    };
  } catch {
    return null;
  }
}

/**
 * 从东方财富 F10 获取完整财务指标补充（含速动比率/营收增长/净利率/多期ROE）。
 *
 * 数据源：
 *   1. ZyzbAjaxNew — F10 主要指标，含速动比率(SD)/流动比率(LD)/净利率(XSJLL)/多期ROE
 *   2. RPT_LICO_FN_CPD — datacenter 财务摘要，含行业板块代码(BOARD_CODE)和营收增长(YSTZ)
 *   3. push2 clist — 用 BOARD_CODE 取行业成分股 PE 平均值作为行业 PE
 *
 * 返回的百分比字段已 /100 转小数（与 FinancialMetrics 约定一致），
 * 但 netProfitGrowthPct 保留百分比原值供 PEG 计算（PEG = PE / 增长率%）。
 */
async function fetchEastmoneyFinanceSupplement(
  ticker: string
): Promise<FinanceSupplement | null> {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return null;
  const [, code, ex] = m;
  const f10Code = `${ex}${code}`; // SH600276
  const emCode = `${code}.${ex}`; // 600276.SH

  // 1. ZyzbAjaxNew：
  //    type=0 — 最新一期完整指标（速动比率/流动比率/净利率/营收增长/当前ROE）
  //    type=1 — 年报历史（用于近 5 年平均 ROE 和历史营收；type=1 仅返回年报）
  // 并行请求两个 type，各 8s 超时。
  let zyzbRows: EMZyzbRow[] = []; // type=0 最新一期
  let annualRows: EMZyzbRow[] = []; // type=1 年报历史
  const [zyzbRes, annualRes] = await Promise.allSettled([
    (async () => {
      const res = await fetch(
        `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZyzbAjaxNew?type=0&code=${f10Code}&pageNumber=1&pageSize=5`,
        {
          headers: {
            "User-Agent": UA,
            Referer: "https://emweb.securities.eastmoney.com/",
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) return null;
      return (await res.json()) as EMZyzbResp;
    })(),
    (async () => {
      const res = await fetch(
        `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZyzbAjaxNew?type=1&code=${f10Code}&pageNumber=1&pageSize=10`,
        {
          headers: {
            "User-Agent": UA,
            Referer: "https://emweb.securities.eastmoney.com/",
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) return null;
      return (await res.json()) as EMZyzbResp;
    })(),
  ]);
  if (zyzbRes.status === "fulfilled" && zyzbRes.value) {
    zyzbRows = zyzbRes.value.data ?? [];
  }
  if (annualRes.status === "fulfilled" && annualRes.value) {
    annualRows = annualRes.value.data ?? [];
  }

  // 2. RPT_LICO_FN_CPD 获取行业板块代码 + 营收增长（Zyzb 失败时降级）
  let cpd: EMCpdRow | null = null;
  try {
    const res = await fetch(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=1&sortColumns=REPORTDATE&sortTypes=-1`,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://data.eastmoney.com/",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (res.ok) {
      const json = (await res.json()) as EMCpdResp;
      cpd = json.result?.data?.[0] ?? null;
    }
  } catch {
    /* ignore */
  }

  if (zyzbRows.length === 0 && annualRows.length === 0 && !cpd) return null;

  const latest = zyzbRows[0] ?? annualRows[0] ?? null;

  // 营收同比增长：优先 Zyzb，降级 CPD
  // latest 来自 type=0 最新季报，TOTALOPERATEREVETZ 即最近报告期同比
  const revenueGrowthPct =
    latest?.TOTALOPERATEREVETZ ?? cpd?.YSTZ ?? null;
  const revenueGrowthYoY =
    revenueGrowthPct != null ? revenueGrowthPct / 100 : null;

  // 季度/TTM 营收增长：与 revenueGrowthYoY 同源（最近报告期同比），
  // 前端"TTM"标签使用此字段。A股年报累计值即全年，季报为累计值，
  // 该同比已反映最近 4 季度 vs 上年同期的增长，近似 TTM 口径。
  const quarterlyRevenueGrowth = revenueGrowthYoY;

  // 净利润同比增长（保留百分比原值用于 PEG 计算）
  const netProfitGrowthPct =
    latest?.PARENTNETPROFITTZ ?? cpd?.SJLTZ ?? null;

  // 当前 ROE（小数）
  const roePct = latest?.ROEJQ ?? cpd?.WEIGHTAVG_ROE ?? null;
  const roe = roePct != null ? roePct / 100 : null;

  // 近 5 年年报平均 ROE（annualRows 来自 type=1，全部为年报，按时间倒序）
  const annualRoes = annualRows
    .filter((r) => typeof r.ROEJQ === "number")
    .slice(0, 5);
  const returnOnEquity5yAvg =
    annualRoes.length > 0
      ? annualRoes.reduce((s, r) => s + (r.ROEJQ ?? 0), 0) /
        annualRoes.length /
        100
      : null;

  const roeHistory = annualRows
    .map((r) => ({
      year: r.REPORT_DATE ? new Date(r.REPORT_DATE).getFullYear() : 0,
      roe: r.ROEJQ != null ? r.ROEJQ / 100 : null,
    }))
    .filter((x) => x.year && x.roe != null)
    .reverse();

  // 毛利率/净利率
  const grossMarginPct = latest?.XSMLL ?? cpd?.XSMLL ?? null;
  const grossMargin = grossMarginPct != null ? grossMarginPct / 100 : null;
  const profitMargin =
    latest?.XSJLL != null ? latest.XSJLL / 100 : null;

  // 速动比率/流动比率（Zyzb 独有）
  const quickRatio = latest?.SD ?? null;
  const currentRatio = latest?.LD ?? null;

  // 营收总额
  const totalRevenue =
    latest?.TOTALOPERATEREVE ?? cpd?.TOTAL_OPERATE_INCOME ?? null;

  // 历史营收（annualRows 来自 type=1 年报）
  const revenueHistory = annualRows
    .map((r) => ({
      year: r.REPORT_DATE ? new Date(r.REPORT_DATE).getFullYear() : 0,
      revenue: r.TOTALOPERATEREVE ?? null,
    }))
    .filter((x) => x.year && x.revenue != null)
    .reverse();

  // 行业
  const industry = cpd?.BOARD_NAME ?? cpd?.PUBLISHNAME ?? null;

  // 行业 PE + 分析师共识并行请求
  let industryPE: number | null = null;
  const industryPePromise = (async (): Promise<number | null> => {
    if (!cpd?.BOARD_CODE) return null;
    try {
      const res = await fetch(
        `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fs=b:${cpd.BOARD_CODE}&fields=f12,f9`,
        {
          headers: {
            "User-Agent": UA,
            Referer: "https://quote.eastmoney.com/",
          },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: { diff?: Array<{ f9?: number }> };
      };
      const pes = (json.data?.diff ?? [])
        .map((x) => x.f9)
        .filter(
          (v): v is number => typeof v === "number" && v > 0 && v < 1000
        );
      return pes.length > 0
        ? pes.reduce((s, v) => s + v, 0) / pes.length
        : null;
    } catch {
      return null;
    }
  })();

  const [peResult, analyst] = await Promise.all([
    industryPePromise,
    fetchEastmoneyAnalystConsensus(ticker),
  ]);
  industryPE = peResult;

  return {
    revenueGrowthYoY,
    quarterlyRevenueGrowth,
    netProfitGrowthPct,
    roe,
    returnOnEquity5yAvg,
    roeHistory,
    grossMargin,
    profitMargin,
    quickRatio,
    currentRatio,
    totalRevenue,
    revenueHistory,
    industry,
    industryPE,
    targetMeanPrice: analyst?.targetMeanPrice ?? null,
    targetHighPrice: analyst?.targetHighPrice ?? null,
    targetLowPrice: analyst?.targetLowPrice ?? null,
    numberOfAnalysts: analyst?.numberOfAnalysts ?? null,
    recommendationMean: analyst?.recommendationMean ?? null,
  };
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
 * 获取 A 股财务数据：并行请求同花顺 + 腾讯 + 东方财富 F10 财务补充。
 *
 * 同花顺：行情 + 基本面（ROE/毛利率），数据较全但缺速动比率/营收增长/5年ROE/行业PE
 * 腾讯：行情（名称/价格/PE/PB/市值），全球可访问，最稳定
 * 东方财富 F10：完整财务指标（速动比率/营收增长/净利率/多期ROE/行业PE），用于补充缺失字段
 *
 * 策略：并行三个数据源，以同花顺（或腾讯）为行情基础，
 *       用东方财富 F10 补充缺失的财务指标，并计算 PEG = PE / 净利润增长率。
 *       同花顺+腾讯都失败时降级到东方财富完整数据源 / 雪球。
 */
export async function fetchCNFinancialMetrics(
  ticker: string
): Promise<FinancialMetrics> {
  // 并行请求：百度股市通（HTML解析，优先）、同花顺（行情+基本面）、腾讯（行情备份）、东方财富 F10 财务补充
  const [baiduResult, thsResult, tencentResult, emSuppResult] =
    await Promise.allSettled([
      fetchBaiduStockPageData(ticker),
      fetchTonghuashunMetrics(ticker),
      fetchTencentMetrics(ticker),
      fetchEastmoneyFinanceSupplement(ticker),
    ]);

  const baiduData =
    baiduResult.status === "fulfilled" ? baiduResult.value : null;
  const thsMetrics = thsResult.status === "fulfilled" ? thsResult.value : null;
  const tencentMetrics =
    tencentResult.status === "fulfilled" ? tencentResult.value : null;
  const emSupp =
    emSuppResult.status === "fulfilled" ? emSuppResult.value : null;

  // 确定行情基础数据源：优先同花顺，其次腾讯
  let base: FinancialMetrics | null = thsMetrics ?? tencentMetrics ?? null;
  const warnings: string[] = [];

  if (!thsMetrics && tencentMetrics) {
    warnings.push("同花顺数据获取失败，降级到腾讯财经");
  }

  // 同花顺+腾讯都失败，降级到东方财富完整数据源 / 雪球
  if (!base) {
    warnings.push("同花顺+腾讯均获取失败");
    try {
      const em = await fetchEastmoneyMetrics(ticker);
      if (em) {
        base = em;
      } else {
        warnings.push("东方财富完整数据源获取失败");
      }
    } catch (err) {
      warnings.push(
        `东方财富异常: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (!base) {
    try {
      const xq = await fetchXueqiuMetrics(ticker);
      if (xq) {
        base = xq;
      } else {
        warnings.push("雪球数据获取失败");
      }
    } catch (err) {
      warnings.push(
        `雪球异常: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 全部失败，返回空 fallback
  if (!base) {
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
      warnings: [
        "A 股数据源（同花顺/腾讯/雪球/东方财富）均获取失败",
        ...warnings,
      ],
    };
  }

  if (warnings.length > 0) {
    base.warnings = [...warnings, ...base.warnings];
  }

  // 合并百度股市通 HTML 解析数据（优先数据源，有值则填充）
  if (baiduData) {
    if (baiduData.name && !base.name) base.name = baiduData.name;
    if (baiduData.currentPrice != null && base.currentPrice == null)
      base.currentPrice = baiduData.currentPrice;
    if (baiduData.trailingPE != null && base.trailingPE == null)
      base.trailingPE = baiduData.trailingPE;
    if (baiduData.forwardPE != null && base.forwardPE == null)
      base.forwardPE = baiduData.forwardPE;
    // 注：FinancialMetrics 当前无 PB 字段，百度 PB 数据暂不合并
    // if (baiduData.priceToBook != null && base.xxx == null) base.xxx = baiduData.priceToBook;
    if (baiduData.marketCap != null && base.marketCap == null)
      base.marketCap = baiduData.marketCap;
    if (baiduData.roe != null && base.roe == null)
      base.roe = baiduData.roe / 100; // 百度百分比转小数
    if (baiduData.grossMargin != null && base.grossMargin == null)
      base.grossMargin = baiduData.grossMargin / 100;
    if (baiduData.profitMargin != null && base.profitMargin == null)
      base.profitMargin = baiduData.profitMargin / 100;
    if (baiduData.revenueGrowthYoY != null && base.revenueGrowthYoY == null)
      base.revenueGrowthYoY = baiduData.revenueGrowthYoY / 100;
    // 分析师共识
    if (baiduData.targetMeanPrice != null && base.targetMeanPrice == null)
      base.targetMeanPrice = baiduData.targetMeanPrice;
    if (baiduData.targetHighPrice != null && base.targetHighPrice == null)
      base.targetHighPrice = baiduData.targetHighPrice;
    if (baiduData.targetLowPrice != null && base.targetLowPrice == null)
      base.targetLowPrice = baiduData.targetLowPrice;
    if (baiduData.numberOfAnalysts != null && base.numberOfAnalysts == null)
      base.numberOfAnalysts = baiduData.numberOfAnalysts;
    if (
      baiduData.recommendationMean != null &&
      base.recommendationMean == null
    )
      base.recommendationMean = baiduData.recommendationMean;
    // 计算目标价上涨空间
    if (
      base.targetUpside == null &&
      base.targetMeanPrice != null &&
      base.currentPrice != null &&
      base.currentPrice > 0
    ) {
      base.targetUpside =
        (base.targetMeanPrice - base.currentPrice) / base.currentPrice;
    }
    if (base.dataSource === "fallback") base.dataSource = "tonghuashun";
  }

  // 合并东方财富 F10 财务补充（覆盖缺失的财务指标字段）
  if (emSupp) {
    // 东方财富财务指标更准确（加权ROE/毛利率/速动比率/多期ROE），有值则覆盖
    if (emSupp.revenueGrowthYoY != null)
      base.revenueGrowthYoY = emSupp.revenueGrowthYoY;
    if (emSupp.quarterlyRevenueGrowth != null)
      base.quarterlyRevenueGrowth = emSupp.quarterlyRevenueGrowth;
    if (emSupp.roe != null) base.roe = emSupp.roe;
    if (emSupp.returnOnEquity5yAvg != null)
      base.returnOnEquity5yAvg = emSupp.returnOnEquity5yAvg;
    if (emSupp.roeHistory.length > 0) base.roeHistory = emSupp.roeHistory;
    if (emSupp.grossMargin != null) base.grossMargin = emSupp.grossMargin;
    if (emSupp.profitMargin != null) base.profitMargin = emSupp.profitMargin;
    if (emSupp.quickRatio != null) base.quickRatio = emSupp.quickRatio;
    if (emSupp.currentRatio != null) base.currentRatio = emSupp.currentRatio;
    if (emSupp.totalRevenue != null) base.totalRevenue = emSupp.totalRevenue;
    if (emSupp.revenueHistory.length > 0)
      base.revenueHistory = emSupp.revenueHistory;
    if (emSupp.industry != null) base.industry = emSupp.industry;
    if (emSupp.industryPE != null) base.industryPE = emSupp.industryPE;
    // 分析师共识（A 股主数据源均不提供，来自东方财富研报接口）
    if (emSupp.targetMeanPrice != null)
      base.targetMeanPrice = emSupp.targetMeanPrice;
    if (emSupp.targetHighPrice != null)
      base.targetHighPrice = emSupp.targetHighPrice;
    if (emSupp.targetLowPrice != null)
      base.targetLowPrice = emSupp.targetLowPrice;
    if (emSupp.numberOfAnalysts != null)
      base.numberOfAnalysts = emSupp.numberOfAnalysts;
    if (emSupp.recommendationMean != null)
      base.recommendationMean = emSupp.recommendationMean;
    // 计算 PEG = PE / 净利润增长率（用百分比原值，如 PE=40 / 增长21.78% = 1.84）
    if (
      base.pegRatio == null &&
      base.trailingPE != null &&
      base.trailingPE > 0 &&
      emSupp.netProfitGrowthPct != null &&
      emSupp.netProfitGrowthPct > 0
    ) {
      base.pegRatio = base.trailingPE / emSupp.netProfitGrowthPct;
    }
    // 计算目标价上涨空间 = (目标均价 - 当前价) / 当前价
    if (
      base.targetUpside == null &&
      base.targetMeanPrice != null &&
      base.currentPrice != null &&
      base.currentPrice > 0
    ) {
      base.targetUpside =
        (base.targetMeanPrice - base.currentPrice) / base.currentPrice;
    }
  }

  return base;
}
