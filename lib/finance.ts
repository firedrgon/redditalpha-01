/**
 * 财务数据获取（多数据源自动降级）
 *
 * 数据获取优先级（从高到低）：
 *   1. Financial Modeling Prep (FMP) — 数据最完整，需 API Key
 *   2. Yahoo Finance quoteSummary（带 crumb 认证）
 *   3. Yahoo Finance v7/quote（字段较少，但通常不要 crumb）
 *   4. 全 null fallback
 *
 * 用于支持 5 项指标分析：
 *   1. 营收年增长 ≥ 10%
 *   2. PE 是否远高于行业平均值
 *   3. PEG ≤ 2
 *   4. 近 5 年平均 ROE > 15%
 *   5. 速动比率 > 1.5
 */

import { getFmpApiKey as getConfigFmpKey, getAvApiKey as getConfigAvKey } from "./finance-config";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface FinancialMetrics {
  ticker: string;
  name?: string | null;
  // 估值
  trailingPE: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  industry?: string | null;
  industryPE?: number | null; // 行业 PE（近似值）
  // 成长
  revenueGrowthYoY: number | null; // 营收同比增速（小数，0.15 = 15%）
  quarterlyRevenueGrowth: number | null;
  // 盈利能力
  roe: number | null; // 当前 ROE
  returnOnEquity5yAvg: number | null; // 近 5 年平均 ROE
  roeHistory: Array<{ year: number; roe: number | null }>;
  // 流动性
  quickRatio: number | null;
  currentRatio: number | null;
  // 利润率
  grossMargin: number | null;
  profitMargin: number | null;
  // 财报数据
  totalRevenue: number | null;
  revenueHistory: Array<{ year: number; revenue: number | null }>;
  marketCap?: number | null;
  currency?: string | null;
  fetchedAt: string;
  dataSource: "fmp" | "av" | "yahoo" | "yahoo-v7" | "fallback";
  warnings: string[];
}

interface QuoteSummary {
  quoteSummary?: {
    result?: Array<Record<string, unknown>>;
    error?: unknown;
  };
}

/** crumb + cookie 缓存（避免每次请求都重新获取） */
let cachedCrumb: { crumb: string; cookie: string; expires: number } | null = null;

/**
 * 获取 Yahoo Finance 的 crumb + cookie
 * 流程：先访问 finance.yahoo.com 拿到 cookie，再用 cookie 调 getcrumb
 */
async function getCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  // 缓存命中（5 分钟内）
  if (cachedCrumb && cachedCrumb.expires > Date.now()) {
    return { crumb: cachedCrumb.crumb, cookie: cachedCrumb.cookie };
  }

  try {
    // 第一步：访问首页拿 cookie
    const homeRes = await fetch("https://fc-api.yahoo.com/", {
      headers: { "User-Agent": UA },
      redirect: "manual",
    });
    const setCookie = homeRes.headers.get("set-cookie") || "";

    // 提取 A1/A3 session cookie
    const cookieParts: string[] = [];
    for (const c of setCookie.split(/,\s*(?=[A-Za-z])/)) {
      const m = c.match(/^([^=]+=[^;]+)/);
      if (m) cookieParts.push(m[1]);
    }
    const cookie = cookieParts.join("; ");

    if (!cookie) {
      return null;
    }

    // 第二步：用 cookie 获取 crumb
    const crumbRes = await fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: {
          "User-Agent": UA,
          Cookie: cookie,
        },
      }
    );
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length < 4) return null;

    cachedCrumb = {
      crumb,
      cookie,
      expires: Date.now() + 5 * 60 * 1000, // 5 分钟
    };
    return { crumb, cookie };
  } catch {
    return null;
  }
}

/**
 * 调用 quoteSummary（带 crumb 认证）
 */
async function fetchQuoteSummary(
  ticker: string,
  modules: string[]
): Promise<Record<string, unknown> | null> {
  const auth = await getCrumb();
  if (!auth) {
    // 无 crumb 时尝试直接调用（偶尔能成功）
    return await fetchQuoteSummaryNoAuth(ticker, modules);
  }

  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    ticker
  )}?modules=${modules.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: auth.cookie,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // 401 时清除 crumb 缓存重试一次
      if (res.status === 401) {
        cachedCrumb = null;
        return await fetchQuoteSummaryNoAuth(ticker, modules);
      }
      return null;
    }
    const data: QuoteSummary = await res.json();
    const result = data?.quoteSummary?.result?.[0];
    return result ?? null;
  } catch {
    return null;
  }
}

