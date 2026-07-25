/**
 * 美股综合分析报告生成（us-stock-analysis 集成版）
 *
 * 设计目标：把 us-stock-analysis 这套"分析框架 + LLM 合成"工作流变成项目里的
 * 自服务功能，与已有的 /api/analyze（5 项指标策略分析）完全独立、互不干扰。
 *
 * 数据来源（美股专用）：
 *   - stockanalysis.com 爬取：基本面 / 估值 / 分析师目标价与评级（用户指定主源）
 *   - lib/quote.ts (fetchQuote)：现价 / 涨跌 / 币种
 *   - lib/technical.ts (fetchTradingViewTechnicals)：TradingView 技术信号
 *   - Yahoo Finance RSS：近期新闻（stockanalysis 新闻页结构不稳，用 Yahoo 兜底）
 *   - Yahoo v8 chart：52 周高低（stockanalysis 未给出时的兜底）
 *
 * 合成：把"真实抓取数据 + us-stock-analysis 报告框架"拼成 prompt，调 chatCompletion()，
 * 返回 Markdown 报告（前端用 react-markdown 渲染）。
 *
 * 注意：本文件是新增模块，不修改 lib/finance.ts / lib/analysis / /api/analyze。
 */

import {
  fetchTradingViewTechnicals,
  SIGNAL_LABELS,
  type TechnicalSignals,
} from "./technical";
import { fetchQuote } from "./quote";
import { chatCompletion } from "./llm";
import { getPrisma } from "@/lib/db/prisma";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface StockReportNews {
  title: string;
  source?: string;
  date?: string;
  url?: string;
}

export interface PeerComparison {
  ticker: string;
  name?: string | null;
  price?: number | null;
  marketCap?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  evEbitda?: number | null;
  targetMeanPrice?: number | null;
}

export interface StockAnalysisData {
  ticker: string;
  name?: string | null;
  price?: number | null;
  changePercent?: number | null;
  currency?: string;
  marketCap?: number | null;
  week52High?: number | null;
  week52Low?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  pegRatio?: number | null;
  roe?: number | null;
  grossMargin?: number | null;
  profitMargin?: number | null;
  revenueGrowthYoY?: number | null;
  totalRevenue?: number | null;
  revenueHistory?: Array<{ year: number; revenue: number }>;
  debtToEquity?: number | null;
  freeCashFlow?: number | null;
  targetMeanPrice?: number | null;
  targetHighPrice?: number | null;
  targetLowPrice?: number | null;
  recommendationMean?: number | null; // 1=强烈买入 ... 5=强烈卖出
  numberOfAnalysts?: number | null;
  industry?: string | null;
  technical?: TechnicalSignals | null;
  news?: StockReportNews[];
  // —— 绝对财务与估值指标（由 stockanalysis 财务表解析为主，Yahoo 仅兜底）——
  netIncome?: number | null;
  operatingIncome?: number | null;
  ebitda?: number | null;
  evEbit?: number | null; // EV/EBIT（stockanalysis 未披露 EBITDA 时的替代估值倍数）
  operatingCashFlow?: number | null;
  totalCash?: number | null;
  totalDebt?: number | null;
  enterpriseValue?: number | null;
  /** 优先 Yahoo enterpriseToEbitda，否则 (EV 或 市值+债-现金)/EBITDA */
  evEbitda?: number | null;
  dividendYield?: number | null; // 小数形式（0.0062 = 0.62%）
  trailingEps?: number | null;
  forwardEps?: number | null;
  ytdPercent?: number | null;
  netIncomeHistory?: Array<{ year: number; value: number }>;
  freeCashFlowHistory?: Array<{ year: number; value: number }>;
  peers?: PeerComparison[] | null;
  notes?: string[];
}

export interface StockReport {
  ticker: string;
  report: string;
  data: StockAnalysisData;
  generatedAt: string;
}

/* ============================================================
 * 基础抓取工具（复制自 lib/finance.ts 的 stockanalysis 范式，
 * 自包含以避免修改现有文件）
 * ============================================================ */

