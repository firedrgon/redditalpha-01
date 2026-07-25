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
  currentRatio?: number | null;
  freeCashFlow?: number | null;
  targetMeanPrice?: number | null;
  targetHighPrice?: number | null;
  targetLowPrice?: number | null;
  recommendationMean?: number | null; // 1=强烈买入 ... 5=强烈卖出
  numberOfAnalysts?: number | null;
  /** 分析师评级分布（强买/买/持/卖/强卖家数），用于给出"买入占比"等共识判断 */
  analystRatings?: {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  } | null;
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
  /** 下次财报披露日期（来自 stockanalysis 概览页 "Earnings Date"，ISO 格式 YYYY-MM-DD） */
  nextEarningsDate?: string | null;
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

/**
 * 通用财务报表表格解析引擎：从 stockanalysis.com 财务报表 HTML 中提取行名与按列对齐的数值。
 * 兼容两种表头结构：
 *  - 表头含名称列（如 ["Fiscal Year","TTM","FY 2025",...]）→ 数据值列从 index 0 对齐（offset=0）
 *  - 表头直接以周期开头（如 ["TTM","FY 2025",...]）→ 数据行首列为名称，值列整体右移一位（offset=1）
 * 列类型支持 TTM / CURRENT / 具体财年，提供 pickValue(current|latestFY) 与 history。
 */
type ColKind = number | "TTM" | "CURRENT" | null;

interface TableCore {
  rows: string[][];
  colKinds: ColKind[];
  offset: number;
  findRow: (re: RegExp) => string[] | null;
  pickValue: (row: string[], prefer: "current" | "latestFY") => number | null;
  history: (row: string[]) => Array<{ year: number; value: number }>;
}