/** 无 crumb 的兜底调用 */
async function fetchQuoteSummaryNoAuth(
  ticker: string,
  modules: string[]
): Promise<Record<string, unknown> | null> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    ticker
  )}?modules=${modules.join(",")}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: QuoteSummary = await res.json();
    return data?.quoteSummary?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 兜底：调用 v7/finance/quote（字段较少，但通常不需要 crumb）
 * 返回的字段会被映射到 FinancialMetrics 上
 */
async function fetchV7Quote(
  ticker: string
): Promise<Record<string, unknown> | null> {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
    ticker
  )}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      quoteResponse?: { result?: Array<Record<string, unknown>> };
    };
    return data?.quoteResponse?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && v !== null && "raw" in v) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "raw" in v) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "string") return raw;
  }
  return null;
}

const FMP_BASE = "https://financialmodelingprep.com";
const AV_BASE = "https://www.alphavantage.co/query";

async function getFmpApiKey(): Promise<string | null> {
  try {
    const key = await getConfigFmpKey();
    if (key && key.trim()) return key.trim();
  } catch {
    // 配置读取失败时兜底读环境变量
  }
  const envKey = process.env.FMP_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  return null;
}

async function getAvApiKey(): Promise<string | null> {
  try {
    const key = await getConfigAvKey();
    if (key && key.trim()) return key.trim();
  } catch {
    // 配置读取失败时兜底读环境变量
  }
  const envKey = process.env.AV_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  return null;
}

interface FMPProfile {
  symbol: string;
  companyName?: string;
  industry?: string;
  sector?: string;
  marketCap?: number;
  currency?: string;
  price?: number;
}

interface FMPRatio {
  symbol: string;
  fiscalYear: string;
  date: string;
  priceToEarningsRatio?: number;
  priceToBookRatio?: number;
  priceToEarningsGrowthRatio?: number;
  returnOnEquity?: number;
  quickRatio?: number;
  currentRatio?: number;
  grossProfitMargin?: number;
  netProfitMargin?: number;
}

interface FMPIncomeStatement {
  date: string;
  fiscalYear: string;
  revenue: number;
  netIncome: number;
  grossProfit?: number;
}

interface FMPBalanceSheet {
  date: string;
  fiscalYear: string;
  totalStockholdersEquity: number;
}

async function fmpGet<T>(
  path: string,
  apiKey: string
): Promise<{ data: T | null; error?: string }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${FMP_BASE}${path}${sep}apikey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { data: null, error: `FMP ${path}: HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as T;
    if (data == null) return { data: null, error: `FMP ${path}: 返回空数据` };
    if (Array.isArray(data) && data.length === 0) {
      return { data: null, error: `FMP ${path}: 返回空数组` };
    }
    return { data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, error: `FMP ${path}: ${msg}` };
  }
}

interface AVOverview {
  Symbol: string;
  Name: string;
  Industry: string;
  Sector: string;
  MarketCapitalization: string;
  PERatio: string;
  ForwardPE: string;
  PEGRatio: string;
  PriceToBookRatio: string;
  ROE: string;
  RevenueGrowth: string;
  GrossProfitMargin: string;
  ProfitMargin: string;
  CurrentRatio: string;
  QuickRatio: string;
  TotalRevenue: string;
  EarningsGrowth: string;
  Currency: string;
}

interface AVIncomeStatement {
  date: string;
  revenue: string;
  grossProfit: string;
  operatingIncome: string;
  netIncome: string;
  eps: string;
}

interface AVBalanceSheet {
  date: string;
  totalStockholdersEquity: string;
  totalAssets: string;
  currentAssets: string;
  currentLiabilities: string;
}

async function avGet<T>(
  params: Record<string, string>,
  apiKey: string
): Promise<{ data: T | null; error?: string }> {
  const url = new URL(AV_BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("apikey", apiKey);
  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { data: null, error: `AV: HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as T;
    if (data == null) return { data: null, error: "AV: 返回空数据" };
    if (data instanceof Object && "Note" in data) {
      return { data: null, error: `AV: ${data["Note"]}` };
    }
    if (data instanceof Object && "Error Message" in data) {
      return { data: null, error: `AV: ${data["Error Message"]}` };
    }
    return { data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, error: `AV: ${msg}` };
  }
}