async function fetchSAPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** 从 SvelteKit 内嵌的 financialData JS 对象中提取数据（非标准 JSON，用 new Function 解析） */
function extractFinancialData(html: string): Record<string, unknown> | null {
  const marker = "financialData:{";
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  let depth = 0;
  const start = idx + "financialData:".length;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  const jsLiteral = html.substring(start, end);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${jsLiteral})`);
    return fn() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 解析 stockanalysis.com 财务报表 HTML 表格，提取绝对财务数字。
 * 数值单位统一为美元绝对值（表格内为百万美元，×1e6），与 marketCap 口径一致；
 * dividendYield 为小数形式（表格百分比 ÷100），与 Yahoo 口径一致。
 * 注意：stockanalysis 财务表不含 EBITDA / 折旧摊销行，故不在此提取 EBITDA。
 */
function parseFinancialTables(html: string): {
  netIncome?: number | null;
  operatingIncome?: number | null;
  operatingCashFlow?: number | null;
  freeCashFlow?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;
  dividendYield?: number | null;
  netIncomeHistory?: Array<{ year: number; value: number }>;
  freeCashFlowHistory?: Array<{ year: number; value: number }>;
} {
  const rowsMatch = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  if (rowsMatch.length === 0) return {};
  const rows = rowsMatch.map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      c[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
    )
  );

  // 表头行：含 FY 年份或 TTM
  let header: string[] = [];
  for (const r of rows) {
    if (
      r.some(
        (c) => /^FY\s*\d{4}$/i.test(c.trim()) || c.trim().toUpperCase() === "TTM"
      )
    ) {
      header = r;
      break;
    }
  }
  const colYear: Array<number | "TTM" | null> = header.map((c) => {
    const t = c.trim();
    if (t.toUpperCase() === "TTM") return "TTM";
    const m = t.match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  });

  const toNum = (s: string): number | null => {
    const t = s.trim();
    if (!t || t === "—" || t === "-") return null;
    const neg = t.startsWith("(") && t.endsWith(")");
    const cleaned = t.replace(/[(),$\s%]/g, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  };
  const findRow = (re: RegExp): string[] | null => {
    for (const r of rows) if (r[0] && re.test(r[0])) return r;
    return null;
  };
  const MILLION = 1e6;
  // 取最新完整财年（非 TTM）的数值；退回 TTM
  const pickLatestFY = (row: string[] | null): number | null => {
    if (!row) return null;
    let best: number | null = null;
    let bestYear = -1;
    for (let i = 1; i < row.length && i < colYear.length; i++) {
      const y = colYear[i];
      if (typeof y === "number" && y > bestYear) {
        const v = toNum(row[i]);
        if (v != null) {
          bestYear = y;
          best = v;
        }
      }
    }
    if (best != null) return best;
    const ti = colYear.indexOf("TTM");
    return ti > 0 ? toNum(row[ti]) : null;
  };
  const historyOf = (
    row: string[] | null
  ): Array<{ year: number; value: number }> => {
    const out: Array<{ year: number; value: number }> = [];
    if (!row) return out;
    for (let i = 1; i < row.length && i < colYear.length; i++) {
      const y = colYear[i];
      if (typeof y === "number") {
        const v = toNum(row[i]);
        if (v != null) out.push({ year: y, value: v * MILLION });
      }
    }
    return out.sort((a, b) => a.year - b.year);
  };

  const result: {
    netIncome?: number | null;
    operatingIncome?: number | null;
    operatingCashFlow?: number | null;
    freeCashFlow?: number | null;
    totalDebt?: number | null;
    totalCash?: number | null;
    dividendYield?: number | null;
    netIncomeHistory?: Array<{ year: number; value: number }>;
    freeCashFlowHistory?: Array<{ year: number; value: number }>;
  } = {};

  const ni = findRow(/net income/i);
  if (ni) {
    const v = pickLatestFY(ni);
    if (v != null) result.netIncome = v * MILLION;
    result.netIncomeHistory = historyOf(ni);
  }
  const oi = findRow(/operating income/i);
  if (oi) {
    const v = pickLatestFY(oi);
    if (v != null) result.operatingIncome = v * MILLION;
  }
  const ocf = findRow(/operating cash flow/i);
  if (ocf) {
    const v = pickLatestFY(ocf);
    if (v != null) result.operatingCashFlow = v * MILLION;
  }
  const fcf = findRow(/free cash flow/i);
  if (fcf) {
    const v = pickLatestFY(fcf);
    if (v != null) result.freeCashFlow = v * MILLION;
    result.freeCashFlowHistory = historyOf(fcf);
  }
  const td = findRow(/total debt/i);
  if (td) {
    const v = pickLatestFY(td);
    if (v != null) result.totalDebt = v * MILLION;
  }
  const cash =
    findRow(/cash & (short-term investments|equivalents|investments)/i) ||
    findRow(/^cash\b/i);
  if (cash) {
    const v = pickLatestFY(cash);
    if (v != null) result.totalCash = v * MILLION;
  }
  const dy = findRow(/dividend yield/i);
  if (dy) {
    const v = pickLatestFY(dy);
    if (v != null) result.dividendYield = v / 100; // 百分比→小数
  }
  return result;
}

function arrNum(arr: unknown, idx: number): number | null {
  if (!Array.isArray(arr)) return null;
  const v = arr[idx];
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function arrNumList(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  for (const v of arr) {
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/* ============================================================
 * stockanalysis.com 爬取（主数据源）
 * ============================================================ */

async function scrapeStockAnalysis(
  ticker: string,
  notes: string[]
): Promise<Partial<StockAnalysisData>> {
  const upper = ticker.toUpperCase();
  const lower = ticker.toLowerCase();

  const [incomeHtml, ratiosHtml, overviewHtml] = await Promise.all([
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/financials/`),
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/financials/ratios/`),
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/`),
  ]);

  const out: Partial<StockAnalysisData> = {};

  // ---- 利润表：营收 / 增长 / 利润率 / 自由现金流 / 负债权益 ----
  if (incomeHtml) {
    const data = extractFinancialData(incomeHtml);
    if (data) {
      const revenue = data.revenue as unknown;
      const revenueGrowth = data.revenueGrowth as unknown;
      const fiscalYear = data.fiscalYear as unknown;
      const datekey = data.datekey as unknown;

      const gm = arrNum(data.grossMargin, 1) ?? arrNum(data.grossMargin, 0);
      const pm = arrNum(data.profitMargin, 1) ?? arrNum(data.profitMargin, 0);
      if (gm != null) out.grossMargin = gm;
      if (pm != null) out.profitMargin = pm;

      const yoy = arrNum(revenueGrowth, 1) ?? arrNum(revenueGrowth, 0);
      if (yoy != null) out.revenueGrowthYoY = yoy;

      const revList = arrNumList(revenue);
      const yearList = Array.isArray(fiscalYear)
        ? fiscalYear.map((y: unknown) => parseInt(String(y), 10))
        : [];
      const dkList = Array.isArray(datekey) ? datekey : [];
      if (revList.length > 0) {
        const history = revList
          .map((rev, i) => ({
            year: Number.isFinite(yearList[i]) ? yearList[i] : NaN,
            revenue: rev,
            isTTM: String(dkList[i] ?? "").toUpperCase() === "TTM",
          }))
          .filter((h) => !h.isTTM && Number.isFinite(h.year))
          .map(({ year, revenue }) => ({ year, revenue }))
          .sort((a, b) => a.year - b.year);
        out.revenueHistory = history;
        out.totalRevenue = arrNum(revenue, 1) ?? arrNum(revenue, 0);
      }

      out.freeCashFlow = arrNum(data.freeCashFlow, 1) ?? arrNum(data.freeCashFlow, 0);
      out.debtToEquity = arrNum(data.debtToEquity, 0) ?? arrNum(data.debtToEquity, 1);

      // 补充：HTML 表格解析绝对财务数字（净利/现金流/债务/现金/股息率）
      const finTbl = parseFinancialTables(incomeHtml);
      if (finTbl.netIncome != null) out.netIncome = finTbl.netIncome;
      if (finTbl.operatingIncome != null) out.operatingIncome = finTbl.operatingIncome;
      if (finTbl.operatingCashFlow != null) out.operatingCashFlow = finTbl.operatingCashFlow;
      if (finTbl.freeCashFlow != null) out.freeCashFlow = finTbl.freeCashFlow;
      if (finTbl.totalDebt != null) out.totalDebt = finTbl.totalDebt;
      if (finTbl.totalCash != null) out.totalCash = finTbl.totalCash;
      if (finTbl.dividendYield != null) out.dividendYield = finTbl.dividendYield;
      if (finTbl.netIncomeHistory?.length) out.netIncomeHistory = finTbl.netIncomeHistory;
      if (finTbl.freeCashFlowHistory?.length)
        out.freeCashFlowHistory = finTbl.freeCashFlowHistory;
      // EV 与 EV/EBIT（stockanalysis 未披露 EBITDA，用 EBIT 替代估值）
      if (
        out.marketCap != null &&
        out.totalDebt != null &&
        out.totalCash != null
      ) {
        out.enterpriseValue = out.marketCap + out.totalDebt - out.totalCash;
      }
      if (
        out.enterpriseValue != null &&
        out.operatingIncome != null &&
        out.operatingIncome > 0
      ) {
        out.evEbit = out.enterpriseValue / out.operatingIncome;
      }
    } else {
      notes.push("stockanalysis.com 利润表数据解析失败。");
    }
  }

  // ---- 比率：PE / 前瞻 PE / PEG / ROE / 市值 ----
  if (ratiosHtml) {
    const data = extractFinancialData(ratiosHtml);
    if (data) {
      out.trailingPE = arrNum(data.pe, 0) ?? arrNum(data.pe, 1);
      out.forwardPE = arrNum(data.peForward, 0) ?? arrNum(data.peForward, 1);
      out.pegRatio = arrNum(data.pegRatio, 0) ?? arrNum(data.pegRatio, 1);
      out.roe = arrNum(data.roe, 0) ?? arrNum(data.roe, 1);
      out.marketCap = arrNum(data.marketCap, 0) ?? arrNum(data.marketCap, 1);
    } else {
      notes.push("stockanalysis.com 比率数据解析失败。");
    }
  }

  // ---- 概览页：现价 / 分析师目标价 / 评级分布 / 名称 / 行业 / 52 周 ----
  if (overviewHtml) {
    const quoteMatch = overviewHtml.match(/quote:\{([^}]+)\}/);
    if (quoteMatch) {
      const m = quoteMatch[1];
      const ep = m.match(/ep:(\d+(?:\.\d+)?)/);
      const p = m.match(/p:(\d+(?:\.\d+)?)/);
      const price = ep?.[1] || p?.[1];
      if (price) out.price = parseFloat(price);
    }

    const analystTargetMatch = overviewHtml.match(/analystTarget:\{([^}]+)\}/);
    if (analystTargetMatch) {
      const m = analystTargetMatch[1];
      const t = m.match(/target:"?\$?([\d.]+)"?/);
      if (t) out.targetMeanPrice = parseFloat(t[1]);
    }

    const analystChartMatch = overviewHtml.match(/analystChart:\{([^}]+)\}/);
    if (analystChartMatch) {
      const m = analystChartMatch[1];
      const total =
        parseInt(m.match(/strongBuy:(\d+)/)?.[1] || "0", 10) +
        parseInt(m.match(/buy:(\d+)/)?.[1] || "0", 10) +
        parseInt(m.match(/hold:(\d+)/)?.[1] || "0", 10) +
        parseInt(m.match(/sell:(\d+)/)?.[1] || "0", 10) +
        parseInt(m.match(/strongSell:(\d+)/)?.[1] || "0", 10);
      if (total > 0) out.numberOfAnalysts = total;
    }

    const analystsMatch = overviewHtml.match(/analysts:"([^"]+)"/);
    if (analystsMatch) {
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
      out.recommendationMean = consensusMap[analystsMatch[1]] ?? null;
    }

    const priceTargetsMatch = overviewHtml.match(/priceTargets:\{([^}]+)\}/);
    if (priceTargetsMatch && out.targetMeanPrice == null) {
      const m = priceTargetsMatch[1];
      const avg = m.match(/avg:(\d+(?:\.\d+)?)/);
      const hi = m.match(/high:(\d+(?:\.\d+)?)/);
      const lo = m.match(/low:(\d+(?:\.\d+)?)/);
      if (avg) out.targetMeanPrice = parseFloat(avg[1]);
      if (hi) out.targetHighPrice = parseFloat(hi[1]);
      if (lo) out.targetLowPrice = parseFloat(lo[1]);
    }

    const nameMatch = overviewHtml.match(/<h1[^>]*>([^<]+)<\/h1>/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (name && !name.toUpperCase().includes(upper)) out.name = name;
    }

    const finData = extractFinancialData(overviewHtml);
    if (finData) {
      const ind =
        finData.industry || finData.sector || finData.gicsSector || finData.gicsIndustry;
      if (ind && typeof ind === "string") out.industry = ind;
    }

    const w52 = overviewHtml.match(/week52:\{([^}]+)\}/);
    if (w52) {
      const m = w52[1];
      const hi = m.match(/high:([\d.]+)/);
      const lo = m.match(/low:([\d.]+)/);
      if (hi) out.week52High = parseFloat(hi[1]);
      if (lo) out.week52Low = parseFloat(lo[1]);
    }
  }

  return out;
}

