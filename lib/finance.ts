/**
 * 财务数据获取（Yahoo Finance 非官方端点）
 *
 * 数据获取流程：
 *   1. 获取 crumb（用 cookie 请求 /v1/test/getcrumb）
 *   2. 用 crumb + cookie 调 quoteSummary
 *   3. 若失败，回退到 v7/quote（不需要 crumb，但字段少）
 *   4. 若仍失败，所有字段返回 null + 添加 warning
 *
 * 用于支持 5 项指标分析：
 *   1. 营收年增长 ≥ 10%
 *   2. PE 是否远高于行业平均值
 *   3. PEG ≤ 2
 *   4. 近 5 年平均 ROE > 15%
 *   5. 速动比率 > 1.5
 */

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
  dataSource: "yahoo" | "yahoo-v7" | "fallback";
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
 */
export async function fetchFinancialMetrics(
  ticker: string
): Promise<FinancialMetrics> {
  const upper = ticker.trim().toUpperCase();
  const warnings: string[] = [];

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
    // 兜底：尝试 v7/quote
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