async function fetchAVMetrics(
  ticker: string,
  apiKey: string
): Promise<FinancialMetrics> {
  const upper = ticker.toUpperCase();
  const warnings: string[] = [];

  const [overviewRes, incomeRes, balanceRes] = await Promise.all([
    avGet<AVOverview>({ function: "OVERVIEW", symbol: upper }, apiKey),
    avGet<{ annualReports: AVIncomeStatement[] }>(
      { function: "INCOME_STATEMENT", symbol: upper },
      apiKey
    ),
    avGet<{ annualReports: AVBalanceSheet[] }>(
      { function: "BALANCE_SHEET", symbol: upper },
      apiKey
    ),
  ]);

  for (const res of [overviewRes, incomeRes, balanceRes]) {
    if (res.error) warnings.push(res.error);
  }

  const overview = overviewRes.data;
  const income = incomeRes.data?.annualReports ?? [];
  const balance = balanceRes.data?.annualReports ?? [];

  const result: FinancialMetrics = {
    ticker: upper,
    name: overview?.Name ?? null,
    trailingPE: num(overview?.PERatio) ?? null,
    forwardPE: num(overview?.ForwardPE) ?? null,
    pegRatio: num(overview?.PEGRatio) ?? null,
    industry: overview?.Industry ?? null,
    industryPE: null,
    revenueGrowthYoY: num(overview?.RevenueGrowth) ? num(overview?.RevenueGrowth)! / 100 : null,
    quarterlyRevenueGrowth: null,
    roe: num(overview?.ROE) ? num(overview?.ROE)! / 100 : null,
    returnOnEquity5yAvg: null,
    roeHistory: [],
    quickRatio: num(overview?.QuickRatio) ?? null,
    currentRatio: num(overview?.CurrentRatio) ?? null,
    grossMargin: num(overview?.GrossProfitMargin) ? num(overview?.GrossProfitMargin)! / 100 : null,
    profitMargin: num(overview?.ProfitMargin) ? num(overview?.ProfitMargin)! / 100 : null,
    totalRevenue: num(overview?.TotalRevenue) ?? null,
    revenueHistory: [],
    marketCap: num(overview?.MarketCapitalization) ?? null,
    currency: overview?.Currency ?? null,
    fetchedAt: new Date().toISOString(),
    dataSource: "av",
    warnings,
  };

  const revenueHistory: Array<{ year: number; revenue: number | null }> = [];
  for (const stmt of income) {
    const date = new Date(stmt.date);
    const year = date.getFullYear();
    if (Number.isFinite(year)) {
      revenueHistory.push({ year, revenue: num(stmt.revenue) });
    }
  }
  revenueHistory.sort((a, b) => a.year - b.year);
  result.revenueHistory = revenueHistory;

  const roeHistory: Array<{ year: number; roe: number | null }> = [];
  for (const bs of balance) {
    const date = new Date(bs.date);
    const year = date.getFullYear();
    if (!Number.isFinite(year)) continue;
    const inc = income.find((s) => {
      const sYear = new Date(s.date).getFullYear();
      return sYear === year;
    });
    const equity = num(bs.totalStockholdersEquity);
    const netIncome = inc ? num(inc.netIncome) : null;
    const roe = equity != null && netIncome != null && equity !== 0 ? netIncome / equity : null;
    roeHistory.push({ year, roe });
  }
  roeHistory.sort((a, b) => a.year - b.year);
  result.roeHistory = roeHistory;

  if (result.roe == null && roeHistory.length > 0) {
    result.roe = roeHistory[roeHistory.length - 1]?.roe ?? null;
  }

  const validRoes = roeHistory
    .map((r) => r.roe)
    .filter((r): r is number => r != null && Number.isFinite(r));
  if (validRoes.length >= 5) {
    const last5 = validRoes.slice(-5);
    result.returnOnEquity5yAvg = last5.reduce((a, b) => a + b, 0) / last5.length;
  } else if (validRoes.length > 0) {
    result.returnOnEquity5yAvg = validRoes.reduce((a, b) => a + b, 0) / validRoes.length;
    warnings.push(`仅获得 ${validRoes.length} 年 ROE 数据，平均值仅供参考。`);
  } else {
    result.returnOnEquity5yAvg = result.roe;
    if (result.roe == null) {
      warnings.push("无法获取 ROE 数据（当前与历史均无）。");
    } else {
      warnings.push("无法获取历史 ROE，使用当前 ROE 作为近似。");
    }
  }

  if (result.revenueGrowthYoY == null && revenueHistory.length >= 2) {
    const latest = revenueHistory[revenueHistory.length - 1];
    const prev = revenueHistory[revenueHistory.length - 2];
    if (latest.revenue && prev.revenue && prev.revenue > 0) {
      result.revenueGrowthYoY = latest.revenue / prev.revenue - 1;
      warnings.push("revenueGrowthYoY 由历史营收估算。");
    }
  }

  return result;
}