/* ============================================================
 * 兜底数据源
 * ============================================================ */

/** Yahoo v8 chart 取 52 周高低 + 当年首个交易日收盘价（用于 YTD） */
async function fetchYahoo52w(
  ticker: string
): Promise<{ high: number; low: number; ytdBase: number | null } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=1y&interval=1wk`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const result = d?.chart?.result?.[0];
    const closes: number[] = result?.indicators?.quote?.[0]?.close || [];
    const timestamps: number[] = result?.timestamp || [];
    const vals = closes
      .map((c, i) => ({ c, t: timestamps[i] }))
      .filter((x) => typeof x.c === "number" && !isNaN(x.c));
    if (vals.length === 0) return null;
    const high = Math.max(...vals.map((v) => v.c));
    const low = Math.min(...vals.map((v) => v.c));
    const yearStart =
      new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
    const ytdPoint = vals.find((v) => v.t >= yearStart);
    return { high, low, ytdBase: ytdPoint ? ytdPoint.c : null };
  } catch {
    return null;
  }
}

/** Yahoo Finance RSS 新闻（无需 Key） */
async function fetchYahooNews(ticker: string): Promise<StockReportNews[]> {
  const upper = ticker.toUpperCase();
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(
    upper
  )}&region=US&lang=en-US`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const news = items.slice(0, 12).map((item) => {
      const title =
        item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ??
        item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ??
        "";
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      const pubDate =
        item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
      const desc =
        item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ??
        item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ??
        "";
      const summary = desc.replace(/<[^>]+>/g, "").trim();
      return {
        title: title.trim(),
        source: "Yahoo Finance",
        date: pubDate ? new Date(pubDate).toISOString() : undefined,
        summary: summary || undefined,
        url: link || undefined,
      };
    });
    return news.filter((n) => n.title);
  } catch {
    return [];
  }
}

