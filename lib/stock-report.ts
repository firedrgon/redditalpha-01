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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface StockReportNews {
  title: string;
  source?: string;
  date?: string;
  url?: string;
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

/** Yahoo v8 chart 取 52 周高低（stockanalysis 未给时的兜底） */
async function fetchYahoo52w(
  ticker: string
): Promise<{ high: number; low: number } | null> {
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
    const closes: number[] =
      d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const vals = closes.filter(
      (x: number) => typeof x === "number" && !isNaN(x)
    );
    if (vals.length === 0) return null;
    return { high: Math.max(...vals), low: Math.min(...vals) };
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

  // 52 周兜底
  if (data.week52High == null || data.week52Low == null) {
    const w52 = await fetchYahoo52w(upper);
    if (w52) {
      if (data.week52High == null) data.week52High = w52.high;
      if (data.week52Low == null) data.week52Low = w52.low;
    }
  }

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
## 估值分析
## 技术分析
## 风险评估
## 催化剂与时间线
## 投资建议
（含评级、12 个月目标价区间、建仓/加仓/止损策略）
## 结论
3. 全文中文，专业、客观、可执行。报告末尾用 "> ⚠️" 引用块给出风险提示，声明非投资建议。`;

  const dataJson = JSON.stringify(
    {
      ticker: data.ticker,
      name: data.name,
      price: data.price,
      changePercent: data.changePercent,
      currency: data.currency,
      marketCap: data.marketCap,
      week52High: data.week52High,
      week52Low: data.week52Low,
      trailingPE: data.trailingPE,
      forwardPE: data.forwardPE,
      pegRatio: data.pegRatio,
      roe: data.roe,
      grossMargin: data.grossMargin,
      profitMargin: data.profitMargin,
      revenueGrowthYoY: data.revenueGrowthYoY,
      totalRevenue: data.totalRevenue,
      revenueHistory: data.revenueHistory,
      debtToEquity: data.debtToEquity,
      freeCashFlow: data.freeCashFlow,
      targetMeanPrice: data.targetMeanPrice,
      targetHighPrice: data.targetHighPrice,
      targetLowPrice: data.targetLowPrice,
      recommendationMean: data.recommendationMean,
      numberOfAnalysts: data.numberOfAnalysts,
      industry: data.industry,
      technicalSignals: data.technical
        ? {
            overall: SIGNAL_LABELS[data.technical.overall],
            oscillators: SIGNAL_LABELS[data.technical.oscillators],
            movingAverages: SIGNAL_LABELS[data.technical.movingAverages],
          }
        : null,
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

  return {
    ticker: clean,
    report: res.text,
    data,
    generatedAt: new Date().toISOString(),
  };
}
