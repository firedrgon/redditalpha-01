/**
 * 财务数据获取（多数据源自动降级）
 *
 * 数据获取优先级（从高到低）：
 *   1. Tiingo — EOD 价格 + 基本面，免费 tier 500 req/day（首选）
 *   2. Finnhub — 分析师目标价、财务数据和新闻，免费 tier 60 req/min
 *   3. Financial Modeling Prep (FMP) — 数据最完整，需 API Key
 *   4. Alpha Vantage — 补充，免费 tier 25 req/day
 *   5. Yahoo Finance quoteSummary（带 crumb 认证）
 *   6. Yahoo Finance v7/quote（字段较少，但通常不要 crumb）
 *   7. 全 null fallback
 *
 * 用于支持 5 项指标分析：
 *   1. 营收年增长 ≥ 10%
 *   2. PE 是否远高于行业平均值
 *   3. PEG ≤ 2
 *   4. 近 5 年平均 ROE > 15%
 *   5. 速动比率 > 1.5
 */

import {
  getFmpApiKey as getConfigFmpKey,
  getAvApiKey as getConfigAvKey,
  getTiingoApiKey as getConfigTiingoKey,
  getFinnhubApiKey as getConfigFinnhubKey,
} from "./finance-config";

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
  // 当前价格
  currentPrice?: number | null;
  // 分析师目标价与评级
  targetMeanPrice: number | null; // 分析师目标价均值
  targetHighPrice: number | null; // 分析师目标价高位
  targetLowPrice: number | null; // 分析师目标价低位
  targetMedianPrice: number | null; // 分析师目标价中位数
  numberOfAnalysts: number | null; // 覆盖分析师数量
  recommendationMean: number | null; // 推荐均值 (1=强力买入, 2=买入, 3=持有, 4=卖出, 5=强力卖出)
  targetUpside: number | null; // 目标价上涨空间 = (targetMeanPrice / currentPrice - 1)
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
  // 新闻
  news?: Array<{
    title: string;
    source?: string;
    date?: string;
    summary?: string;
    url?: string;
  }>;
  // 情绪面数据
  sentiment?: {
    marketFearGreed?: { value: number; classification: string } | null;
    analystRating?: {
      consensus: string;
      strongBuy: number;
      buy: number;
      hold: number;
      sell: number;
      strongSell: number;
      total: number;
      score: number;
    } | null;
    redditMentions?: Array<{
      title: string;
      subreddit: string;
      score: number;
      url?: string;
      createdUtc?: number;
    }> | null;
  };
  fetchedAt: string;
  dataSource:
    | "fmp"
    | "finnhub"
    | "tiingo"
    | "av"
    | "fmp+av"
    | "fmp+finnhub"
    | "fmp+tiingo"
    | "finnhub+tiingo"
    | "av+tiingo"
    | "yahoo"
    | "yahoo-v7"
    | "fallback";
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
  if (typeof v === "string") {
    if (v === "" || v === "None" || v === "none" || v === "null" || v === "undefined" || v === "-") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
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
 * 细分行业 → 广义 Sector 映射
 * 用于当数据源只返回细分行业（如 Finnhub 的 finnhubIndustry）时，
 * 能够匹配到 SECTOR_DEFAULT_PE 中对应的行业 PE 经验值。
 */
const INDUSTRY_TO_SECTOR: Record<string, string> = {
  // Technology
  "Software": "Technology",
  "Software - Application": "Technology",
  "Software - Infrastructure": "Technology",
  "Software - SaaS": "Technology",
  "Semiconductors": "Technology",
  "Semiconductor": "Technology",
  "Semiconductor Equipment & Materials": "Technology",
  "Computer Hardware": "Technology",
  "Hardware": "Technology",
  "Electronics": "Technology",
  "Electronic Components": "Technology",
  "Consumer Electronics": "Technology",
  "IT Services": "Technology",
  "Information Technology Services": "Technology",
  "Internet Software & Services": "Technology",
  "Internet Content & Information": "Technology",
  "Internet Services": "Technology",
  "Cloud Computing": "Technology",
  "AI": "Technology",
  "Artificial Intelligence": "Technology",

  // Communication Services
  "Media": "Communication Services",
  "Entertainment": "Communication Services",
  "Broadcasting": "Communication Services",
  "Telecommunication Services": "Communication Services",
  "Telecommunications": "Communication Services",
  "Wireless Telecommunications": "Communication Services",
  "Movies & Entertainment": "Communication Services",
  "Gaming": "Communication Services",
  "Video Games": "Communication Services",
  "Interactive Media": "Communication Services",
  "Interactive Home Entertainment": "Communication Services",
  "Publishing": "Communication Services",

  // Consumer Cyclical
  "Retail": "Consumer Cyclical",
  "Specialty Retail": "Consumer Cyclical",
  "Department Stores": "Consumer Cyclical",
  "Internet Retail": "Consumer Cyclical",
  "E-Commerce": "Consumer Cyclical",
  "Automobiles": "Consumer Cyclical",
  "Auto & Truck Dealerships": "Consumer Cyclical",
  "Auto Manufacturers": "Consumer Cyclical",
  "Auto Parts": "Consumer Cyclical",
  "Restaurants": "Consumer Cyclical",
  "Restaurants & Cafes": "Consumer Cyclical",
  "Travel Services": "Consumer Cyclical",
  "Leisure": "Consumer Cyclical",
  "Lodging": "Consumer Cyclical",
  "Hotels & Resorts": "Consumer Cyclical",
  "Casinos & Gambling": "Consumer Cyclical",
  "Textile Manufacturing": "Consumer Cyclical",
  "Apparel Retail": "Consumer Cyclical",
  "Apparel Manufacturing": "Consumer Cyclical",
  "Footwear & Accessories": "Consumer Cyclical",
  "Furnishings, Fixtures & Appliances": "Consumer Cyclical",
  "Home Improvement Retail": "Consumer Cyclical",

  // Consumer Defensive
  "Packaged Foods": "Consumer Defensive",
  "Food Products": "Consumer Defensive",
  "Beverages": "Consumer Defensive",
  "Beverages - Non-Alcoholic": "Consumer Defensive",
  "Beverages - Alcoholic": "Consumer Defensive",
  "Household & Personal Products": "Consumer Defensive",
  "Tobacco": "Consumer Defensive",
  "Grocery Stores": "Consumer Defensive",
  "Discount Stores": "Consumer Defensive",
  "Farm Products": "Consumer Defensive",
  "Drug Manufacturers": "Healthcare",

  // Healthcare
  "Drug Manufacturers - General": "Healthcare",
  "Drug Manufacturers - Specialty & Generic": "Healthcare",
  "Pharmaceuticals": "Healthcare",
  "Biotechnology": "Healthcare",
  "Biotech": "Healthcare",
  "Medical Devices": "Healthcare",
  "Medical Instruments & Supplies": "Healthcare",
  "Medical Diagnostics & Research": "Healthcare",
  "Healthcare Plans": "Healthcare",
  "Health Information Services": "Healthcare",
  "Medical Distribution": "Healthcare",

  // Financials
  "Banks": "Financials",
  "Banks - National": "Financials",
  "Banks - Regional": "Financials",
  "Credit Services": "Financials",
  "Insurance": "Financials",
  "Insurance - Property & Casualty": "Financials",
  "Insurance - Life": "Financials",
  "Asset Management": "Financials",
  "Capital Markets": "Financials",
  "Investment Banking & Brokerage": "Financials",
  "Mortgage Finance": "Financials",
  "Fintech": "Financials",
  "Financial Data & Stock Exchanges": "Financials",

  // Industrials
  "Aerospace & Defense": "Industrials",
  "Airports & Air Services": "Industrials",
  "Airlines": "Industrials",
  "Railroads": "Industrials",
  "Trucking": "Industrials",
  "Marine Shipping": "Industrials",
  "Integrated Freight & Logistics": "Industrials",
  "Specialty Industrial Machinery": "Industrials",
  "Industrial Products": "Industrials",
  "Industrial Distribution": "Industrials",
  "Conglomerates": "Industrials",
  "Consulting Services": "Industrials",
  "Rental & Leasing Services": "Industrials",
  "Security & Protection Services": "Industrials",

  // Energy
  "Oil & Gas": "Energy",
  "Oil & Gas Midstream": "Energy",
  "Oil & Gas Upstream": "Energy",
  "Oil & Gas Downstream": "Energy",
  "Oil & Gas Integrated": "Energy",
  "Oil & Gas Equipment & Services": "Energy",
  "Oil & Gas E&P": "Energy",
  "Thermal Coal": "Energy",
  "Uranium": "Energy",

  // Utilities
  "Utilities - Independent Power Producers": "Utilities",
  "Utilities - Regulated Electric": "Utilities",
  "Utilities - Regulated Water": "Utilities",
  "Utilities - Regulated Gas": "Utilities",
  "Utilities - Diversified": "Utilities",
  "Renewable Energy": "Utilities",

  // Materials
  "Chemicals": "Materials",
  "Specialty Chemicals": "Materials",
  "Basic Materials": "Materials",
  "Metals & Mining": "Materials",
  "Gold": "Materials",
  "Silver": "Materials",
  "Copper": "Materials",
  "Steel": "Materials",
  "Aluminum": "Materials",
  "Building Materials": "Materials",
  "Paper & Paper Products": "Materials",
  "Agricultural Inputs": "Materials",

  // Real Estate
  "REIT": "Real Estate",
  "REITs": "Real Estate",
  "Real Estate - Rental": "Real Estate",
  "Real Estate Services": "Real Estate",
  "Real Estate Development": "Real Estate",
  "Real Estate - Diversified": "Real Estate",
  "Industrial REITs": "Real Estate",
  "Residential REITs": "Real Estate",
  "Retail REITs": "Real Estate",
  "Office REITs": "Real Estate",
  "Hotel REITs": "Real Estate",
};

/**
 * 根据行业名（可能是细分行业，也可能是 broad sector）获取对应的行业 PE 经验值。
 * 先精确匹配 SECTOR_DEFAULT_PE，再通过 INDUSTRY_TO_SECTOR 映射找 broad sector。
 */
function getSectorPE(industry: string | null | undefined): number | null {
  if (!industry) return null;
  // 直接匹配 broad sector
  if (SECTOR_DEFAULT_PE[industry] != null) return SECTOR_DEFAULT_PE[industry];
  // 映射到 broad sector 后再匹配
  const sector = INDUSTRY_TO_SECTOR[industry];
  if (sector && SECTOR_DEFAULT_PE[sector] != null) return SECTOR_DEFAULT_PE[sector];
  return null;
}

/**
 * stockanalysis.com sector 名称 → URL slug 映射
 * 用于爬取实时加权平均 PE
 */
const SECTOR_TO_SA_SLUG: Record<string, string> = {
  Technology: "technology",
  Healthcare: "healthcare",
  Financials: "financials",
  Energy: "energy",
  "Consumer Cyclical": "consumer-discretionary",
  "Consumer Defensive": "consumer-staples",
  Industrials: "industrials",
  Utilities: "utilities",
  Materials: "materials",
  "Real Estate": "real-estate",
  "Communication Services": "communication-services",
};

/** sector PE 缓存（1 小时有效，避免频繁爬取） */
let sectorPECache: { sector: string; pe: number; expires: number } | null = null;

/**
 * 从 stockanalysis.com 爬取 sector 加权平均 PE（实时数据，无需 API Key）
 * 页面包含 "weighted average PE ratio of XX.XX"
 * 缓存 1 小时避免频繁请求
 */
async function fetchSectorPEFromSA(sector: string): Promise<number | null> {
  if (!sector) return null;
  // 缓存命中
  if (sectorPECache && sectorPECache.sector === sector && sectorPECache.expires > Date.now()) {
    return sectorPECache.pe;
  }

  const slug = SECTOR_TO_SA_SLUG[sector];
  if (!slug) return null;

  const url = `https://stockanalysis.com/stocks/sector/${slug}/`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // 提取 "weighted average PE ratio of 46.20"
    const peMatch = html.match(/weighted average PE ratio of ([\d.]+)/);
    if (peMatch) {
      const pe = parseFloat(peMatch[1]);
      if (Number.isFinite(pe) && pe > 0) {
        sectorPECache = { sector, pe, expires: Date.now() + 60 * 60 * 1000 };
        return pe;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 获取行业 PE：优先爬取 stockanalysis.com 实时加权平均 PE，
 * 失败则降级到 SECTOR_DEFAULT_PE 硬编码经验值。
 */
async function getSectorPEResolved(industry: string | null | undefined): Promise<number | null> {
  if (!industry) return null;
  // 映射到 broad sector
  const sector = SECTOR_DEFAULT_PE[industry] != null ? industry : (INDUSTRY_TO_SECTOR[industry] ?? null);
  if (!sector) return null;
  // 优先爬取实时数据
  const saPE = await fetchSectorPEFromSA(sector);
  if (saPE != null) return saPE;
  // 降级到经验值
  return SECTOR_DEFAULT_PE[sector] ?? null;
}

/**
 * 根据行业名获取对应的 broad sector 名（用于显示）。
 */
function getBroadSector(industry: string | null | undefined): string | null {
  if (!industry) return null;
  if (SECTOR_DEFAULT_PE[industry] != null) return industry;
  return INDUSTRY_TO_SECTOR[industry] ?? null;
}

const FMP_BASE = "https://financialmodelingprep.com";
const AV_BASE = "https://www.alphavantage.co/query";
const TIINGO_BASE = "https://api.tiingo.com";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

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

async function getTiingoApiKey(): Promise<string | null> {
  try {
    const key = await getConfigTiingoKey();
    if (key && key.trim()) return key.trim();
  } catch {
    // 配置读取失败时兜底读环境变量
  }
  const envKey = process.env.TIINGO_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  return null;
}

async function getFinnhubApiKey(): Promise<string | null> {
  try {
    const key = await getConfigFinnhubKey();
    if (key && key.trim()) return key.trim();
  } catch {
    // 配置读取失败时兜底读环境变量
  }
  const envKey = process.env.FINNHUB_API_KEY;
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

interface FMPPriceTarget {
  symbol: string;
  targetHigh?: number;
  targetLow?: number;
  targetConsensus?: number;
  targetMedian?: number;
  numberOfAnalysts?: number;
  recommendationMean?: number;
  recommendationKey?: string;
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
  ReturnOnEquityTTM: string;
  RevenueGrowth: string;
  QuarterlyRevenueGrowthYOY: string;
  GrossProfitMargin: string;
  ProfitMargin: string;
  OperatingMarginTTM: string;
  CurrentRatio: string;
  QuickRatio: string;
  TotalRevenue: string;
  RevenueTTM: string;
  EarningsGrowth: string;
  QuarterlyEarningsGrowthYOY: string;
  Currency: string;
  AnalystTargetPrice: string;
  AnalystRatingStrongBuy: string;
  AnalystRatingBuy: string;
  AnalystRatingHold: string;
  AnalystRatingSell: string;
  AnalystRatingStrongSell: string;
}

interface AVIncomeStatement {
  date: string;
  fiscalDateEnding: string;
  revenue: string;
  grossProfit: string;
  operatingIncome: string;
  netIncome: string;
  eps: string;
}

interface AVBalanceSheet {
  date: string;
  fiscalDateEnding: string;
  totalStockholdersEquity: string;
  totalShareholderEquity: string;
  totalAssets: string;
  totalCurrentAssets: string;
  totalCurrentLiabilities: string;
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
    if (data instanceof Object && "Information" in data) {
      return { data: null, error: `AV: ${data["Information"]}` };
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

  // Alpha Vantage 免费版限制 1 请求/秒，25 请求/天，必须串行调用
  const overviewRes = await avGet<AVOverview>({ function: "OVERVIEW", symbol: upper }, apiKey);
  await new Promise((r) => setTimeout(r, 1100));
  const incomeRes = await avGet<{ annualReports: AVIncomeStatement[] }>(
    { function: "INCOME_STATEMENT", symbol: upper },
    apiKey
  );
  await new Promise((r) => setTimeout(r, 1100));
  const balanceRes = await avGet<{ annualReports: AVBalanceSheet[] }>(
    { function: "BALANCE_SHEET", symbol: upper },
    apiKey
  );

  for (const res of [overviewRes, incomeRes, balanceRes]) {
    if (res.error) warnings.push(res.error);
  }

  const overview = overviewRes.data;
  const income = incomeRes.data?.annualReports ?? [];
  const balance = balanceRes.data?.annualReports ?? [];

  // 从 OVERVIEW 中解析分析师评级（1=强力买入, 2=买入, 3=持有, 4=卖出, 5=强力卖出）
  let recommendationMean: number | null = null;
  let numberOfAnalysts: number | null = null;
  const strongBuy = num(overview?.AnalystRatingStrongBuy) ?? 0;
  const buy = num(overview?.AnalystRatingBuy) ?? 0;
  const hold = num(overview?.AnalystRatingHold) ?? 0;
  const sell = num(overview?.AnalystRatingSell) ?? 0;
  const strongSell = num(overview?.AnalystRatingStrongSell) ?? 0;
  const totalAnalysts = strongBuy + buy + hold + sell + strongSell;
  if (totalAnalysts > 0) {
    const weightedScore = strongBuy * 1 + buy * 2 + hold * 3 + sell * 4 + strongSell * 5;
    recommendationMean = weightedScore / totalAnalysts;
    numberOfAnalysts = totalAnalysts;
  }

  const result: FinancialMetrics = {
    ticker: upper,
    name: overview?.Name ?? null,
    trailingPE: num(overview?.PERatio) ?? null,
    forwardPE: num(overview?.ForwardPE) ?? null,
    pegRatio: num(overview?.PEGRatio) ?? null,
    industry: overview?.Industry ?? null,
    industryPE: null,
    currentPrice: null,
    targetMeanPrice: num(overview?.AnalystTargetPrice) ?? null,
    targetHighPrice: null,
    targetLowPrice: null,
    targetMedianPrice: null,
    numberOfAnalysts,
    recommendationMean,
    targetUpside: null,
    revenueGrowthYoY: num(overview?.RevenueGrowth) != null
      ? num(overview?.RevenueGrowth)! / 100
      : (num(overview?.QuarterlyRevenueGrowthYOY) != null
          ? num(overview?.QuarterlyRevenueGrowthYOY)! / 100
          : null),
    quarterlyRevenueGrowth: num(overview?.QuarterlyRevenueGrowthYOY) != null
      ? num(overview?.QuarterlyRevenueGrowthYOY)! / 100
      : null,
    roe: num(overview?.ROE) ? num(overview?.ROE)! / 100 :
         (num(overview?.ReturnOnEquityTTM) ?? null),
    returnOnEquity5yAvg: null,
    roeHistory: [],
    quickRatio: num(overview?.QuickRatio) ?? null,
    currentRatio: num(overview?.CurrentRatio) ?? null,
    grossMargin: num(overview?.GrossProfitMargin) ? num(overview?.GrossProfitMargin)! / 100 :
                (num(overview?.OperatingMarginTTM) ?? null),
    profitMargin: num(overview?.ProfitMargin) ? num(overview?.ProfitMargin)! / 100 : null,
    totalRevenue: num(overview?.TotalRevenue) ?? num(overview?.RevenueTTM) ?? null,
    revenueHistory: [],
    marketCap: num(overview?.MarketCapitalization) ?? null,
    currency: overview?.Currency ?? null,
    fetchedAt: new Date().toISOString(),
    dataSource: "av",
    warnings,
  };

  const revenueHistory: Array<{ year: number; revenue: number | null }> = [];
  for (const stmt of income) {
    const dateStr = stmt.fiscalDateEnding || stmt.date;
    const date = new Date(dateStr);
    const year = date.getFullYear();
    if (Number.isFinite(year)) {
      revenueHistory.push({ year, revenue: num(stmt.revenue) });
    }
  }
  revenueHistory.sort((a, b) => a.year - b.year);
  result.revenueHistory = revenueHistory;

  const roeHistory: Array<{ year: number; roe: number | null }> = [];
  for (const bs of balance) {
    const dateStr = bs.fiscalDateEnding || bs.date;
    const date = new Date(dateStr);
    const year = date.getFullYear();
    if (!Number.isFinite(year)) continue;
    const inc = income.find((s) => {
      const sDateStr = s.fiscalDateEnding || s.date;
      const sYear = new Date(sDateStr).getFullYear();
      return sYear === year;
    });
    const equity = num(bs.totalStockholdersEquity) ?? num(bs.totalShareholderEquity);
    const netIncome = inc ? num(inc.netIncome) : null;
    const roe = equity != null && netIncome != null && equity !== 0 ? netIncome / equity : null;
    roeHistory.push({ year, roe });

    // 用 balance sheet 计算 currentRatio（如果 overview 没提供）
    if (result.currentRatio == null) {
      const currentAssets = num(bs.totalCurrentAssets) ?? num(bs.currentAssets);
      const currentLiabilities = num(bs.totalCurrentLiabilities) ?? num(bs.currentLiabilities);
      if (currentAssets != null && currentLiabilities != null && currentLiabilities !== 0) {
        result.currentRatio = currentAssets / currentLiabilities;
      }
    }
    // 用 balance sheet 计算 quickRatio
    if (result.quickRatio == null && result.currentRatio != null) {
      // 粗略估算：quickRatio ≈ currentRatio * 0.8（没有存货数据时的近似）
      result.quickRatio = result.currentRatio;
      warnings.push("quickRatio 用 currentRatio 近似（缺少存货数据）。");
    }
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

  // 行业 PE 近似（用 sector 经验值）
  const sector = overview?.Sector;
  const sectorPE = getSectorPE(sector);
  if (sector && sectorPE != null) {
    result.industryPE = sectorPE;
    warnings.push(
      `行业 PE 用 ${sector} 行业经验值 ${result.industryPE}（仅供参考）。`
    );
  }

  // 计算目标价上涨空间（需要当前价，但 AV OVERVIEW 没有直接的当前价，暂不计算）

  return result;
}

// ============================================================
// Finnhub
// ============================================================

interface FinnhubQuote {
  c: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

interface FinnhubCompanyProfile {
  name: string;
  ticker: string;
  marketCapitalization: number;
  currency: string;
  industry?: string;
  finnhubIndustry?: string;
  country?: string;
}

interface FinnhubRecommendationTrendItem {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

interface FinnhubMetrics {
  // 估值（比例/数值，无需除 100）
  peBasicExclExtraTTM?: number;
  peNormalizedAnnual?: number;
  peTTM?: number;
  peExclExtraTTM?: number;
  peInclExtraTTM?: number;
  forwardPE?: number;
  pegTTM?: number;
  pb?: number;
  // 盈利能力（百分比，需要除 100）
  roeTTM?: number;
  roe5Y?: number;
  roeRfy?: number;
  grossMarginTTM?: number;
  grossMarginAnnual?: number;
  grossMargin5Y?: number;
  netProfitMarginTTM?: number;
  netProfitMarginAnnual?: number;
  netProfitMargin5Y?: number;
  operatingMarginTTM?: number;
  // 流动性（比例，无需除 100）
  quickRatioAnnual?: number;
  quickRatioQuarterly?: number;
  currentRatioAnnual?: number;
  currentRatioQuarterly?: number;
  // 成长（百分比，需要除 100）
  revenueGrowthTTMYoy?: number;
  revenueGrowth5Y?: number;
  revenueGrowthQuarterlyYoy?: number;
  epsGrowthTTMYoy?: number;
  // 其他
  marketCapitalization?: number;
  [key: string]: number | string | undefined;
}

interface FinnhubCompanyBasicFinancials {
  metric?: FinnhubMetrics;
  series?: Record<string, Array<{ period: string; v: number }>>;
}

interface FinnhubNewsItem {
  category?: string;
  datetime?: number;
  headline?: string;
  id?: number;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
  title?: string;
}

async function finnhubGet<T>(path: string, apiKey: string): Promise<{ data: T | null; error?: string }> {
  try {
    const url = `${FINNHUB_BASE}${path}${path.includes("?") ? "&" : "?"}token=${apiKey}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "X-Finnhub-Token": apiKey },
    });
    if (!res.ok) {
      if (res.status === 429) {
        return { data: null, error: "Finnhub: 触发速率限制 (429)，请稍后再试。" };
      }
      if (res.status === 403) {
        return { data: null, error: "Finnhub: API Key 无效或无权限 (403)。" };
      }
      return { data: null, error: `Finnhub ${path}: HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data && typeof data === "object" && "error" in data) {
      return { data: null, error: `Finnhub: ${data["error"]}` };
    }
    return { data: data as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, error: `Finnhub ${path}: 网络错误 - ${msg}` };
  }
}

/**
 * 用 Finnhub 拉取财务数据
 * 端点：quote / profile / recommendation / stock/metrics
 */

/**
 * 获取市场整体 Fear & Greed Index（alternative.me，免费无需 Key）
 * 返回 0（极度恐惧）~ 100（极度贪婪）
 */
async function fetchMarketFearGreed(): Promise<{ value: number; classification: string } | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const fg = data?.data?.[0];
    if (fg?.value && fg?.value_classification) {
      return { value: parseInt(fg.value, 10), classification: fg.value_classification };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 stockanalysis.com 爬取分析师评级分布（S&P Global 数据，免费无需 Key）
 * 在 fetchStockAnalysisTargets 中已有页面抓取，这里提取评级分布部分
 */
async function fetchAnalystRatingDist(
  ticker: string
): Promise<{
  consensus: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  total: number;
  score: number;
} | null> {
  const upper = ticker.toUpperCase();
  const url = `https://stockanalysis.com/stocks/${upper.toLowerCase()}/forecast/`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // 提取评级分布对象: {consensus:"Buy",strongBuy:7,buy:1,hold:5,sell:0,strongSell:0,total:13,score:5.77}
    const match = html.match(
      /consensus:"(\w+)"[^}]*strongBuy:(\d+)[^}]*buy:(\d+)[^}]*hold:(\d+)[^}]*sell:(\d+)[^}]*strongSell:(\d+)[^}]*total:(\d+)[^}]*score:([\d.]+)/
    );
    if (!match) return null;
    return {
      consensus: match[1],
      strongBuy: parseInt(match[2], 10),
      buy: parseInt(match[3], 10),
      hold: parseInt(match[4], 10),
      sell: parseInt(match[5], 10),
      strongSell: parseInt(match[6], 10),
      total: parseInt(match[7], 10),
      score: parseFloat(match[8]),
    };
  } catch {
    return null;
  }
}

/**
 * 从 pullpush.io 获取 Reddit 提及数据（免费无需认证）
 * 搜索最近一周包含 ticker 的帖子
 */
async function fetchRedditMentions(
  ticker: string
): Promise<Array<{ title: string; subreddit: string; score: number; url?: string; createdUtc?: number }> | null> {
  const upper = ticker.toUpperCase();
  try {
    const url = `https://api.pullpush.io/reddit/search/submission/?q=${encodeURIComponent(`$${upper}`)}&size=8&sort=desc&sort_type=created_utc&after=7d`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const posts = data?.data ?? [];
    if (!Array.isArray(posts) || posts.length === 0) return null;
    return posts.slice(0, 8).map((p: Record<string, unknown>) => ({
      title: String(p.title ?? ""),
      subreddit: String(p.subreddit ?? ""),
      score: Number(p.score ?? 0),
      url: p.url ? String(p.url) : undefined,
      createdUtc: p.created_utc ? Number(p.created_utc) : undefined,
    }));
  } catch {
    return null;
  }
}

/**
 * 从 stockanalysis.com 爬取分析师目标价（数据来源 S&P Global，免费无需 Key）
 * 提供完整的 low / median / average / high + consensus rating + 分析师数量
 * 页面 HTML 内嵌 JSON: targets:{low,high,count,median,average,updated}
 */
async function fetchStockAnalysisTargets(
  ticker: string
): Promise<{
  targetLow: number | null;
  targetHigh: number | null;
  targetMedian: number | null;
  targetAverage: number | null;
  numberOfAnalysts: number | null;
  recommendationMean: number | null;
} | null> {
  const upper = ticker.toUpperCase();
  const url = `https://stockanalysis.com/stocks/${upper.toLowerCase()}/forecast/`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 提取 targets:{low:XX,high:XX,count:XX,median:XX,average:XX,...}
    const targetsMatch = html.match(/targets:\{([^}]+)\}/);
    let targetLow: number | null = null;
    let targetHigh: number | null = null;
    let targetMedian: number | null = null;
    let targetAverage: number | null = null;
    let numberOfAnalysts: number | null = null;

    if (targetsMatch) {
      const low = targetsMatch[1].match(/low:(\d+(?:\.\d+)?)/)?.[1];
      const high = targetsMatch[1].match(/high:(\d+(?:\.\d+)?)/)?.[1];
      const median = targetsMatch[1].match(/median:(\d+(?:\.\d+)?)/)?.[1];
      const average = targetsMatch[1].match(/average:(\d+(?:\.\d+)?)/)?.[1];
      const count = targetsMatch[1].match(/count:(\d+)/)?.[1];
      if (low) targetLow = parseFloat(low);
      if (high) targetHigh = parseFloat(high);
      if (median) targetMedian = parseFloat(median);
      if (average) targetAverage = parseFloat(average);
      if (count) numberOfAnalysts = parseInt(count, 10);
    }

    // 如果 targets 对象没匹配到，从页面文本提取（备选）
    if (targetAverage == null) {
      const avgMatch = html.match(/average price target of \$([\d.]+)/);
      if (avgMatch) targetAverage = parseFloat(avgMatch[1]);
    }
    if (targetHigh == null) {
      const highMatch = html.match(/highest is \$([\d.]+)/);
      if (highMatch) targetHigh = parseFloat(highMatch[1]);
    }
    if (targetLow == null) {
      const lowMatch = html.match(/lowest is \$([\d.]+)/);
      if (lowMatch) targetLow = parseFloat(lowMatch[1]);
    }
    if (numberOfAnalysts == null) {
      const analystMatch = html.match(/According to (\d+) analysts/);
      if (analystMatch) numberOfAnalysts = parseInt(analystMatch[1], 10);
    }

    // 提取评级 consensus + strongBuy/strongSell 计算 recommendationMean
    let recommendationMean: number | null = null;
    const ratingMatch = html.match(
      /consensus:"(\w+)"[^}]*strongBuy:(\d+)[^}]*strongSell:(\d+)/
    );
    if (ratingMatch) {
      const consensus = ratingMatch[1];
      // S&P Global consensus -> 近似 recommendationMean (1=Strong Buy ... 5=Strong Sell)
      const consensusMap: Record<string, number> = {
        "Strong Buy": 1,
        Buy: 2,
        Overweight: 2,
        Hold: 3,
        Neutral: 3,
        Underweight: 4,
        Sell: 4,
        "Strong Sell": 5,
      };
      recommendationMean = consensusMap[consensus] ?? null;
    }

    // 至少有一个有效值才返回
    if (
      targetLow == null &&
      targetHigh == null &&
      targetAverage == null &&
      targetMedian == null
    ) {
      return null;
    }

    return {
      targetLow,
      targetHigh,
      targetMedian,
      targetAverage,
      numberOfAnalysts,
      recommendationMean,
    };
  } catch {
    return null;
  }
}