/* ============================================================
 * Yahoo quoteSummary 补充（绝对财务 / 估值 / 同业）
 * 自包含实现，复用 lib/finance.ts 的 crumb 范式
 * ============================================================ */

let yfCrumb: { crumb: string; cookie: string; expires: number } | null = null;

async function yfGetCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (yfCrumb && yfCrumb.expires > Date.now()) {
    return { crumb: yfCrumb.crumb, cookie: yfCrumb.cookie };
  }
  try {
    const homeRes = await fetch("https://fc-api.yahoo.com/", {
      headers: { "User-Agent": UA },
      redirect: "manual",
    });
    const setCookie = homeRes.headers.get("set-cookie") || "";
    const parts: string[] = [];
    for (const c of setCookie.split(/,\s*(?=[A-Za-z])/)) {
      const m = c.match(/^([^=]+=[^;]+)/);
      if (m) parts.push(m[1]);
    }
    const cookie = parts.join("; ");
    if (!cookie) return null;
    const crumbRes = await fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      { headers: { "User-Agent": UA, Cookie: cookie } }
    );
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length < 4) return null;
    yfCrumb = { crumb, cookie, expires: Date.now() + 5 * 60 * 1000 };
    return { crumb, cookie };
  } catch {
    return null;
  }
}

async function fetchYahooSummary(
  ticker: string,
  modules: string[]
): Promise<Record<string, unknown> | null> {
  const auth = await yfGetCrumb();
  const base = auth
    ? `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
        ticker
      )}?modules=${modules.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`
    : `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
        ticker
      )}?modules=${modules.join(",")}`;
  try {
    const res = await fetch(base, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        ...(auth ? { Cookie: auth.cookie } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      quoteSummary?: { result?: Array<Record<string, unknown>> };
    };
    return d?.quoteSummary?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

/** 取 Yahoo 字段的 raw 值（Yahoo 字段形如 { raw, fmt }） */
function yh(section: unknown, key: string): number | null {
  const obj = section as Record<string, unknown> | undefined;
  if (!obj) return null;
  const raw = obj[key];
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && "raw" in raw) {
    const v = (raw as { raw: unknown }).raw;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** 从 Yahoo 报表的 endDate 取财年 */
function yhYear(stmt: Record<string, unknown>): number | null {
  const raw = (stmt.endDate as { raw?: number } | undefined)?.raw;
  if (typeof raw === "number" && raw > 0) {
    const y = new Date(raw * 1000).getFullYear();
    return Number.isNaN(y) ? null : y;
  }
  return null;
}

async function fetchYahooFundamentals(
  ticker: string,
  notes: string[]
): Promise<Partial<StockAnalysisData>> {
  const summary = await fetchYahooSummary(ticker, [
    "incomeStatementHistory",
    "balanceSheetHistory",
    "cashflowStatementHistory",
    "defaultKeyStatistics",
    "summaryDetail",
    "price",
  ]);
  if (!summary) {
    notes.push("Yahoo 财务补充数据获取失败（quoteSummary 不可用），绝对财务数字可能缺失。");
    return {};
  }
  const out: Partial<StockAnalysisData> = {};

  // 利润表（年度）
  const incomeStmts =
    (
      summary.incomeStatementHistory as
        | { incomeStatementHistory?: Array<Record<string, unknown>> }
        | undefined
    )?.incomeStatementHistory || [];
  if (incomeStmts.length > 0) {
    const latest = incomeStmts[0];
    out.netIncome = yh(latest, "netIncome");
    out.ebitda = yh(latest, "ebitda");
    const niHist = incomeStmts
      .map((s) => ({ year: yhYear(s), value: yh(s, "netIncome") }))
      .filter((x) => x.year != null && x.value != null)
      .map((x) => ({ year: x.year as number, value: x.value as number }));
    if (niHist.length) out.netIncomeHistory = niHist;
  }

  // 现金流（年度）
  const cfStmts =
    (
      summary.cashflowStatementHistory as
        | { cashflowStatements?: Array<Record<string, unknown>> }
        | undefined
    )?.cashflowStatements || [];
  if (cfStmts.length > 0) {
    const latest = cfStmts[0];
    out.operatingCashFlow = yh(latest, "operatingCashFlow");
    out.freeCashFlow = yh(latest, "freeCashFlow");
    const fcfHist = cfStmts
      .map((s) => ({ year: yhYear(s), value: yh(s, "freeCashFlow") }))
      .filter((x) => x.year != null && x.value != null)
      .map((x) => ({ year: x.year as number, value: x.value as number }));
    if (fcfHist.length) out.freeCashFlowHistory = fcfHist;
  }

  // 资产负债表（年度）：现金 / 总债务
  const bsStmts =
    (
      summary.balanceSheetHistory as
        | { balanceSheetStatements?: Array<Record<string, unknown>> }
        | undefined
    )?.balanceSheetStatements || [];
  if (bsStmts.length > 0) {
    const latest = bsStmts[0];
    const cash = yh(latest, "cash");
    const sti = yh(latest, "shortTermInvestments");
    out.totalCash =
      cash != null && sti != null ? cash + sti : cash ?? sti;
    const ltd = yh(latest, "longTermDebt");
    const std = yh(latest, "shortTermDebt") ?? yh(latest, "currentDebt");
    out.totalDebt = ltd != null && std != null ? ltd + std : ltd ?? std;
  }

  // defaultKeyStatistics
  const dks = summary.defaultKeyStatistics as Record<string, unknown> | undefined;
  if (dks) {
    out.enterpriseValue = yh(dks, "enterpriseValue");
    out.dividendYield = yh(dks, "dividendYield");
    out.trailingEps = yh(dks, "trailingEps");
    out.forwardEps = yh(dks, "forwardEps");
    if (out.ebitda == null) out.ebitda = yh(dks, "ebitda");
    if (out.totalDebt == null) out.totalDebt = yh(dks, "totalDebt");
    const ete = yh(dks, "enterpriseToEbitda");
    if (ete != null) out.evEbitda = ete;
  }

  // summaryDetail 兜底
  const sd = summary.summaryDetail as Record<string, unknown> | undefined;
  if (sd) {
    if (out.dividendYield == null) out.dividendYield = yh(sd, "dividendYield");
    if (out.trailingPE == null) out.trailingPE = yh(sd, "trailingPE");
    if (out.forwardPE == null) out.forwardPE = yh(sd, "forwardPE");
    if (out.marketCap == null) out.marketCap = yh(sd, "marketCap");
    if (out.week52High == null) out.week52High = yh(sd, "fiftyTwoWeekHigh");
    if (out.week52Low == null) out.week52Low = yh(sd, "fiftyTwoWeekLow");
    if (out.targetMeanPrice == null) out.targetMeanPrice = yh(sd, "targetMeanPrice");
  }

  // price 模块：52 周、名称
  const priceMod = summary.price as Record<string, unknown> | undefined;
  if (priceMod) {
    if (out.week52High == null) out.week52High = yh(priceMod, "fiftyTwoWeekHigh");
    if (out.week52Low == null) out.week52Low = yh(priceMod, "fiftyTwoWeekLow");
    if (!out.name) {
      const nm = priceMod.shortName ?? priceMod.longName;
      if (typeof nm === "string") out.name = nm;
    }
  }

  // 计算 EV/EBITDA（若 Yahoo 未直接给）
  if (out.evEbitda == null && out.ebitda != null && out.ebitda > 0) {
    const ev =
      out.enterpriseValue ??
      (out.marketCap != null
        ? out.marketCap + (out.totalDebt ?? 0) - (out.totalCash ?? 0)
        : null);
    if (ev != null) out.evEbitda = ev / out.ebitda;
  }

  return out;
}

/* —— 同业对比（按行业分组抓取关键估值指标） —— */

const PEER_GROUPS: Record<string, string[]> = {
  utilities: ["VST", "NRG", "TLN", "AEP", "DUK", "NEE"],
  renewable: ["VST", "NRG", "TLN", "NEE", "ENPH", "FSLR"],
  semiconductor: ["NVDA", "AMD", "AVGO", "TSM", "QCOM", "INTC", "MU"],
  software: ["MSFT", "ORCL", "CRM", "NOW", "ADBE", "INTU"],
  internet: ["GOOGL", "META", "SNAP", "BIDU", "TWLO"],
  auto: ["TSLA", "F", "GM", "RIVN", "LCID"],
  bank: ["JPM", "BAC", "WFC", "C", "GS"],
  retail: ["AMZN", "WMT", "COST", "TGT", "HD"],
  biotech: ["AMGN", "GILD", "VRTX", "REGN", "MRNA"],
  pharmaceutical: ["PFE", "MRK", "ABBV", "LLY", "BMY"],
  energy: ["XOM", "CVX", "COP", "SLB", "EOG"],
  payments: ["V", "MA", "PYPL", "AXP", "SQ"],
  telecom: ["T", "VZ", "TMUS", "CHTR"],
  airline: ["DAL", "AAL", "UAL", "LUV"],
  reit: ["AMT", "PLD", "O", "SPG", "EQIX"],
  cloud: ["AMZN", "MSFT", "GOOGL", "CRM", "NET"],
};

function pickPeerGroup(industry: string | null | undefined): string[] | null {
  if (!industry) return null;
  const s = industry.toLowerCase();
  let best: string | null = null;
  let bestLen = 0;
  for (const key of Object.keys(PEER_GROUPS)) {
    if (s.includes(key) && key.length > bestLen) {
      best = key;
      bestLen = key.length;
    }
  }
  return best ? PEER_GROUPS[best] : null;
}

async function scrapePeer(ticker: string): Promise<PeerComparison | null> {
  const summary = await fetchYahooSummary(ticker, [
    "price",
    "summaryDetail",
    "defaultKeyStatistics",
  ]);
  if (!summary) return null;
  const priceMod = summary.price as Record<string, unknown> | undefined;
  const sd = summary.summaryDetail as Record<string, unknown> | undefined;
  const dks = summary.defaultKeyStatistics as Record<string, unknown> | undefined;
  const name =
    (typeof priceMod?.shortName === "string" ? priceMod.shortName : null) ??
    (typeof priceMod?.longName === "string" ? priceMod.longName : null);
  const pe = yh(sd, "trailingPE") ?? yh(dks, "trailingPE");
  const fpe = yh(sd, "forwardPE") ?? yh(dks, "forwardPE");
  const mc = yh(sd, "marketCap") ?? yh(dks, "marketCap");
  const ev = yh(dks, "enterpriseValue");
  const td = yh(dks, "totalDebt");
  const ebitda = yh(dks, "ebitda");
  const target = yh(sd, "targetMeanPrice") ?? yh(dks, "targetMeanPrice");
  let evEbitda = yh(dks, "enterpriseToEbitda");
  if (evEbitda == null && ebitda != null && ebitda > 0) {
    const evCalc = ev ?? (mc != null ? mc + (td ?? 0) : null);
    if (evCalc != null) evEbitda = evCalc / ebitda;
  }
  return {
    ticker,
    name,
    price: yh(priceMod, "regularMarketPrice"),
    marketCap: mc,
    trailingPE: pe,
    forwardPE: fpe,
    evEbitda,
    targetMeanPrice: target,
  };
}

async function scrapePeers(
  ticker: string,
  industry: string | null | undefined,
  notes: string[]
): Promise<PeerComparison[] | null> {
  const group = pickPeerGroup(industry);
  if (!group) return null;
  const peers = group
    .filter((t) => t.toUpperCase() !== ticker.toUpperCase())
    .slice(0, 5);
  if (peers.length === 0) return null;
  const results = await Promise.all(
    peers.map((t) => scrapePeer(t).catch(() => null))
  );
  const valid = results.filter((r): r is PeerComparison => r != null);
  if (valid.length === 0) {
    notes.push("同业对标数据获取失败，已跳过同业对比。");
    return null;
  }
  return valid;
}

/* ============================================================
 * 聚合数据
 * ============================================================ */

export async function getStockAnalysisData(
  ticker: string
): Promise<StockAnalysisData> {
  const notes: string[] = [];
  const upper = ticker.toUpperCase();

  const [sa, quote, technical, news] = await Promise.all([
    scrapeStockAnalysis(upper, notes),
    fetchQuote(upper).catch(() => null),
    fetchTradingViewTechnicals(upper).catch(() => null),
    fetchYahooNews(upper),
  ]);

  const data: StockAnalysisData = {
    ticker: upper,
    ...sa,
    news,
    notes,
    technical: technical ?? null,
  };

  if (quote) {
    if (data.price == null) data.price = quote.price;
    data.changePercent = quote.changePercent;
    data.currency = quote.currency;
    if (!data.name && quote.name) data.name = quote.name;
  }

  // 52 周兜底 + YTD 基准
  let ytdBase: number | null = null;
  if (
    data.week52High == null ||
    data.week52Low == null ||
    data.ytdPercent == null
  ) {
    const w52 = await fetchYahoo52w(upper);
    if (w52) {
      if (data.week52High == null) data.week52High = w52.high;
      if (data.week52Low == null) data.week52Low = w52.low;
      ytdBase = w52.ytdBase;
    }
  }
  if (data.price != null && ytdBase != null) {
    data.ytdPercent = (data.price / ytdBase - 1) * 100;
  }

  // Yahoo 财务补充：仅作 stockanalysis 的兜底（当前环境 Yahoo crumb 常被封，多数取不到）。
  // stockanalysis 为主源，仅当对应字段缺失时才用 Yahoo 值覆盖。
  const yf = await fetchYahooFundamentals(upper, notes).catch(
    () => ({}) as Partial<StockAnalysisData>
  );
  const yfKeys: (keyof StockAnalysisData)[] = [
    "netIncome",
    "operatingIncome",
    "ebitda",
    "operatingCashFlow",
    "freeCashFlow",
    "totalCash",
    "totalDebt",
    "enterpriseValue",
    "evEbitda",
    "dividendYield",
    "trailingEps",
    "forwardEps",
    "netIncomeHistory",
    "freeCashFlowHistory",
  ];
  for (const k of yfKeys) {
    const v = (yf as unknown as Record<string, unknown>)[k];
    const dataRec = data as unknown as Record<string, unknown>;
    if (v != null && dataRec[k] == null) {
      dataRec[k] = v;
    }
  }

  // 同业对比
  const peers = await scrapePeers(upper, data.industry, notes).catch(
    () => null as PeerComparison[] | null
  );
  if (peers) data.peers = peers;

  return data;
}

/* ============================================================
 * 报告生成（us-stock-analysis 框架）
 * ============================================================ */

function buildReportPrompt(data: StockAnalysisData): {
  system: string;
  user: string;
} {
  const system = `你是一名资深美股证券分析师。请基于提供的真实财务与技术数据，撰写一份结构化综合分析报告。
要求：
1. 必须严格基于提供的数据，不得编造数字；数据缺失的字段可基于公开常识合理推断，但须注明"（基于公开信息推断）"。
2. 报告使用 Markdown 格式，必须包含以下章节（顺序固定）：
## 执行摘要
## 公司概览
## 投资论点
（使用 ### 看多理由 与 ### 看空理由 两个小节）
## 基本面分析
（必须先用一张"关键财务数据"表格列出：营业收入、净利润、EBITDA(或 EBIT)、经营现金流、自由现金流、毛利率、净利率、ROE、总债务、现金；尽量使用提供的绝对数字，缺失则写"—"）
## 现金流与资产负债表分析
（结合自由现金流历史趋势、资本开支、债务水平与偿债能力展开；若提供了 netIncomeHistory / freeCashFlowHistory，请用文字描述其趋势）
## 业务质量与护城河
（基于提供的新闻标题与公开信息，分析商业模式、竞争壁垒、长期合约/客户结构；信息缺失处标注"（基于公开信息推断）"）
## 估值分析
（必须使用 PE、前瞻 PE、EV/EBITDA 或 EV/EBIT、PEG 等指标；结合 52 周区间与 YTD 涨跌幅给出相对行业/历史估值的溢价或折价判断；若有 forwardEps / 管理层指引相关新闻，可推导 EPS 增速与 PEG。注意：若数据中 ebitda 为 null 但 evEbit 有值，说明数据源未披露 EBITDA，请用 EV/EBIT 替代，并在文中注明"因数据源未披露 EBITDA，采用 EV/EBIT（该倍数因不含折旧摊销而天然偏高）"）
## 同业估值对比
（若数据中包含 peers 数组，必须用表格对比本公司及同业的关键指标——市值、TTM PE、前瞻 PE、EV/EBITDA、分析师目标价——并点评相对估值高低）
## 技术分析
## 风险评估
## 催化剂与时间线
## 投资建议
（含评级、12 个月目标价区间、建仓/加仓/止损策略；目标价需结合估值与同业水平给出依据）
## 结论
3. 全文中文，专业、客观、可执行。所有结论须有数据或逻辑支撑，避免空话。报告末尾用 "> ⚠️" 引用块给出风险提示，声明非投资建议。`;

  const dataJson = JSON.stringify(
    {
      ticker: data.ticker,
      name: data.name,
      price: data.price,
      changePercent: data.changePercent,
      ytdPercent: data.ytdPercent,
      currency: data.currency,
      marketCap: data.marketCap,
      week52High: data.week52High,
      week52Low: data.week52Low,
      industry: data.industry,
      trailingPE: data.trailingPE,
      forwardPE: data.forwardPE,
      evEbitda: data.evEbitda,
      pegRatio: data.pegRatio,
      enterpriseValue: data.enterpriseValue,
      dividendYield: data.dividendYield,
      trailingEps: data.trailingEps,
      forwardEps: data.forwardEps,
      roe: data.roe,
      grossMargin: data.grossMargin,
      profitMargin: data.profitMargin,
      revenueGrowthYoY: data.revenueGrowthYoY,
      totalRevenue: data.totalRevenue,
      revenueHistory: data.revenueHistory,
      netIncome: data.netIncome,
      operatingIncome: data.operatingIncome,
      ebitda: data.ebitda,
      evEbit: data.evEbit,
      operatingCashFlow: data.operatingCashFlow,
      freeCashFlow: data.freeCashFlow,
      netIncomeHistory: data.netIncomeHistory,
      freeCashFlowHistory: data.freeCashFlowHistory,
      totalCash: data.totalCash,
      totalDebt: data.totalDebt,
      debtToEquity: data.debtToEquity,
      targetMeanPrice: data.targetMeanPrice,
      targetHighPrice: data.targetHighPrice,
      targetLowPrice: data.targetLowPrice,
      recommendationMean: data.recommendationMean,
      numberOfAnalysts: data.numberOfAnalysts,
      technicalSignals: data.technical
        ? {
            overall: SIGNAL_LABELS[data.technical.overall],
            oscillators: SIGNAL_LABELS[data.technical.oscillators],
            movingAverages: SIGNAL_LABELS[data.technical.movingAverages],
          }
        : null,
      peers: (data.peers || []).map((p) => ({
        ticker: p.ticker,
        name: p.name,
        price: p.price,
        marketCap: p.marketCap,
        trailingPE: p.trailingPE,
        forwardPE: p.forwardPE,
        evEbitda: p.evEbitda,
        targetMeanPrice: p.targetMeanPrice,
      })),
      news: (data.news || []).slice(0, 8).map((n) => ({
        title: n.title,
        date: n.date,
      })),
    },
    null,
    2
  );

  const user = `标的：${data.ticker}${
    data.name ? "（" + data.name + "）" : ""
  }
以下为实时抓取数据（部分字段可能缺失，缺失即视为无数据）：
\`\`\`json
${dataJson}
\`\`\`
请按系统指令输出完整报告。`;

  return { system, user };
}

/** 校验美股 ticker（字母码，可选 .交易所 后缀用于 ADR） */
export function isValidUSTicker(ticker: string): boolean {
  return /^[A-Z]{1,5}(\.[A-Z]{1,4})?$/.test(ticker.trim().toUpperCase());
}

export async function generateStockReport(ticker: string): Promise<StockReport> {
  const clean = ticker.trim().toUpperCase();
  if (!isValidUSTicker(clean)) {
    throw new Error("无效的股票代码（美股应为字母代码，如 AAPL）");
  }

  const data = await getStockAnalysisData(clean);
  const { system, user } = buildReportPrompt(data);

  const res = await chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.3, maxTokens: 4000 }
  );

  // 落库（失败不应阻断返回，仅记录）
  try {
    await saveStockReport(clean, data.name, res.text, data);
  } catch (e) {
    console.error("[stock-report] 落库失败:", e);
  }

  return {
    ticker: clean,
    report: res.text,
    data,
    generatedAt: new Date().toISOString(),
  };
}

/* ============================================================
 * 数据库持久化（StockReport 表）
 * ============================================================ */

/** 生成后 upsert 保存；同一 ticker 只保留最新一份 */
export async function saveStockReport(
  ticker: string,
  name: string | null | undefined,
  report: string,
  data: StockAnalysisData
): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) return; // 未配置数据库时跳过落库
  const dataJson = JSON.stringify(data);
  await prisma.stockReport.upsert({
    where: { ticker },
    create: { ticker, name: name ?? null, report, dataJson },
    update: { name: name ?? null, report, dataJson, updatedAt: new Date() },
  });
}