function tableCore(html: string): TableCore | null {
  const rowsMatch = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  if (rowsMatch.length === 0) return null;
  const rows = rowsMatch.map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      c[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
    )
  );

  let header: string[] = [];
  for (const r of rows) {
    if (
      r.some(
        (c) =>
          /^FY\s*\d{4}$/i.test(c.trim()) ||
          c.trim().toUpperCase() === "TTM" ||
          /fiscal year/i.test(c.trim())
      )
    ) {
      header = r;
      break;
    }
  }
  if (header.length === 0) return null;

  // 表头首列若是 "Fiscal Year"/"Period" 这类名称列，则数据值列与表头列一一对应（offset=0）；
  // 否则表头首列就是周期（TTM/FY），数据行首列为名称，值列需整体右移一位（offset=1）。
  const offset = /fiscal year|period/i.test(header[0]?.trim() || "") ? 0 : 1;

  const colKinds: ColKind[] = header.map((c) => {
    const t = c.trim();
    if (t.toUpperCase() === "TTM") return "TTM";
    if (t.toUpperCase() === "CURRENT") return "CURRENT";
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

  const pickValue = (
    row: string[],
    prefer: "current" | "latestFY"
  ): number | null => {
    if (!row) return null;
    if (prefer === "current") {
      for (let k = 0; k < colKinds.length; k++) {
        if (colKinds[k] === "TTM" || colKinds[k] === "CURRENT") {
          const v = toNum(row[offset + k]);
          if (v != null) return v;
        }
      }
    }
    let best: number | null = null;
    let bestYear = -1;
    for (let k = 0; k < colKinds.length; k++) {
      const y = colKinds[k];
      if (typeof y === "number" && y > bestYear) {
        const v = toNum(row[offset + k]);
        if (v != null) {
          bestYear = y;
          best = v;
        }
      }
    }
    if (best != null) return best;
    for (let k = 0; k < colKinds.length; k++) {
      if (colKinds[k] === "TTM" || colKinds[k] === "CURRENT") {
        const v = toNum(row[offset + k]);
        if (v != null) return v;
      }
    }
    return null;
  };

  const history = (
    row: string[]
  ): Array<{ year: number; value: number }> => {
    const out: Array<{ year: number; value: number }> = [];
    if (!row) return out;
    for (let k = 0; k < colKinds.length; k++) {
      const y = colKinds[k];
      if (typeof y === "number") {
        const v = toNum(row[offset + k]);
        if (v != null) out.push({ year: y, value: v });
      }
    }
    return out.sort((a, b) => a.year - b.year);
  };

  return { rows, colKinds, offset, findRow, pickValue, history };
}

/**
 * 解析 stockanalysis.com 财务表（利润表 / 资产负债表），提取绝对财务数字。
 * 数值单位统一为美元绝对值（表格内为百万美元，×1e6），与 marketCap 口径一致；
 * 利润率 / 股息率为小数（百分比 ÷100）。
 * 注意：stockanalysis 财务表不含 EBITDA / 折旧摊销行，故不在此提取 EBITDA。
 */
function parseFinancialTables(html: string): {
  revenue?: number | null;
  netIncome?: number | null;
  operatingIncome?: number | null;
  operatingCashFlow?: number | null;
  freeCashFlow?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;
  grossMargin?: number | null;
  profitMargin?: number | null;
  dividendYield?: number | null;
  revenueHistory?: Array<{ year: number; revenue: number }>;
  netIncomeHistory?: Array<{ year: number; value: number }>;
  freeCashFlowHistory?: Array<{ year: number; value: number }>;
} {
  const core = tableCore(html);
  if (!core) return {};
  const { findRow, pickValue, history } = core;
  const MILLION = 1e6;
  const out: Record<string, unknown> = {};

  const rev = findRow(/^revenue\s*$/i);
  if (rev) {
    const v = pickValue(rev, "latestFY");
    if (v != null) out.revenue = v * MILLION;
    out.revenueHistory = history(rev).map((h) => ({
      year: h.year,
      revenue: h.value * MILLION,
    }));
  }

  const ni = findRow(/net income/i);
  if (ni) {
    const v = pickValue(ni, "latestFY");
    if (v != null) out.netIncome = v * MILLION;
    out.netIncomeHistory = history(ni).map((h) => ({
      year: h.year,
      value: h.value * MILLION,
    }));
  }

  const oi = findRow(/operating income/i);
  if (oi) {
    const v = pickValue(oi, "latestFY");
    if (v != null) out.operatingIncome = v * MILLION;
  }

  const ocf = findRow(/operating cash flow/i);
  if (ocf) {
    const v = pickValue(ocf, "latestFY");
    if (v != null) out.operatingCashFlow = v * MILLION;
  }

  const fcf = findRow(/free cash flow/i);
  if (fcf) {
    const v = pickValue(fcf, "latestFY");
    if (v != null) out.freeCashFlow = v * MILLION;
    out.freeCashFlowHistory = history(fcf).map((h) => ({
      year: h.year,
      value: h.value * MILLION,
    }));
  }

  const td = findRow(/total debt/i);
  if (td) {
    const v = pickValue(td, "latestFY");
    if (v != null) out.totalDebt = v * MILLION;
  }

  const cash =
    findRow(/cash & (short-term investments|equivalents|investments)/i) ||
    findRow(/^cash\b/i);
  if (cash) {
    const v = pickValue(cash, "latestFY");
    if (v != null) out.totalCash = v * MILLION;
  }

  const gm = findRow(/gross margin/i);
  if (gm) {
    const v = pickValue(gm, "latestFY");
    if (v != null) out.grossMargin = v / 100;
  }
  const pm = findRow(/profit margin/i);
  if (pm) {
    const v = pickValue(pm, "latestFY");
    if (v != null) out.profitMargin = v / 100;
  }

  const dy = findRow(/dividend yield/i);
  if (dy) {
    const v = pickValue(dy, "latestFY");
    if (v != null) out.dividendYield = v / 100;
  }

  return out as {
    revenue?: number | null;
    netIncome?: number | null;
    operatingIncome?: number | null;
    operatingCashFlow?: number | null;
    freeCashFlow?: number | null;
    totalDebt?: number | null;
    totalCash?: number | null;
    grossMargin?: number | null;
    profitMargin?: number | null;
    dividendYield?: number | null;
    revenueHistory?: Array<{ year: number; revenue: number }>;
    netIncomeHistory?: Array<{ year: number; value: number }>;
    freeCashFlowHistory?: Array<{ year: number; value: number }>;
  };
}

/**
 * 解析 stockanalysis.com 比率表（/financials/ratios/），提取估值与质量指标。
 * 优先取 "Current"（最新）列；市值 / 企业价值为百万单位，需 ×1e6。
 */
function parseRatiosTable(html: string): {
  trailingPE?: number | null;
  forwardPE?: number | null;
  pegRatio?: number | null;
  roe?: number | null;
  marketCap?: number | null;
  enterpriseValue?: number | null;
  evEbitda?: number | null;
  evEbit?: number | null;
  dividendYield?: number | null;
  currentRatio?: number | null;
  debtToEquity?: number | null;
} {
  const core = tableCore(html);
  if (!core) return {};
  const { findRow, pickValue } = core;
  const MILLION = 1e6;
  const out: Record<string, unknown> = {};

  const pe = findRow(/pe ratio|p\/e ratio/i);
  if (pe) out.trailingPE = pickValue(pe, "current");

  const fpe = findRow(/forward\s*p\s*\/?\s*e/i);
  if (fpe) out.forwardPE = pickValue(fpe, "current");

  const peg = findRow(/peg ratio|^peg\b/i);
  if (peg) out.pegRatio = pickValue(peg, "current");

  const roe = findRow(/return on equity|\(roe\)|\broe\b/i);
  if (roe) {
    const v = pickValue(roe, "current");
    if (v != null) out.roe = v / 100;
  }

  const mc = findRow(/market cap/i);
  if (mc) {
    const v = pickValue(mc, "current");
    if (v != null) out.marketCap = v * MILLION;
  }

  const ev = findRow(/enterprise value/i);
  if (ev) {
    const v = pickValue(ev, "current");
    if (v != null) out.enterpriseValue = v * MILLION;
  }

  const evebitda = findRow(/ev\/ebitda/i);
  if (evebitda) out.evEbitda = pickValue(evebitda, "current");

  const evebit = findRow(/ev\/ebit\b/i);
  if (evebit) out.evEbit = pickValue(evebit, "current");

  const dy = findRow(/dividend yield/i);
  if (dy) {
    const v = pickValue(dy, "current");
    if (v != null) out.dividendYield = v / 100;
  }

  const cr = findRow(/current ratio/i);
  if (cr) out.currentRatio = pickValue(cr, "current");

  const de = findRow(/debt\s*\/\s*equity/i);
  if (de) out.debtToEquity = pickValue(de, "current");

  return out as {
    trailingPE?: number | null;
    forwardPE?: number | null;
    pegRatio?: number | null;
    roe?: number | null;
    marketCap?: number | null;
    enterpriseValue?: number | null;
    evEbitda?: number | null;
    evEbit?: number | null;
    dividendYield?: number | null;
    currentRatio?: number | null;
    debtToEquity?: number | null;
  };
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

  const [incomeHtml, ratiosHtml, overviewHtml, balanceHtml] = await Promise.all([
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/financials/`),
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/financials/ratios/`),
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/`),
    fetchSAPage(
      `https://stockanalysis.com/stocks/${lower}/financials/balance-sheet/`
    ),
  ]);

  const out: Partial<StockAnalysisData> = {};

  // ---- 利润表：营收 / 增长 / 利润率 / 自由现金流 / 负债权益 ----
  // ---- 利润表 + 资产负债表：HTML 表格解析绝对财务数字（主源，不依赖内嵌 JS 对象） ----
  if (incomeHtml) {
    const fin = parseFinancialTables(incomeHtml);
    if (Object.keys(fin).length > 0) {
      if (fin.revenue != null) out.totalRevenue = fin.revenue;
      if (fin.revenueHistory) out.revenueHistory = fin.revenueHistory;
      if (fin.netIncome != null) out.netIncome = fin.netIncome;
      if (fin.netIncomeHistory) out.netIncomeHistory = fin.netIncomeHistory;
      if (fin.operatingIncome != null) out.operatingIncome = fin.operatingIncome;
      if (fin.operatingCashFlow != null) out.operatingCashFlow = fin.operatingCashFlow;
      if (fin.freeCashFlow != null) out.freeCashFlow = fin.freeCashFlow;
      if (fin.freeCashFlowHistory) out.freeCashFlowHistory = fin.freeCashFlowHistory;
      if (fin.grossMargin != null) out.grossMargin = fin.grossMargin;
      if (fin.profitMargin != null) out.profitMargin = fin.profitMargin;
      // 营收同比增长：用最近两个财年推算
      if (fin.revenueHistory && fin.revenueHistory.length >= 2) {
        const last = fin.revenueHistory[fin.revenueHistory.length - 1];
        const prev = fin.revenueHistory[fin.revenueHistory.length - 2];
        if (prev.revenue > 0)
          out.revenueGrowthYoY = (last.revenue / prev.revenue - 1) * 100;
      }
    } else {
      notes.push("stockanalysis.com 利润表数据解析失败。");
    }
  }

  if (balanceHtml) {
    const bs = parseFinancialTables(balanceHtml);
    if (bs.totalCash != null) out.totalCash = bs.totalCash;
    if (bs.totalDebt != null) out.totalDebt = bs.totalDebt;
  }

  // ---- 比率：PE / 前瞻 PE / PEG / ROE / 市值 / EV / EV-EBITDA（HTML 表格解析） ----
  if (ratiosHtml) {
    const r = parseRatiosTable(ratiosHtml);
    if (Object.keys(r).length > 0) {
      if (r.trailingPE != null) out.trailingPE = r.trailingPE;
      if (r.forwardPE != null) out.forwardPE = r.forwardPE;
      if (r.pegRatio != null) out.pegRatio = r.pegRatio;
      if (r.roe != null) out.roe = r.roe;
      if (r.marketCap != null) out.marketCap = r.marketCap;
      if (r.enterpriseValue != null) out.enterpriseValue = r.enterpriseValue;
      if (r.evEbitda != null) out.evEbitda = r.evEbitda;
      if (r.evEbit != null) out.evEbit = r.evEbit;
      if (r.dividendYield != null) out.dividendYield = r.dividendYield;
      if (r.currentRatio != null) out.currentRatio = r.currentRatio;
      if (r.debtToEquity != null) out.debtToEquity = r.debtToEquity;
    } else {
      notes.push("stockanalysis.com 比率数据解析失败。");
    }
  }

  // ---- EV / EV-EBIT 兜底计算（比率页未直接给 EV 时，用 市值+债-现金 估算） ----
  if (out.operatingIncome != null && out.operatingIncome > 0) {
    const ev =
      out.enterpriseValue ??
      (out.marketCap != null
        ? out.marketCap + (out.totalDebt ?? 0) - (out.totalCash ?? 0)
        : null);
    if (ev != null) {
      out.enterpriseValue = out.enterpriseValue ?? ev;
      if (out.evEbit == null) out.evEbit = ev / out.operatingIncome;
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
      const strongBuy = parseInt(m.match(/strongBuy:(\d+)/)?.[1] || "0", 10);
      const buy = parseInt(m.match(/buy:(\d+)/)?.[1] || "0", 10);
      const hold = parseInt(m.match(/hold:(\d+)/)?.[1] || "0", 10);
      const sell = parseInt(m.match(/sell:(\d+)/)?.[1] || "0", 10);
      const strongSell = parseInt(m.match(/strongSell:(\d+)/)?.[1] || "0", 10);
      const total = strongBuy + buy + hold + sell + strongSell;
      if (total > 0) {
        out.numberOfAnalysts = total;
        out.analystRatings = { strongBuy, buy, hold, sell, strongSell };
      }
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

    // 行业：从概览页 /industry/.../ 链接还原（stockanalysis 改版后内嵌 industry 字段已失效）
    const indMatch = overviewHtml.match(/industry\/([a-z0-9-]+)\//i);
    if (indMatch) {
      const human = indMatch[1]
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      out.industry = human;
    }

    const w52 = overviewHtml.match(/week52:\{([^}]+)\}/);
    if (w52) {
      const m = w52[1];
      const hi = m.match(/high:([\d.]+)/);
      const lo = m.match(/low:([\d.]+)/);
      if (hi) out.week52High = parseFloat(hi[1]);
      if (lo) out.week52Low = parseFloat(lo[1]);
    }

    // 下次财报日期：stockanalysis 概览页以 "Earnings Date" 标签展示，紧邻日期文本
    const earningsDateMatch = overviewHtml.match(
      /Earnings Date[\s\S]{0,140}?([A-Z][a-z]{2}\s+\d{1,2},?\s*\d{4})/
    );
    if (earningsDateMatch) {
      const d = new Date(earningsDateMatch[1]);
      if (!isNaN(d.getTime())) {
        out.nextEarningsDate = d.toISOString().slice(0, 10); // YYYY-MM-DD
      }
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
  const lower = ticker.toLowerCase();
  const [ratiosHtml, overviewHtml] = await Promise.all([
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/financials/ratios/`),
    fetchSAPage(`https://stockanalysis.com/stocks/${lower}/`),
  ]);
  const r = ratiosHtml ? parseRatiosTable(ratiosHtml) : {};
  const nameMatch = overviewHtml?.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const name = nameMatch ? nameMatch[1].trim() : null;
  // 分析师目标价：从概览页 analystTarget:{...} 内联对象提取
  let target: number | null = null;
  const tMatch = overviewHtml?.match(
    /analystTarget:\{[^}]*?target["']?\s*:\s*"?\$?([\d.]+)/
  );
  if (tMatch) target = parseFloat(tMatch[1]);

  if (
    r.marketCap == null &&
    r.trailingPE == null &&
    r.evEbitda == null &&
    target == null
  ) {
    return null;
  }
  return {
    ticker: ticker.toUpperCase(),
    name,
    price: null,
    marketCap: r.marketCap ?? null,
    trailingPE: r.trailingPE ?? null,
    forwardPE: r.forwardPE ?? null,
    evEbitda: r.evEbitda ?? null,
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

  // 注：Yahoo quoteSummary 在当前环境（含 Vercel 数据中心 IP）被 crumb 鉴权封锁，
  // 已不再作为兜底；stockanalysis.com 财务表解析为唯一主数据源。

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
  const system = `你是一名资深美股证券分析师。请基于提供的真实财务与技术数据，撰写一份结构化、完整的综合分析报告。报告须覆盖以下所有章节，每节精炼要点、避免冗长与重复，确保在 token 预算内完整输出至结尾（不得中途截断）。

要求：
1. 必须严格基于提供的数据，不得编造精确财务数字；数据缺失的字段可基于你的公开领域知识合理补充定性事实（如行业地位、主要客户/长期购电协议、近期重大并购或事件、管理层动向），但须注明"（基于公开信息）"。特别地，装机容量、产能、用户数等绝对规模数字，若数据未提供，禁止用"占比/市场份额"反推具体 GW 或数量，应标注"以公司官方披露为准（基于公开信息）"。
2. 报告使用 Markdown 格式，必须包含以下章节（顺序固定，每节精炼要点、避免冗长与重复，确保整篇在 token 预算内完整输出至结尾，不得中途截断）：
## 执行摘要
（含：公司一句话定位、核心投资逻辑、关键风险、评级与目标价预览）
## 投资论点
（### 看多理由 与 ### 看空理由 两个小节，各列 3–5 条，带具体事实与数据支撑）
## 业务质量与护城河
（基于提供的新闻标题与公开信息，分析：①护城河类型与强度 ②管理层资本配置与执行力 ③商业模式可持续性；信息缺失处标注"（基于公开信息）"）
## 估值分析
（必须使用 PE、前瞻 PE、EV/EBITDA 或 EV/EBIT、PEG、P/B、P/S 等指标；结合 52 周区间与 YTD 涨跌幅给出相对行业/历史的溢价或折价判断；若提供 forwardEps / 管理层指引相关新闻，可推导 EPS 增速与 PEG；若数据含 targetMeanPrice / targetHighPrice / targetLowPrice 与 analystRatings，须引用华尔街一致目标价区间与买入机构占比作为估值锚。注意：若 ebitda 为 null 但 evEbit 有值，说明数据源未披露 EBITDA，请用 EV/EBIT 替代，并注明"因数据源未披露 EBITDA，采用 EV/EBIT（该倍数因不含折旧摊销而天然偏高）"）
## 同业估值对比
（若数据中包含 peers 数组，必须用表格对比本公司及同业的关键指标——市值、TTM PE、前瞻 PE、EV/EBITDA、分析师目标价——并点评相对估值高低与各自业务特征）
## 技术分析
（基于提供的技术信号与技术面数据，给出趋势判断、关键支撑/阻力位、短期(1–3 月)与中期(3–6 月)方向）
## 风险评估
（按影响/概率优先级列出公司特有风险与宏观风险，用表格）
## 催化剂与时间线
（用表格列出未来 6–12 个月的关键事件：财报日期、监管/政策节点、重大合同或产能里程碑，并标注方向。其中"财报日期"必须使用数据中的 nextEarningsDate 字段；若数据未提供 nextEarningsDate，则明确写"待公司披露"并在该格留空，严禁自行编造任何具体日期。）
## 投资建议
（含评级、12 个月目标价区间——用"保守/基准/乐观"三档情景测算并以表格呈现、建仓/加仓/止损策略、仓位建议与监控清单；目标价需结合估值、同业水平与分析师共识给出依据。其中"基准"档目标价必须以数据中的 targetMeanPrice（华尔街一致目标价均值）为准，不得另设一个与之不同的"基准"数值；若需给出独立测算的基准，必须明确标注为"本文独立测算"并与 targetMeanPrice 区分。）
## 结论
（3–5 条要点总结，重申评级与目标价）
3. 全文中文，专业、客观、可执行。所有结论须有数据或逻辑支撑，避免空话。务必完整输出到『结论』章节及末尾『> ⚠️ 风险提示』引用块（声明非投资建议），报告不得在未完成时被截断。`;

  const dataJson = JSON.stringify(
    {
      ticker: data.ticker,
      name: data.name,
      price: data.price,
      changePercent: data.changePercent,
      ytdPercent: data.ytdPercent,
      nextEarningsDate: data.nextEarningsDate,
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
      currentRatio: data.currentRatio,
      targetMeanPrice: data.targetMeanPrice,
      targetHighPrice: data.targetHighPrice,
      targetLowPrice: data.targetLowPrice,
      recommendationMean: data.recommendationMean,
      numberOfAnalysts: data.numberOfAnalysts,
      analystRatings: data.analystRatings,
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

  // 研报使用用户在 ⚙ 设置中选择的活跃模型（不再强制 Gemini：Gemini 免费额度
  // 容易被 429 打满导致研报直接失败）。长输出 + 60s 函数上限的超时风险由
  // PROVIDER_TIMEOUT_MS(50s) 与 maxTokens(4500) 控制，超时返回清晰报错而非静默网络错误。
  const res = await chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.3, maxTokens: 4500 }
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