/**
 * 从 Yahoo Finance RSS 获取公司新闻（无需 API Key / crumb 认证）
 * 端点：https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}
 */
async function fetchYahooRSSNews(
  ticker: string
): Promise<Array<{ title: string; source?: string; date?: string; summary?: string; url?: string }> | null> {
  const upper = ticker.toUpperCase();
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(upper)}&region=US&lang=en-US`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const xml = await res.text();
    // 解析 RSS <item> 条目
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    if (items.length === 0) return null;
    const news = items.slice(0, 15).map((item) => {
      const title = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1]
        ?? item.match(/<title>([\s\S]*?)<\/title>/)?.[1]
        ?? "";
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
      const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1]
        ?? item.match(/<description>([\s\S]*?)<\/description>/)?.[1]
        ?? "";
      // 去除 description 里的 HTML 标签
      const summary = desc.replace(/<[^>]+>/g, "").trim();
      return {
        title: title.trim(),
        source: "Yahoo Finance",
        date: pubDate ? new Date(pubDate).toISOString() : undefined,
        summary: summary || undefined,
        url: link || undefined,
      };
    }).filter((n) => n.title);
    return news.length > 0 ? news : null;
  } catch {
    return null;
  }
}

/** 从 Finnhub 获取最近 7 天公司新闻 */
async function fetchFinnhubNews(
  ticker: string,
  apiKey: string
): Promise<Array<{ title: string; source?: string; date?: string; summary?: string; url?: string }> | null> {
  const upper = ticker.toUpperCase();
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const to = today.toISOString().split("T")[0];
  const from = weekAgo.toISOString().split("T")[0];

  const res = await finnhubGet<FinnhubNewsItem[]>(
    `/company-news?symbol=${upper}&from=${from}&to=${to}`,
    apiKey
  );
  if (res.error || !res.data || res.data.length === 0) return null;

  return res.data.slice(0, 10).map((n) => ({
    title: n.headline || n.title || "",
    source: n.source,
    date: n.datetime ? new Date(n.datetime * 1000).toISOString() : undefined,
    summary: n.summary,
    url: n.url,
  }));
}

async function fetchFinnhubMetrics(ticker: string, apiKey: string): Promise<FinancialMetrics> {
  const upper = ticker.toUpperCase();
  const warnings: string[] = [];
  const result: FinancialMetrics = {
    ticker: upper,
    trailingPE: null,
    forwardPE: null,
    pegRatio: null,
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
    fetchedAt: new Date().toISOString(),
    dataSource: "finnhub",
    warnings,
  };

  const [quoteRes, profileRes, recRes, metricsRes, news] = await Promise.all([
    finnhubGet<FinnhubQuote>(`/quote?symbol=${upper}`, apiKey),
    finnhubGet<FinnhubCompanyProfile>(`/stock/profile2?symbol=${upper}`, apiKey),
    finnhubGet<FinnhubRecommendationTrendItem[]>(`/stock/recommendation?symbol=${upper}`, apiKey),
    finnhubGet<FinnhubCompanyBasicFinancials>(`/stock/metric?symbol=${upper}&metric=all`, apiKey),
    fetchFinnhubNews(upper, apiKey),
  ]);

  if (quoteRes.error) warnings.push(quoteRes.error);
  if (profileRes.error) warnings.push(profileRes.error);
  if (recRes.error) warnings.push(recRes.error);
  if (metricsRes.error) warnings.push(metricsRes.error);

  const quote = quoteRes.data;
  const profile = profileRes.data;
  const recommendations = recRes.data;
  const metrics = metricsRes.data?.metric;
  result.news = news ?? undefined;

  if (quote) {
    result.currentPrice = quote.c ?? null;
  }

  if (profile) {
    result.name = profile.name ?? null;
    result.marketCap = profile.marketCapitalization != null ? profile.marketCapitalization * 1e6 : null;
    result.currency = profile.currency ?? null;
    result.industry = profile.industry || profile.finnhubIndustry || null;
  }

  if (metrics) {
    // 估值（无需除 100）
    result.trailingPE =
      num(metrics.peBasicExclExtraTTM) ??
      num(metrics.peTTM) ??
      num(metrics.peExclExtraTTM) ??
      num(metrics.peInclExtraTTM) ??
      num(metrics.peNormalizedAnnual) ??
      null;
    result.forwardPE = num(metrics.forwardPE) ?? null;
    result.pegRatio = num(metrics.pegTTM) ?? null;

    // 盈利能力（百分比 → 小数）
    const roeTTM = num(metrics.roeTTM);
    const roe5Y = num(metrics.roe5Y);
    const roeRfy = num(metrics.roeRfy);
    result.roe = roeTTM != null ? roeTTM / 100 : null;
    result.returnOnEquity5yAvg = roe5Y != null ? roe5Y / 100 : roeRfy != null ? roeRfy / 100 : null;
    const grossMarginTTM = num(metrics.grossMarginTTM);
    result.grossMargin = grossMarginTTM != null ? grossMarginTTM / 100 : null;
    const netProfitMarginTTM = num(metrics.netProfitMarginTTM);
    result.profitMargin = netProfitMarginTTM != null ? netProfitMarginTTM / 100 : null;

    // 流动性（无需除 100）
    result.quickRatio =
      num(metrics.quickRatioAnnual) ?? num(metrics.quickRatioQuarterly) ?? null;
    result.currentRatio =
      num(metrics.currentRatioAnnual) ?? num(metrics.currentRatioQuarterly) ?? null;

    // 成长（百分比 → 小数）
    // 仅采用 revenueGrowthTTMYoy（滚动 12 个月同比），
    // 不再用 revenueGrowth5Y（5 年 CAGR）顶替——两者口径完全不同，
    // CAGR 会与"单年同比"出现数个百分点偏差，导致和财报口径对不上。
    const revenueGrowthTTMYoy = num(metrics.revenueGrowthTTMYoy);
    result.revenueGrowthYoY =
      revenueGrowthTTMYoy != null ? revenueGrowthTTMYoy / 100 : null;
  }

  if (recommendations && recommendations.length > 0) {
    const latest = recommendations[0];
    if (latest) {
      const total =
        (latest.strongBuy || 0) +
        (latest.buy || 0) +
        (latest.hold || 0) +
        (latest.sell || 0) +
        (latest.strongSell || 0);
      if (total > 0) {
        const weighted =
          1 * (latest.strongBuy || 0) +
          2 * (latest.buy || 0) +
          3 * (latest.hold || 0) +
          4 * (latest.sell || 0) +
          5 * (latest.strongSell || 0);
        result.recommendationMean = weighted / total;
      }
      if (result.numberOfAnalysts == null) {
        result.numberOfAnalysts = total;
      }
    }
  }

  if (result.returnOnEquity5yAvg == null && result.roe != null) {
    result.returnOnEquity5yAvg = result.roe;
    warnings.push("无法获取 5 年平均 ROE，使用当前 ROE 作为近似。");
  }
  if (result.roe == null) {
    warnings.push("无法获取 ROE 数据（当前与历史均无）。");
  }

  if (result.currentPrice != null && result.targetMeanPrice != null && result.currentPrice > 0) {
    result.targetUpside = result.targetMeanPrice / result.currentPrice - 1;
  }

  if (result.industry) {
    const indPE = getSectorPE(result.industry);
    const broadSector = getBroadSector(result.industry);
    if (indPE != null && broadSector) {
      result.industryPE = indPE;
      warnings.push(`行业 PE 用 ${broadSector} 行业经验值 ${indPE}（仅供参考）。`);
    }
  }

  return result;
}

// ============================================================
// Tiingo
// ============================================================

interface TiingoDailyPrice {
  ticker?: string;
  date?: string;
  close?: number;
  adjClose?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

interface TiingoFundamentals {
  ticker?: string;
  quoteDate?: string;
  marketCap?: number;
  peRatio?: number;
  forwardPE?: number;
  pegRatio?: number;
  pbRatio?: number;
  psRatio?: number;
  priceToSales?: number;
  priceToBook?: number;
  dividendYield?: number;
  beta?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  profitMargin?: number;
  grossMargin?: number;
  operatingMargin?: number;
  currentRatio?: number;
  quickRatio?: number;
  revenue?: number;
  revenueGrowth?: number;
  grossProfit?: number;
  netIncome?: number;
  eps?: number;
  epsGrowth?: number;
  targetHighPrice?: number;
  targetLowPrice?: number;
  targetConsensus?: number;
  targetMeanPrice?: number;
  numberOfAnalysts?: number;
  recommendationRating?: number;
  totalDebt?: number;
  totalCash?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  shortRatio?: number;
}

interface TiingoCompanyInfo {
  name: string;
  exchangeCode: string;
  industry?: string;
  sector?: string;
  description?: string;
  currency?: string;
  country?: string;
}

async function tiingoGet<T>(path: string, apiKey: string): Promise<{ data: T | null; error?: string }> {
  try {
    const url = `${TIINGO_BASE}${path}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed.detail) detail = parsed.detail;
      } catch {
        // 非 JSON，保留原文
      }
      if (res.status === 429) {
        return { data: null, error: "Tiingo: 触发速率限制 (429)，请稍后再试。" };
      }
      if (res.status === 401 || res.status === 403) {
        return { data: null, error: "Tiingo: API Key 无效或无权限。" };
      }
      return { data: null, error: `Tiingo ${path}: HTTP ${res.status} ${detail}` };
    }
    const data = await res.json();
    return { data: data as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, error: `Tiingo ${path}: 网络错误 - ${msg}` };
  }
}