/**
 * 用 FMP 拉取财务数据
 * 需要 4 个端点：profile / ratios / income / balance-sheet
 */
async function fetchFMPMetrics(
  ticker: string,
  apiKey: string
): Promise<FinancialMetrics> {
  const upper = ticker.toUpperCase();
  const warnings: string[] = [];

  const [profileRes, ratiosRes, incomeRes, balanceRes] = await Promise.all([
    fmpGet<FMPProfile[]>(`/stable/profile?symbol=${upper}`, apiKey),
    fmpGet<FMPRatio[]>(`/stable/ratios?symbol=${upper}&period=annual&limit=5`, apiKey),
    fmpGet<FMPIncomeStatement[]>(
      `/stable/income-statement?symbol=${upper}&period=annual&limit=5`,
      apiKey
    ),
    fmpGet<FMPBalanceSheet[]>(
      `/stable/balance-sheet-statement?symbol=${upper}&period=annual&limit=5`,
      apiKey
    ),
  ]);

  // 收集所有错误
  for (const res of [profileRes, ratiosRes, incomeRes, balanceRes]) {
    if (res.error) warnings.push(res.error);
  }

  const profile = profileRes.data?.[0];
  const ratios = ratiosRes.data ?? [];
  const income = incomeRes.data ?? [];
  const balance = balanceRes.data ?? [];

  const latestRatio = ratios[0];
  const latestIncome = income[0];

  // 如果所有端点都失败，返回空数据（但 dataSource 仍是 fmp，warnings 包含错误）
  const result: FinancialMetrics = {
    ticker: upper,
    name: profile?.companyName ?? null,
    trailingPE: num(latestRatio?.priceToEarningsRatio) ?? null,
    forwardPE: null,
    pegRatio: num(latestRatio?.priceToEarningsGrowthRatio) ?? null,
    industry: profile?.industry ?? null,
    industryPE: null,
    revenueGrowthYoY: null,
    quarterlyRevenueGrowth: null,
    roe: num(latestRatio?.returnOnEquity) ?? null,
    returnOnEquity5yAvg: null,
    roeHistory: [],
    quickRatio: num(latestRatio?.quickRatio) ?? null,
    currentRatio: num(latestRatio?.currentRatio) ?? null,
    grossMargin: num(latestRatio?.grossProfitMargin) ?? null,
    profitMargin: num(latestRatio?.netProfitMargin) ?? null,
    totalRevenue: num(latestIncome?.revenue) ?? null,
    revenueHistory: [],
    marketCap: num(profile?.marketCap) ?? null,
    currency: profile?.currency ?? null,
    fetchedAt: new Date().toISOString(),
    dataSource: "fmp",
    warnings,
  };

  // 历史营收
  const revenueHistory: Array<{ year: number; revenue: number | null }> = [];
  for (const stmt of income) {
    const year = parseInt(stmt.fiscalYear, 10);
    if (Number.isFinite(year)) {
      revenueHistory.push({ year, revenue: num(stmt.revenue) });
    }
  }
  revenueHistory.sort((a, b) => a.year - b.year);
  result.revenueHistory = revenueHistory;

  // 历史 ROE：先用 ratios 里的 returnOnEquity（如果有的话）
  const roeHistory: Array<{ year: number; roe: number | null }> = [];
  for (const r of ratios) {
    const year = parseInt(r.fiscalYear, 10);
    const roe = num(r.returnOnEquity);
    if (Number.isFinite(year)) {
      roeHistory.push({ year, roe });
    }
  }
  // 如果 ratios 里没有有效的 ROE 数据，用 balance + income 算
  const hasValidRoe = roeHistory.some((r) => r.roe != null);
  if (!hasValidRoe) {
    roeHistory.length = 0;
    for (const bs of balance) {
      const year = parseInt(bs.fiscalYear, 10);
      if (!Number.isFinite(year)) continue;
      const inc = income.find(
        (s) => parseInt(s.fiscalYear, 10) === year
      );
      const equity = num(bs.totalStockholdersEquity);
      const netIncome = inc ? num(inc.netIncome) : null;
      const roe =
        equity != null && netIncome != null && equity !== 0
          ? netIncome / equity
          : null;
      roeHistory.push({ year, roe });
    }
  }
  roeHistory.sort((a, b) => a.year - b.year);
  result.roeHistory = roeHistory;

  const validRoes = roeHistory
    .map((r) => r.roe)
    .filter((r): r is number => r != null && Number.isFinite(r));
  if (validRoes.length >= 5) {
    const last5 = validRoes.slice(-5);
    result.returnOnEquity5yAvg =
      last5.reduce((a, b) => a + b, 0) / last5.length;
  } else if (validRoes.length > 0) {
    result.returnOnEquity5yAvg =
      validRoes.reduce((a, b) => a + b, 0) / validRoes.length;
    warnings.push(
      `仅获得 ${validRoes.length} 年 ROE 数据，平均值仅供参考。`
    );
  } else {
    result.returnOnEquity5yAvg = result.roe;
    if (result.roe == null) {
      warnings.push("无法获取 ROE 数据（当前与历史均无）。");
    } else {
      warnings.push("无法获取历史 ROE，使用当前 ROE 作为近似。");
    }
  }

  // 若 revenueGrowthYoY 缺失，用历史营收算
  if (result.revenueGrowthYoY == null && revenueHistory.length >= 2) {
    const latest = revenueHistory[revenueHistory.length - 1];
    const prev = revenueHistory[revenueHistory.length - 2];
    if (latest.revenue && prev.revenue && prev.revenue > 0) {
      result.revenueGrowthYoY = latest.revenue / prev.revenue - 1;
      warnings.push("revenueGrowthYoY 由历史营收估算。");
    }
  }

  // 行业 PE 近似（用 sector 经验值）
  const sector = profile?.sector;
  if (sector && SECTOR_DEFAULT_PE[sector]) {
    result.industryPE = SECTOR_DEFAULT_PE[sector];
    warnings.push(
      `行业 PE 用 ${sector} 行业经验值 ${result.industryPE}（仅供参考）。`
    );
  } else {
    warnings.push("未获取到行业 PE 数据，peVsIndustry 指标将无法判定。");
  }

  return result;
}