/** 读取已保存的报告（含完整 data）；无则返回 null */
export async function getSavedReport(ticker: string): Promise<StockReport | null> {
  const prisma = getPrisma();
  if (!prisma) return null;
  const row = await prisma.stockReport.findUnique({ where: { ticker } });
  if (!row) return null;
  let data: StockAnalysisData = { ticker: row.ticker, name: row.name };
  try {
    const parsed = JSON.parse(row.dataJson) as StockAnalysisData;
    if (parsed && typeof parsed === "object") data = parsed;
  } catch {
    // dataJson 损坏时降级为仅 ticker/name
  }
  return {
    ticker: row.ticker,
    report: row.report,
    data,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/** 批量判断一组 ticker 是否已生成报告，返回 { ticker: generatedAt } 映射 */
export async function getReportsExist(
  tickers: string[]
): Promise<Record<string, string>> {
  const clean = Array.from(
    new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))
  );
  if (clean.length === 0) return {};
  const prisma = getPrisma();
  if (!prisma) return {};
  const rows = await prisma.stockReport.findMany({
    where: { ticker: { in: clean } },
    select: { ticker: true, generatedAt: true },
  });
  const map: Record<string, string> = {};
  for (const r of rows) map[r.ticker] = r.generatedAt.toISOString();
  return map;
}