/**
 * 用 Tiingo 拉取财务数据
 * 端点：top-of-book / fundamentals 每日 / 公司信息
 */
async function fetchTiingoMetrics(ticker: string, apiKey: string): Promise<FinancialMetrics> {
  const upper = ticker.toUpperCase();
  const warnings: string[] = [];
  const result: FinancialMetrics = {
    ticker: upper,
    trailingPE: null,
    forwardPE: null,
    pegRatio: null,
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
    fetchedAt: new Date().toISOString(),
    dataSource: "tiingo",
    warnings,
  };

  const [priceRes, fundRes, infoRes] = await Promise.all([
    tiingoGet<TiingoDailyPrice[]>(`/tiingo/daily/${upper}/prices?format=json`, apiKey),
    tiingoGet<TiingoFundamentals[]>(`/tiingo/fundamentals/${upper}/daily`, apiKey),
    tiingoGet<TiingoCompanyInfo>(`/tiingo/daily/${upper}`, apiKey),
  ]);

  if (priceRes.error) warnings.push(priceRes.error);
  if (fundRes.error) warnings.push(fundRes.error);
  if (infoRes.error) warnings.push(infoRes.error);

  const priceArray = Array.isArray(priceRes.data) ? priceRes.data : null;
  const price = priceArray && priceArray.length > 0
    ? priceArray[priceArray.length - 1]
    : null;
  const fundamentals = Array.isArray(fundRes.data) && fundRes.data.length > 0
    ? fundRes.data[fundRes.data.length - 1]
    : null;
  const info = infoRes.data;

  if (price) {
    result.currentPrice = price.adjClose ?? price.close ?? null;
  }

  if (info) {
    result.name = info.name ?? null;
    result.industry = info.industry || null;
    result.currency = info.currency || null;
  }

  if (fundamentals) {
    result.trailingPE = fundamentals.peRatio ?? null;
    result.forwardPE = fundamentals.forwardPE ?? null;
    result.pegRatio = fundamentals.pegRatio ?? null;
    result.marketCap = fundamentals.marketCap ?? null;
    result.roe = fundamentals.returnOnEquity ?? null;
    result.grossMargin = fundamentals.grossMargin ?? null;
    result.profitMargin = fundamentals.profitMargin ?? null;
    result.quickRatio = fundamentals.quickRatio ?? null;
    result.currentRatio = fundamentals.currentRatio ?? null;
    result.totalRevenue = fundamentals.revenue ?? null;
    result.revenueGrowthYoY = fundamentals.revenueGrowth ?? null;
    result.targetMeanPrice = fundamentals.targetMeanPrice ?? fundamentals.targetConsensus ?? null;
    result.targetHighPrice = fundamentals.targetHighPrice ?? null;
    result.targetLowPrice = fundamentals.targetLowPrice ?? null;
    result.numberOfAnalysts = fundamentals.numberOfAnalysts ?? null;
    result.recommendationMean = fundamentals.recommendationRating ?? null;
  }

  const fundamentalsFailed = !!fundRes.error;
  if (result.returnOnEquity5yAvg == null && result.roe != null) {
    result.returnOnEquity5yAvg = result.roe;
    warnings.push("无法获取 5 年平均 ROE，使用当前 ROE 作为近似。");
  }
  if (result.roe == null && !fundamentalsFailed) {
    // 只有在 fundamentals 端点成功返回数据但缺少 ROE 字段时才提示，
    // 若端点本身失败（如免费计划仅覆盖 DOW 30），由上层 orchestration 说明
    warnings.push("无法获取 ROE 数据（当前与历史均无）。");
  }

  if (result.currentPrice != null && result.targetMeanPrice != null && result.currentPrice > 0) {
    result.targetUpside = result.targetMeanPrice / result.currentPrice - 1;
  }

  if (result.industry) {
    const indPE = getSectorPE(result.industry);
    const broadSector = getBroadSector(result.industry);
    if (indPE != null && broadSector) {
      result.industryPE = indPE;
      warnings.push(`行业 PE 用 ${broadSector} 行业经验值 ${indPE}（仅供参考）。`);
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

  const [profileRes, ratiosRes, incomeRes, balanceRes, priceTargetRes] = await Promise.all([
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
    fmpGet<FMPPriceTarget[]>(`/stable/price-target-consensus?symbol=${upper}`, apiKey),
  ]);

  // 收集所有错误
  for (const res of [profileRes, ratiosRes, incomeRes, balanceRes, priceTargetRes]) {
    if (res.error) warnings.push(res.error);
  }

  const profile = profileRes.data?.[0];
  const ratios = ratiosRes.data ?? [];
  const income = incomeRes.data ?? [];
  const balance = balanceRes.data ?? [];
  const priceTarget = priceTargetRes.data?.[0];

  const latestRatio = ratios[0];
  const latestIncome = income[0];
  const currentPrice = num(profile?.price);

  // 如果所有端点都失败，返回空数据（但 dataSource 仍是 fmp，warnings 包含错误）
  const result: FinancialMetrics = {
    ticker: upper,
    name: profile?.companyName ?? null,
    trailingPE: num(latestRatio?.priceToEarningsRatio) ?? null,
    forwardPE: null,
    pegRatio: num(latestRatio?.priceToEarningsGrowthRatio) ?? null,
    industry: profile?.industry ?? null,
    industryPE: null,
    currentPrice,
    targetMeanPrice: num(priceTarget?.targetConsensus) ?? null,
    targetHighPrice: num(priceTarget?.targetHigh) ?? null,
    targetLowPrice: num(priceTarget?.targetLow) ?? null,
    targetMedianPrice: num(priceTarget?.targetMedian) ?? null,
    numberOfAnalysts: num(priceTarget?.numberOfAnalysts) ?? null,
    recommendationMean: num(priceTarget?.recommendationMean) ?? null,
    targetUpside: null,
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

  // 计算上涨空间
  if (result.targetMeanPrice != null && currentPrice != null && currentPrice > 0) {
    result.targetUpside = result.targetMeanPrice / currentPrice - 1;
  }

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
  const sectorPE = getSectorPE(sector);
  if (sector && sectorPE != null) {
    result.industryPE = sectorPE;
    warnings.push(
      `行业 PE 用 ${sector} 行业经验值 ${result.industryPE}（仅供参考）。`
    );
  } else {
    warnings.push("未获取到行业 PE 数据，peVsIndustry 指标将无法判定。");
  }

  return result;
}

/**
 * 合并两个数据源的财务数据
 * 优先使用 primary 的非空值，secondary 补充 primary 中为 null 的字段
 * 用于 FMP profile + AV 财务数据的组合
 */
function mergeMetrics(
  primary: FinancialMetrics,
  secondary: FinancialMetrics,
  sourceLabel: FinancialMetrics["dataSource"],
  extraWarnings: string[] = []
): FinancialMetrics {
  const allWarnings = [...extraWarnings, ...primary.warnings, ...secondary.warnings];
  const seen = new Set<string>();
  const uniqueWarnings = allWarnings.filter((w) => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });

  const merged: FinancialMetrics = {
    ticker: primary.ticker,
    name: primary.name ?? secondary.name ?? null,
    trailingPE: primary.trailingPE ?? secondary.trailingPE ?? null,
    forwardPE: primary.forwardPE ?? secondary.forwardPE ?? null,
    pegRatio: primary.pegRatio ?? secondary.pegRatio ?? null,
    industry: primary.industry ?? secondary.industry ?? null,
    industryPE: primary.industryPE ?? secondary.industryPE ?? null,
    currentPrice: primary.currentPrice ?? secondary.currentPrice ?? null,
    targetMeanPrice: primary.targetMeanPrice ?? secondary.targetMeanPrice ?? null,
    targetHighPrice: primary.targetHighPrice ?? secondary.targetHighPrice ?? null,
    targetLowPrice: primary.targetLowPrice ?? secondary.targetLowPrice ?? null,
    targetMedianPrice: primary.targetMedianPrice ?? secondary.targetMedianPrice ?? null,
    numberOfAnalysts: primary.numberOfAnalysts ?? secondary.numberOfAnalysts ?? null,
    recommendationMean: primary.recommendationMean ?? secondary.recommendationMean ?? null,
    targetUpside: null,
    revenueGrowthYoY: primary.revenueGrowthYoY ?? secondary.revenueGrowthYoY ?? null,
    quarterlyRevenueGrowth: primary.quarterlyRevenueGrowth ?? secondary.quarterlyRevenueGrowth ?? null,
    roe: primary.roe ?? secondary.roe ?? null,
    returnOnEquity5yAvg: primary.returnOnEquity5yAvg ?? secondary.returnOnEquity5yAvg ?? null,
    roeHistory: primary.roeHistory.length > 0 ? primary.roeHistory : secondary.roeHistory,
    quickRatio: primary.quickRatio ?? secondary.quickRatio ?? null,
    currentRatio: primary.currentRatio ?? secondary.currentRatio ?? null,
    grossMargin: primary.grossMargin ?? secondary.grossMargin ?? null,
    profitMargin: primary.profitMargin ?? secondary.profitMargin ?? null,
    totalRevenue: primary.totalRevenue ?? secondary.totalRevenue ?? null,
    revenueHistory: primary.revenueHistory.length > 0 ? primary.revenueHistory : secondary.revenueHistory,
    marketCap: primary.marketCap ?? secondary.marketCap ?? null,
    currency: primary.currency ?? secondary.currency ?? null,
    fetchedAt: new Date().toISOString(),
    dataSource: sourceLabel,
    warnings: uniqueWarnings,
  };

  // 重新计算目标价上涨空间
  if (merged.targetMeanPrice != null && merged.currentPrice != null && merged.currentPrice > 0) {
    merged.targetUpside = merged.targetMeanPrice / merged.currentPrice - 1;
  }

  return merged;
}

/**
 * 拉取并计算 5 项指标所需的数据
 * 数据源优先级：Tiingo → Finnhub → FMP → Alpha Vantage → Yahoo Finance → fallback
 *
 * 策略说明：
 * - Tiingo 免费版 500 req/day，作为首选完整数据源
 * - Finnhub 免费版 60 req/min，提供分析师目标价和新闻
 * - FMP profile 端点是免费的，优先获取（价格、公司名、行业等）
 * - FMP 的 ratios/income/balance-sheet 对部分股票是 Premium 的，返回 402
 * - Alpha Vantage 免费版有 25 次/天限制，用于补充财务数据
 * - Yahoo Finance 作为最后兜底
 */
export async function fetchFinancialMetrics(
  ticker: string
): Promise<FinancialMetrics> {
  const upper = ticker.trim().toUpperCase();
  const result = await fetchFinancialMetricsInternal(ticker);

  // 新闻获取：优先使用 Yahoo Finance RSS（无需 Key / crumb，稳定性最好），
  // 若 Yahoo 无结果再用 Finnhub 补充。
  if (!result.news || result.news.length === 0) {
    try {
      const yNews = await fetchYahooRSSNews(upper);
      if (yNews && yNews.length > 0) {
        result.news = yNews;
      }
    } catch {
      // Yahoo RSS 失败不影响主流程
    }
  }
  const finnhubKey = await getFinnhubApiKey();
  if (finnhubKey && (!result.news || result.news.length === 0)) {
    try {
      const news = await fetchFinnhubNews(ticker, finnhubKey);
      if (news && news.length > 0) {
        result.news = news;
      }
    } catch {
      // 补充新闻失败不影响主结果
    }
  }

  // ============================================================
  // 分析师目标价：优先爬取 stockanalysis.com（免费、无需 Key、数据最完整）
  // 数据来源：S&P Global，提供 low/median/average/high + consensus rating + 分析师数量
  // ============================================================
  if (
    result.targetMeanPrice == null ||
    result.targetHighPrice == null ||
    result.targetLowPrice == null ||
    result.targetMedianPrice == null
  ) {
    try {
      const sa = await fetchStockAnalysisTargets(upper);
      if (sa) {
        let hasNewData = false;
        if (sa.targetLow != null && result.targetLowPrice == null) {
          result.targetLowPrice = sa.targetLow;
          hasNewData = true;
        }
        if (sa.targetHigh != null && result.targetHighPrice == null) {
          result.targetHighPrice = sa.targetHigh;
          hasNewData = true;
        }
        if (sa.targetMedian != null && result.targetMedianPrice == null) {
          result.targetMedianPrice = sa.targetMedian;
          hasNewData = true;
        }
        if (sa.targetAverage != null && result.targetMeanPrice == null) {
          result.targetMeanPrice = sa.targetAverage;
          hasNewData = true;
        }
        if (sa.numberOfAnalysts != null && result.numberOfAnalysts == null) {
          result.numberOfAnalysts = sa.numberOfAnalysts;
          hasNewData = true;
        }
        if (sa.recommendationMean != null && result.recommendationMean == null) {
          result.recommendationMean = sa.recommendationMean;
          hasNewData = true;
        }
        if (hasNewData) {
          result.warnings.push("分析师目标价由 stockanalysis.com (S&P Global) 补充。");
          if (result.currentPrice != null && result.targetMeanPrice != null && result.currentPrice > 0) {
            result.targetUpside = result.targetMeanPrice / result.currentPrice - 1;
          }
        }
      }
    } catch {
      // 爬取失败不影响主结果
    }
  }

  // 若主数据源没有分析师目标价，尝试用 Alpha Vantage OVERVIEW 补充（仅 1 次请求）
  const avKey = await getAvApiKey();
  if (avKey && result.targetMeanPrice == null) {
    try {
      const avOverview = await fetchAVOverviewOnly(ticker, avKey);
      if (avOverview) {
        let hasNewData = false;
        if (avOverview.targetMeanPrice != null && result.targetMeanPrice == null) {
          result.targetMeanPrice = avOverview.targetMeanPrice;
          hasNewData = true;
        }
        if (avOverview.numberOfAnalysts != null && result.numberOfAnalysts == null) {
          result.numberOfAnalysts = avOverview.numberOfAnalysts;
          hasNewData = true;
        }
        if (avOverview.recommendationMean != null && result.recommendationMean == null) {
          result.recommendationMean = avOverview.recommendationMean;
          hasNewData = true;
        }
        if (hasNewData) {
          result.warnings.push("分析师目标价与评级由 Alpha Vantage 补充。");
          if (result.currentPrice != null && result.targetMeanPrice != null && result.currentPrice > 0) {
            result.targetUpside = result.targetMeanPrice / result.currentPrice - 1;
          }
        }
      }
    } catch {
      // 补充失败不影响主结果
    }
  }

  // 若目标价相关字段有任何缺失，尝试用 Yahoo Finance financialData 补充
  // （包括均值、高低位、中位数、分析师数量、推荐均值）
  const needsYfTargetSupplement =
    result.targetMeanPrice == null ||
    result.targetHighPrice == null ||
    result.targetLowPrice == null ||
    result.targetMedianPrice == null ||
    result.numberOfAnalysts == null ||
    result.recommendationMean == null;

  if (needsYfTargetSupplement) {
    try {
      const yfSummary = await fetchQuoteSummary(upper, ["financialData"]);
      if (yfSummary) {
        const fd = (yfSummary as Record<string, unknown>).financialData as
          | Record<string, unknown>
          | undefined;
        if (fd) {
          let hasNewData = false;
          const mean = num(fd.targetMeanPrice);
          const high = num(fd.targetHighPrice);
          const low = num(fd.targetLowPrice);
          const median = num(fd.targetMedianPrice);
          const analysts = num(fd.numberOfAnalystOpinions);
          const recMean = num(fd.recommendationMean);

          if (mean != null && result.targetMeanPrice == null) {
            result.targetMeanPrice = mean;
            hasNewData = true;
          }
          if (high != null && result.targetHighPrice == null) {
            result.targetHighPrice = high;
            hasNewData = true;
          }
          if (low != null && result.targetLowPrice == null) {
            result.targetLowPrice = low;
            hasNewData = true;
          }
          if (median != null && result.targetMedianPrice == null) {
            result.targetMedianPrice = median;
            hasNewData = true;
          }
          if (analysts != null && result.numberOfAnalysts == null) {
            result.numberOfAnalysts = analysts;
            hasNewData = true;
          }
          if (recMean != null && result.recommendationMean == null) {
            result.recommendationMean = recMean;
            hasNewData = true;
          }
          if (hasNewData) {
            result.warnings.push(
              "分析师目标价与评级由 Yahoo Finance 补充。"
            );
            if (result.currentPrice != null && result.targetMeanPrice != null && result.currentPrice > 0) {
              result.targetUpside = result.targetMeanPrice / result.currentPrice - 1;
            }
          }
        }
      }
    } catch {
      // 补充失败不影响主结果
    }
  }

  // Yahoo quoteSummary 失败后，用 v7/quote 兜底补充目标价（无需 crumb）
  if (
    result.targetMeanPrice == null ||
    result.targetHighPrice == null ||
    result.targetLowPrice == null ||
    result.targetMedianPrice == null
  ) {
    try {
      const v7 = await fetchV7Quote(upper);
      if (v7) {
        const mean = num(v7.targetMeanPrice);
        const high = num(v7.targetHighPrice);
        const low = num(v7.targetLowPrice);
        const median = num(v7.targetMedianPrice);
        const analysts = num(v7.numberOfAnalystOpinions);
        const recMean = num(v7.recommendationMean);
        let hasNewData = false;
        if (mean != null && result.targetMeanPrice == null) { result.targetMeanPrice = mean; hasNewData = true; }
        if (high != null && result.targetHighPrice == null) { result.targetHighPrice = high; hasNewData = true; }
        if (low != null && result.targetLowPrice == null) { result.targetLowPrice = low; hasNewData = true; }
        if (median != null && result.targetMedianPrice == null) { result.targetMedianPrice = median; hasNewData = true; }
        if (analysts != null && result.numberOfAnalysts == null) { result.numberOfAnalysts = analysts; hasNewData = true; }
        if (recMean != null && result.recommendationMean == null) { result.recommendationMean = recMean; hasNewData = true; }
        if (hasNewData) {
          result.warnings.push("分析师目标价由 Yahoo v7/quote 补充。");
          if (result.currentPrice != null && result.targetMeanPrice != null && result.currentPrice > 0) {
            result.targetUpside = result.targetMeanPrice / result.currentPrice - 1;
          }
        }
      }
    } catch {
      // v7 兜底失败不影响主结果
    }
  }

  // 若主数据源有 PE 但没有行业 PE，尝试用 Finnhub profile 补充行业信息（轻量级）
  if (
    finnhubKey &&
    result.trailingPE != null &&
    result.industryPE == null
  ) {
    try {
      const profile = await finnhubGet<FinnhubCompanyProfile>(
        `/stock/profile2?symbol=${upper}`,
        finnhubKey
      );
      const industry =
        profile.data?.industry || profile.data?.finnhubIndustry || null;
      const indPE = getSectorPE(industry);
      const broadSector = getBroadSector(industry);
      if (indPE != null && broadSector) {
        result.industry = industry;
        result.industryPE = indPE;
        result.warnings.push(
          `行业 PE 用 ${broadSector} 行业经验值 ${indPE}（仅供参考）。`
        );
      }
    } catch {
      // 补充失败不影响主结果
    }
  }

  // ============================================================
  // 行业 PE：用 stockanalysis.com 实时加权平均 PE 覆盖硬编码经验值
  // 数据源函数已用 SECTOR_DEFAULT_PE 填充了近似值，
  // 这里异步爬取实时数据覆盖，失败则保留经验值。
  // ============================================================
  if (result.industry) {
    try {
      const livePE = await getSectorPEResolved(result.industry);
      if (livePE != null) {
        const broadSector = getBroadSector(result.industry) ?? result.industry;
        const isFromSA = sectorPECache?.sector === broadSector;
        result.industryPE = livePE;
        if (isFromSA) {
          result.warnings.push(
            `行业 PE 来自 stockanalysis.com 实时数据：${broadSector} 加权平均 PE = ${livePE}。`
          );
        }
      }
    } catch {
      // 爬取失败保留经验值
    }
  }

  // ============================================================
  // 情绪面数据：市场 Fear & Greed + 分析师评级分布 + Reddit 提及
  // 全部免费数据源，并行获取，任一失败不影响其他
  // ============================================================
  try {
    const [marketFG, analystRating, redditMentions] = await Promise.all([
      fetchMarketFearGreed(),
      fetchAnalystRatingDist(upper),
      fetchRedditMentions(upper),
    ]);
    const sentiment: NonNullable<typeof result.sentiment> = {};
    if (marketFG) sentiment.marketFearGreed = marketFG;
    if (analystRating) sentiment.analystRating = analystRating;
    if (redditMentions) sentiment.redditMentions = redditMentions;
    if (Object.keys(sentiment).length > 0) {
      result.sentiment = sentiment;
    }
  } catch {
    // 情绪数据获取失败不影响主流程
  }

  // ============================================================
  // 口径统一：营收年增长统一为"最近两个完整财年同比"
  // 数据源现成字段（TTM / 季度同比 / CAGR 等）仅作辅助，
  // 只要 revenueHistory 有 ≥2 年，就用末两年自算覆盖，避免口径混杂
  // 导致与财报口径（财年同比）对不上。
  // ============================================================
  if (result.revenueHistory.length >= 2) {
    const latest = result.revenueHistory[result.revenueHistory.length - 1];
    const prev = result.revenueHistory[result.revenueHistory.length - 2];
    if (latest?.revenue && prev?.revenue && prev.revenue > 0) {
      const computed = latest.revenue / prev.revenue - 1;
      if (result.revenueGrowthYoY == null) {
        result.revenueGrowthYoY = computed;
        result.warnings.push(
          `revenueGrowthYoY 由历史营收估算（${prev.year}→${latest.year} 财年同比）。`
        );
      } else if (Math.abs(result.revenueGrowthYoY - computed) > 0.001) {
        result.warnings.push(
          `revenueGrowthYoY 口径统一：数据源值 ${(result.revenueGrowthYoY * 100).toFixed(2)}% → 历史营收同比 ${(computed * 100).toFixed(2)}%（${prev.year}→${latest.year}）。`
        );
        result.revenueGrowthYoY = computed;
      }
    }
  }

  return result;
}

/**
 * 轻量级：仅调用 Alpha Vantage OVERVIEW，获取目标价与分析师评级
 * 不消耗 INCOME_STATEMENT / BALANCE_SHEET 配额
 */
async function fetchAVOverviewOnly(
  ticker: string,
  apiKey: string
): Promise<{
  targetMeanPrice: number | null;
  numberOfAnalysts: number | null;
  recommendationMean: number | null;
} | null> {
  const upper = ticker.toUpperCase();
  const res = await avGet<AVOverview>({ function: "OVERVIEW", symbol: upper }, apiKey);
  if (!res.data) return null;
  const ov = res.data;

  const strongBuy = num(ov.AnalystRatingStrongBuy) ?? 0;
  const buy = num(ov.AnalystRatingBuy) ?? 0;
  const hold = num(ov.AnalystRatingHold) ?? 0;
  const sell = num(ov.AnalystRatingSell) ?? 0;
  const strongSell = num(ov.AnalystRatingStrongSell) ?? 0;
  const total = strongBuy + buy + hold + sell + strongSell;

  let recommendationMean: number | null = null;
  let numberOfAnalysts: number | null = null;
  if (total > 0) {
    const weighted = strongBuy * 1 + buy * 2 + hold * 3 + sell * 4 + strongSell * 5;
    recommendationMean = weighted / total;
    numberOfAnalysts = total;
  }

  return {
    targetMeanPrice: num(ov.AnalystTargetPrice) ?? null,
    numberOfAnalysts,
    recommendationMean,
  };
}

async function fetchFinancialMetricsInternal(
  ticker: string
): Promise<FinancialMetrics> {
  const upper = ticker.trim().toUpperCase();
  const warnings: string[] = [];

  const [fmpKey, finnhubKey, tiingoKey, avKey] = await Promise.all([
    getFmpApiKey(),
    getFinnhubApiKey(),
    getTiingoApiKey(),
    getAvApiKey(),
  ]);

  // 辅助：检测是否有核心财务数据
  const hasCore = (m: FinancialMetrics) =>
    m.trailingPE != null || m.totalRevenue != null || m.roe != null;
  const hasProfile = (m: FinancialMetrics) =>
    m.name != null || m.currentPrice != null || m.industry != null;
  const hasAny = (m: FinancialMetrics) =>
    hasCore(m) || hasProfile(m) || m.targetMeanPrice != null;

  // ============================================================
  // 1. 优先 Tiingo
  // ============================================================
  // Tiingo 免费/ Power 计划的基本面数据仅覆盖 DOW 30，因此把它当作
  // "价格 + 公司信息" 的首选来源；若 fundamentals 返回受限，则保留
  // profile 数据，继续用 Finnhub / FMP 补充核心财务数据。
  let tiingoPartial: FinancialMetrics | null = null;
  if (tiingoKey) {
    const tiingo = await fetchTiingoMetrics(upper, tiingoKey);
    if (hasCore(tiingo)) {
      // DOW 30 等包含基本面的股票，直接返回完整 Tiingo 数据
      return tiingo;
    }
    if (hasProfile(tiingo)) {
      tiingoPartial = tiingo;
      warnings.push(...tiingo.warnings);
      if (tiingo.warnings.some((w) => w.includes("DOW 30"))) {
        warnings.push(
          "Tiingo 基本面数据受限（免费/ Power 计划仅覆盖 DOW 30），尝试用 Finnhub 补充财务指标。"
        );
      } else {
        warnings.push("Tiingo 未返回完整财务数据，尝试用 Finnhub 补充。");
      }
    } else {
      warnings.push(...tiingo.warnings);
      warnings.push("Tiingo 未返回有效数据，降级到 Finnhub。");
    }
  }

  // ============================================================
  // 2. Finnhub
  // ============================================================
  if (finnhubKey) {
    const finnhub = await fetchFinnhubMetrics(upper, finnhubKey);
    if (hasAny(finnhub)) {
      // Tiingo 已有价格/公司信息，Finnhub 补充财务数据，合并返回
      if (tiingoPartial && hasCore(finnhub)) {
        return mergeMetrics(tiingoPartial, finnhub, "finnhub+tiingo", [
          ...warnings,
        ]);
      }
      return finnhub;
    }
    warnings.push(...finnhub.warnings);
    warnings.push("Finnhub 未返回有效数据，降级到 FMP。");
  }

  // ============================================================
  // 3. FMP
  // ============================================================
  if (fmpKey) {
    const fmp = await fetchFMPMetrics(upper, fmpKey);

    if (hasCore(fmp)) {
      if (tiingoPartial) {
        return mergeMetrics(tiingoPartial, fmp, "fmp+tiingo", [...warnings]);
      }
      return fmp;
    }

    // FMP 财务数据是 Premium 的，但 profile 可能还有
    if (hasProfile(fmp)) {
      // 依次尝试用 Finnhub / AV / Tiingo 补充财务数据
      if (finnhubKey) {
        const finnhub = await fetchFinnhubMetrics(upper, finnhubKey);
        if (hasCore(finnhub) || finnhub.targetMeanPrice != null) {
          return mergeMetrics(fmp, finnhub, "fmp+finnhub", [...warnings]);
        }
      }
      if (avKey) {
        const av = await fetchAVMetrics(upper, avKey);
        if (hasCore(av) || av.targetMeanPrice != null) {
          return mergeMetrics(fmp, av, "fmp+av", [...warnings]);
        }
      }
      if (tiingoPartial && (hasCore(tiingoPartial) || tiingoPartial.targetMeanPrice != null)) {
        return mergeMetrics(fmp, tiingoPartial, "fmp+tiingo", [...warnings]);
      }
      // 所有补充数据源都没有核心数据，返回 FMP profile
      warnings.push(...fmp.warnings);
      warnings.push("FMP 财务数据为 Premium 股票，其他数据源也未能补充财务数据，仅返回基础信息。");
      return { ...fmp, warnings: [...warnings] };
    }

    // FMP 连 profile 都没有，降级
    warnings.push(...fmp.warnings);
    warnings.push("FMP 未返回任何数据，尝试其他数据源。");
  }

  // ============================================================
  // 4. Alpha Vantage
  // ============================================================
  if (avKey) {
    const av = await fetchAVMetrics(upper, avKey);
    if (hasAny(av)) {
      if (tiingoPartial) {
        return mergeMetrics(tiingoPartial, av, "av+tiingo", [...warnings]);
      }
      return av;
    }
    warnings.push(...av.warnings);
    warnings.push("Alpha Vantage 未返回财务数据，降级到 Yahoo Finance。");
  }

  // ============================================================
  // 5. Yahoo Finance quoteSummary（带 crumb 认证）
  // ============================================================
  const fallback: FinancialMetrics = {
    ticker: upper,
    trailingPE: null,
    forwardPE: null,
    pegRatio: null,
    industry: null,
    industryPE: null,
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
    fetchedAt: new Date().toISOString(),
    dataSource: "fallback",
    warnings,
  };

  const summary = await fetchQuoteSummary(upper, [
    "summaryDetail",
    "summaryProfile",
    "defaultKeyStatistics",
    "financialData",
    "incomeStatementHistory",
    "balanceSheetHistory",
    "financialsTemplate",
  ]);

  if (!summary) {
    warnings.push(
      "Yahoo Finance quoteSummary 接口不可用（可能需要 crumb 认证或被限流）。"
    );
    // 6. 兜底：尝试 v7/quote
    const v7 = await fetchV7Quote(upper);
    if (v7) {
      fallback.dataSource = "yahoo-v7";
      fallback.trailingPE = num(v7.trailingPE);
      fallback.forwardPE = num(v7.forwardPE);
      fallback.pegRatio = num(v7.pegRatio);
      // v7/quote 端点不返回营收增长字段；
      // 旧代码错把 earningsGrowth（盈利增长）当 revenueGrowthYoY 使用，
      // 现在置 null，由上层历史营收估算或 warning 提示缺失。
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
      fallback.currentPrice = num(v7.regularMarketPrice) ?? num(v7.currentPrice);
      fallback.targetMeanPrice = num(v7.targetMeanPrice);
      fallback.targetHighPrice = num(v7.targetHighPrice);
      fallback.targetLowPrice = num(v7.targetLowPrice);
      fallback.targetMedianPrice = num(v7.targetMedianPrice);
      fallback.numberOfAnalysts = num(v7.numberOfAnalystOpinions);
      fallback.recommendationMean = num(v7.recommendationMean);
      if (fallback.targetMeanPrice != null && fallback.currentPrice != null && fallback.currentPrice > 0) {
        fallback.targetUpside = fallback.targetMeanPrice / fallback.currentPrice - 1;
      }
      warnings.push("部分数据来自 v7/quote 端点，可能不完整。");

      const sector = str(v7.sector);
      const sectorPE = getSectorPE(sector);
      if (sector && sectorPE != null) {
        fallback.industryPE = sectorPE;
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

  fallback.industry = str(summaryProfile.industry) ?? null;
  const sector = str(summaryProfile.sector);

  fallback.trailingPE = num(summaryDetail.trailingPE);
  fallback.forwardPE = num(summaryDetail.forwardPE);
  fallback.pegRatio = num(defaultKeyStats.pegRatio) ?? num(summaryDetail.pegRatio);

  fallback.currentPrice = num(financialData.currentPrice) ?? num(summaryDetail.regularMarketPrice);
  fallback.targetMeanPrice = num(financialData.targetMeanPrice);
  fallback.targetHighPrice = num(financialData.targetHighPrice);
  fallback.targetLowPrice = num(financialData.targetLowPrice);
  fallback.targetMedianPrice = num(financialData.targetMedianPrice);
  fallback.numberOfAnalysts = num(financialData.numberOfAnalystOpinions);
  fallback.recommendationMean = num(financialData.recommendationMean);
  if (fallback.targetMeanPrice != null && fallback.currentPrice != null && fallback.currentPrice > 0) {
    fallback.targetUpside = fallback.targetMeanPrice / fallback.currentPrice - 1;
  }

  // 成长
  // Yahoo financialData.revenueGrowth 实为最近季度营收同比，
  // financialData.earningsGrowth 是盈利增长（旧代码错用为营收季度增速）。
  fallback.revenueGrowthYoY = num(financialData.revenueGrowth);
  fallback.quarterlyRevenueGrowth = num(financialData.revenueGrowth);

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
  const sectorPE = getSectorPE(sector);
  if (sector && sectorPE != null) {
    fallback.industryPE = sectorPE;
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