/** 行业 PE 近似值（按 sector 给出经验值，仅作参考） */
const SECTOR_DEFAULT_PE: Record<string, number> = {
  Technology: 28,
  "Communication Services": 22,
  "Consumer Cyclical": 22,
  "Consumer Defensive": 20,
  Healthcare: 18,
  Financials: 12,
  Industrials: 18,
  Energy: 10,
  Utilities: 16,
  Materials: 14,
  "Real Estate": 25,
};

/**
 * 拉取并计算 5 项指标所需的数据
 * 数据源优先级：FMP → Yahoo quoteSummary → Yahoo v7 → fallback
 */
export async function fetchFinancialMetrics(
  ticker: string
): Promise<FinancialMetrics> {
  const upper = ticker.trim().toUpperCase();
  const warnings: string[] = [];

  // 1. 优先尝试 FMP（如果配置了 API Key）
  const fmpKey = await getFmpApiKey();
  if (fmpKey) {
    const fmp = await fetchFMPMetrics(upper, fmpKey);
    // 如果 FMP 返回了财务数据（PE、营收、ROE 至少有一个），才使用它
    const hasFinancialData = fmp.trailingPE || fmp.totalRevenue || fmp.roe;
    if (hasFinancialData) {
      return fmp;
    }
    // 如果 FMP 返回了 warnings，把它们加到全局 warnings 里
    if (fmp.warnings.length > 0) {
      warnings.push(...fmp.warnings);
    }
    warnings.push("FMP 未返回财务数据（可能是 Premium 股票），降级到 Alpha Vantage。");
  }

  // 2. Alpha Vantage（如果配置了 API Key）
  const avKey = await getAvApiKey();
  if (avKey) {
    const av = await fetchAVMetrics(upper, avKey);
    const hasFinancialData = av.trailingPE || av.totalRevenue || av.roe;
    if (hasFinancialData) {
      return av;
    }
    if (av.warnings.length > 0) {
      warnings.push(...av.warnings);
    }
    warnings.push("Alpha Vantage 未返回财务数据，降级到 Yahoo Finance。");
  }

  // 3. Yahoo Finance quoteSummary（带 crumb 认证）
  const summary = await fetchQuoteSummary(upper, [
    "summaryDetail",
    "summaryProfile",
    "defaultKeyStatistics",
    "financialData",
    "incomeStatementHistory",
    "balanceSheetHistory",
    "financialsTemplate",
  ]);

  // 基础回退对象
  const fallback: FinancialMetrics = {
    ticker: upper,
    trailingPE: null,
    forwardPE: null,
    pegRatio: null,
    industry: null,
    industryPE: null,
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
    fetchedAt: new Date().toISOString(),
    dataSource: "fallback",
    warnings,
  };

  if (!summary) {
    warnings.push(
      "Yahoo Finance quoteSummary 接口不可用（可能需要 crumb 认证或被限流）。"
    );
    // 3. 兜底：尝试 v7/quote
    const v7 = await fetchV7Quote(upper);
    if (v7) {
      fallback.dataSource = "yahoo-v7";
      fallback.trailingPE = num(v7.trailingPE);
      fallback.forwardPE = num(v7.forwardPE);
      fallback.pegRatio = num(v7.pegRatio);
      fallback.revenueGrowthYoY = num(v7.earningsGrowth);
      fallback.roe = num(v7.returnOnEquity);
      fallback.quickRatio = num(v7.quickRatio);
      fallback.currentRatio = num(v7.currentRatio);
      fallback.grossMargin = num(v7.grossMargins);
      fallback.profitMargin = num(v7.profitMargins);
      fallback.totalRevenue = num(v7.totalRevenue);
      fallback.industry = str(v7.industry);
      fallback.name = str(v7.longName) ?? str(v7.shortName);
      fallback.currency = str(v7.currency);
      fallback.marketCap = num(v7.marketCap);
      warnings.push("部分数据来自 v7/quote 端点，可能不完整。");

      // 行业 PE 近似
      const sector = str(v7.sector);
      if (sector && SECTOR_DEFAULT_PE[sector]) {
        fallback.industryPE = SECTOR_DEFAULT_PE[sector];
        warnings.push(`行业 PE 用 ${sector} 行业近似值 ${fallback.industryPE}。`);
      }
    } else {
      warnings.push("v7/quote 端点也不可用，未能获取任何财务数据。");
    }
    return fallback;
  }

  fallback.dataSource = "yahoo";
  const summaryDetail = (summary.summaryDetail ?? {}) as Record<string, unknown>;
  const summaryProfile = (summary.summaryProfile ?? {}) as Record<string, unknown>;
  const defaultKeyStats = (summary.defaultKeyStatistics ?? {}) as Record<string, unknown>;
  const financialData = (summary.financialData ?? {}) as Record<string, unknown>;
  const incomeHistory = (
    summary.incomeStatementHistory ??
    ({} as Record<string, unknown>)
  ) as { incomeStatementHistory?: Array<Record<string, unknown>> };
  const balanceHistory = (
    summary.balanceSheetHistory ??
    ({} as Record<string, unknown>)
  ) as { balanceSheetStatements?: Array<Record<string, unknown>> };

  // 用 profile 的 industry / sector
  fallback.industry = str(summaryProfile.industry) ?? null;
  const sector = str(summaryProfile.sector);

  // 估值
  fallback.trailingPE = num(summaryDetail.trailingPE);
  fallback.forwardPE = num(summaryDetail.forwardPE);
  fallback.pegRatio = num(defaultKeyStats.pegRatio) ?? num(summaryDetail.pegRatio);

  // 成长
  fallback.revenueGrowthYoY = num(financialData.revenueGrowth);
  fallback.quarterlyRevenueGrowth = num(financialData.earningsGrowth);

  // 流动性
  fallback.quickRatio = num(financialData.quickRatio);
  fallback.currentRatio = num(financialData.currentRatio);

  // 利润率
  fallback.grossMargin = num(financialData.grossMargins);
  fallback.profitMargin = num(financialData.profitMargins);

  // 当前 ROE
  fallback.roe = num(financialData.returnOnEquity);

  // 总营收
  fallback.totalRevenue = num(financialData.totalRevenue);

  // 历史营收（用于计算年增长）
  const incomeStatements = incomeHistory.incomeStatementHistory ?? [];
  const revenueHistory: Array<{ year: number; revenue: number | null }> = [];
  for (const stmt of incomeStatements) {
    const endDate = (stmt.endDate as { fmt?: string })?.fmt;
    const totalRev = num(stmt.totalRevenue);
    const year = endDate ? parseInt(endDate.slice(0, 4), 10) : NaN;
    if (Number.isFinite(year)) {
      revenueHistory.push({ year, revenue: totalRev });
    }
  }
  revenueHistory.sort((a, b) => a.year - b.year);
  fallback.revenueHistory = revenueHistory;

  // 若没有 revenueGrowthYoY，用历史营收算
  if (fallback.revenueGrowthYoY == null && revenueHistory.length >= 2) {
    const latest = revenueHistory[revenueHistory.length - 1];
    const prev = revenueHistory[revenueHistory.length - 2];
    if (latest.revenue && prev.revenue && prev.revenue > 0) {
      fallback.revenueGrowthYoY = latest.revenue / prev.revenue - 1;
      warnings.push("revenueGrowthYoY 由历史营收估算。");
    }
  }

  // 历史 ROE：用 balanceSheet + incomeStatement 近似
  const balanceStatements = balanceHistory.balanceSheetStatements ?? [];
  const roeHistory: Array<{ year: number; roe: number | null }> = [];
  for (let i = 0; i < balanceStatements.length; i++) {
    const stmt = balanceStatements[i];
    const equity = num(stmt.totalStockholderEquity);
    const endDate = (stmt.endDate as { fmt?: string })?.fmt;
    const year = endDate ? parseInt(endDate.slice(0, 4), 10) : NaN;
    const incStmt = incomeStatements.find((s) => {
      const ed = (s.endDate as { fmt?: string })?.fmt;
      const y = ed ? parseInt(ed.slice(0, 4), 10) : NaN;
      return y === year;
    });
    const netIncome = incStmt ? num(incStmt.netIncome) : null;
    const roe =
      equity != null && netIncome != null && equity !== 0
        ? netIncome / equity
        : null;
    if (Number.isFinite(year)) {
      roeHistory.push({ year, roe });
    }
  }
  roeHistory.sort((a, b) => a.year - b.year);
  fallback.roeHistory = roeHistory;

  const validRoes = roeHistory
    .map((r) => r.roe)
    .filter((r): r is number => r != null && Number.isFinite(r));
  if (validRoes.length >= 5) {
    const last5 = validRoes.slice(-5);
    fallback.returnOnEquity5yAvg =
      last5.reduce((a, b) => a + b, 0) / last5.length;
  } else if (validRoes.length > 0) {
    fallback.returnOnEquity5yAvg =
      validRoes.reduce((a, b) => a + b, 0) / validRoes.length;
    warnings.push(
      `仅获得 ${validRoes.length} 年 ROE 数据，平均值仅供参考。`
    );
  } else {
    // 退化用当前 ROE
    fallback.returnOnEquity5yAvg = fallback.roe;
    if (fallback.roe == null) {
      warnings.push("无法获取 ROE 数据（当前与历史均无）。");
    } else {
      warnings.push("无法获取历史 ROE，使用当前 ROE 作为近似。");
    }
  }

  // 行业 PE：Yahoo 不直接提供行业平均 PE
  // 退而求其次：用 sector 经验值
  if (sector && SECTOR_DEFAULT_PE[sector]) {
    fallback.industryPE = SECTOR_DEFAULT_PE[sector];
    warnings.push(
      `行业 PE 用 ${sector} 行业经验值 ${fallback.industryPE}（仅供参考）。`
    );
  } else {
    fallback.industryPE = null;
    warnings.push("未获取到行业 PE 数据，peVsIndustry 指标将无法判定。");
  }

  if (fallback.trailingPE == null) {
    warnings.push("未获取到 trailing PE 数据。");
  }
  if (fallback.pegRatio == null) {
    warnings.push("未获取到 PEG 数据。");
  }
  if (fallback.quickRatio == null) {
    warnings.push("未获取到速动比率数据。");
  }
  if (fallback.revenueGrowthYoY == null) {
    warnings.push("未获取到营收增速数据。");
  }

  return fallback;
}
