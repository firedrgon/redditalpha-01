/**
 * A 股财务数据获取（统一东方财富数据源）
 *
 * 数据源：
 *   1. 东方财富 push2 — 行情（价格/PE/PB/市值）
 *   2. 东方财富 RPT_LICO_FN_CPD — 财务摘要（营收增长/ROE/速动比率/毛利率/净利率）
 *   3. 东方财富 ZyzbAjaxNew — F10 主要指标（加权ROE/年报历史ROE/行业板块）
 *   4. 东方财富研报接口 — 分析师共识（目标价/评级）
 *   5. 东方财富新闻接口 — 个股新闻（情绪面）
 *   6. 百度财经 API — 分析师目标价（finance.ts 中覆盖）
 *
 * 所有数据均来自东方财富公开 API，无需认证。
 * 返回统一的 FinancialMetrics 结构，与分析流程（lib/analysis.ts）
 * 和策略体系（lib/strategies.ts）共用，市场无关。
 *
 * 东方财富 secid 格式：1.600519（沪市前缀1）/ 0.000001（深市前缀0）
 */

import type { FinancialMetrics } from "./finance";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* 东方财富接口类型定义                                                 */
/* ------------------------------------------------------------------ */

/** push2 行情接口响应 */
interface EMMarketData {
  f43?: number; // 当前价（单位：分）
  f44?: number; // 最高价
  f45?: number; // 最低价
  f46?: number; // 今开
  f57?: string; // 代码
  f58?: string; // 名称
  f60?: number; // 昨收
  f116?: number; // 总市值
  f117?: number; // 流通市值
  f162?: number; // PE(动)
  f167?: number; // PB
  f168?: number; // 换手率
  f170?: number; // 涨跌幅
  f184?: number; // 成交量
  f185?: number; // 成交额
  f186?: number; // 量比
  f187?: number; // 涨停价
  f188?: number; // 跌停价
  f189?: number; // 振幅
}

interface EMMarketResp {
  data?: EMMarketData;
}

/** RPT_LICO_FN_CPD 财务摘要行 */
interface EMFinanceRow {
  REPORT_DATE?: string;
  TOTAL_OPERATE_INCOME?: number; // 营业总收入
  TOTAL_OPERATE_INCOME_YOY?: number; // 营收同比增长（小数，如 0.2178）
  PARENT_NETPROFIT?: number; // 归母净利润
  PARENT_NETPROFIT_YOY?: number; // 净利润同比增长（小数）
  ROE_DILUTED?: number; // 摊薄 ROE（小数）
  WEIGHTAVG_ROE?: number; // 加权 ROE（小数）
  GROSS_PROFIT_RATIO?: number; // 毛利率（小数）
  NET_PROFIT_RATIO?: number; // 净利率（小数）
  QUICK_RATIO?: number; // 速动比率
  CURRENT_RATIO?: number; // 流动比率
  YSTZ?: number; // 营收同比增长（百分比，备用）
  SJLTZ?: number; // 净利润同比增长（百分比，备用）
  XSMLL?: number; // 毛利率（百分比，备用）
  BOARD_CODE?: string; // 行业板块代码
  BOARD_NAME?: string; // 行业名
  PUBLISHNAME?: string; // 行业别名
}

interface EMFinanceResp {
  result?: {
    data?: EMFinanceRow[];
  };
}

/** ZyzbAjaxNew 主要指标行 */
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

/* ------------------------------------------------------------------ */
/* 分析师共识类型                                                       */
/* ------------------------------------------------------------------ */

interface EMReportItem {
  emRatingName?: string;
  sRatingName?: string;
  indvAimPriceT?: string | number;
  indvAimPriceL?: string | number;
  orgSName?: string;
}

interface EMReportResp {
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
  持有: 3,
  中性: 3,
  减持: 4,
  卖出: 5,
  强卖: 5,
  强力卖出: 5,
  回避: 4,
};

/* ------------------------------------------------------------------ */
/* 新闻类型                                                             */
/* ------------------------------------------------------------------ */

interface EMNewsItem {
  Art_Title?: string;
  Art_ShowTime?: string;
  Art_Url?: string;
  Art_OriginUrl?: string;
  Art_Code?: string;
}

interface EMNewsResp {
  code?: number;
  message?: string;
  data?: {
    page_index?: number;
    list?: EMNewsItem[];
  };
}

/* ------------------------------------------------------------------ */
/* 东方财富主数据源：行情 + 财务 + 行业PE + 分析师 + 新闻                 */
/* ------------------------------------------------------------------ */

/**
 * 从东方财富获取 A 股完整财务数据（公开 API，无需认证）。
 *
 * 并行请求：
 *   1. push2 行情 — 当前价/PE/PB/总市值/名称
 *   2. RPT_LICO_FN_CPD — 财务摘要（营收增长/ROE/速动比率/毛利率/净利率/行业板块）
 *   3. ZyzbAjaxNew type=0 — 最新一期主要指标（加权ROE/速动比率/净利率）
 *   4. ZyzbAjaxNew type=1 — 年报历史（5年平均ROE/ROE历史/营收历史）
 *   5. push2 clist — 行业成分股 PE 平均值（行业PE）
 *   6. 研报接口 — 分析师共识（目标价/评级）
 *   7. 新闻接口 — 个股新闻
 *
 * 所有百分比字段已 /100 转小数（与 FinancialMetrics 约定一致），
 * 但 netProfitGrowthPct 保留百分比原值供 PEG 计算。
 */
async function fetchEastmoneyMetrics(
  ticker: string
): Promise<FinancialMetrics | null> {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return null;
  const [, code, ex] = m;
  const secid = ex === "SH" ? `1.${code}` : `0.${code}`;
  const f10Code = `${ex}${code}`; // SH600276
  const emCode = `${code}.${ex}`; // 600276.SH

  // 并行请求 7 路数据
  const [
    marketResult,
    financeResult,
    zyzbResult,
    annualResult,
    industryPeResult,
    analystResult,
    newsResult,
  ] = await Promise.allSettled([
    // 1. push2 行情
    (async () => {
      const fields =
        "f43,f44,f45,f46,f57,f58,f60,f116,f117,f162,f167,f168,f170,f184,f185,f186,f187,f188,f189";
      const res = await fetch(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`,
        {
          headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: EMMarketData };
      return json.data ?? null;
    })(),
    // 2. RPT_LICO_FN_CPD 财务摘要（最近 6 期）
    (async () => {
      const res = await fetch(
        `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=6&sortColumns=REPORT_DATE&sortTypes=-1`,
        {
          headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) return null;
      const json = (await res.json()) as EMFinanceResp;
      return json.result?.data ?? [];
    })(),
    // 3. ZyzbAjaxNew type=0 最新一期
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
      const json = (await res.json()) as EMZyzbResp;
      return json.data ?? [];
    })(),
    // 4. ZyzbAjaxNew type=1 年报历史
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
      const json = (await res.json()) as EMZyzbResp;
      return json.data ?? [];
    })(),
    // 5. 行业 PE（需要 CPD 的 BOARD_CODE，先取 CPD 再算行业 PE）
    (async (): Promise<number | null> => {
      // 先取 CPD 获取行业板块代码
      let boardCode: string | null = null;
      try {
        const res = await fetch(
          `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=BOARD_CODE&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=1&sortColumns=REPORTDATE&sortTypes=-1`,
          {
            headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
            signal: AbortSignal.timeout(6000),
          }
        );
        if (res.ok) {
          const json = (await res.json()) as {
            result?: { data?: Array<{ BOARD_CODE?: string }> };
          };
          boardCode = json.result?.data?.[0]?.BOARD_CODE ?? null;
        }
      } catch {
        /* ignore */
      }
      if (!boardCode) return null;
      // 取行业成分股 PE 平均值
      try {
        const res = await fetch(
          `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fs=b:${boardCode}&fields=f12,f9`,
          {
            headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
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
            (v): v is number =>
              typeof v === "number" && v > 0 && v < 1000
          );
        return pes.length > 0
          ? pes.reduce((s, v) => s + v, 0) / pes.length
          : null;
      } catch {
        return null;
      }
    })(),
    // 6. 分析师共识
    fetchEastmoneyAnalystConsensus(ticker),
    // 7. 个股新闻
    fetchCNNews(ticker),
  ]);

  const quote =
    marketResult.status === "fulfilled" ? marketResult.value : null;
  const financeHistory =
    (financeResult.status === "fulfilled" ? financeResult.value : null) ?? [];
  const zyzbRows =
    (zyzbResult.status === "fulfilled" ? zyzbResult.value : null) ?? [];
  const annualRows =
    (annualResult.status === "fulfilled" ? annualResult.value : null) ?? [];
  const industryPE =
    industryPeResult.status === "fulfilled" ? industryPeResult.value : null;
  const analyst =
    analystResult.status === "fulfilled" ? analystResult.value : null;
  const cnNews =
    newsResult.status === "fulfilled" ? newsResult.value : [];

  // 行情基础
  if (!quote || !quote.f58) return null;

  const priceDivisor = 100; // 东方财富价格单位：分 → 元
  const currentPrice = quote.f43 != null ? quote.f43 / priceDivisor : null;
  const trailingPE = quote.f162 != null ? quote.f162 : null;
  const marketCap = quote.f116 != null ? quote.f116 : null;

  // 财务摘要（CPD，最近一期）
  const finance = financeHistory[0] ?? null;

  // Zyzb 最新一期
  const zyzbLatest = zyzbRows[0] ?? null;

  // 营收同比增长：优先 Zyzb（最新季报），降级 CPD
  const cpdRevenueGrowthPct =
    finance?.TOTAL_OPERATE_INCOME_YOY != null
      ? finance.TOTAL_OPERATE_INCOME_YOY * 100
      : finance?.YSTZ != null ? finance.YSTZ : null;
  const revenueGrowthPct =
    zyzbLatest?.TOTALOPERATEREVETZ ?? cpdRevenueGrowthPct;
  const revenueGrowthYoY =
    revenueGrowthPct != null ? revenueGrowthPct / 100 : null;

  // 季度/TTM 营收增长（与 revenueGrowthYoY 同源）
  const quarterlyRevenueGrowth = revenueGrowthYoY;

  // 净利润同比增长（保留百分比原值用于 PEG 计算）
  const cpdNetProfitGrowthPct =
    finance?.PARENT_NETPROFIT_YOY != null
      ? finance.PARENT_NETPROFIT_YOY * 100
      : finance?.SJLTZ != null ? finance.SJLTZ : null;
  const netProfitGrowthPct =
    zyzbLatest?.PARENTNETPROFITTZ ?? cpdNetProfitGrowthPct;

  // ROE：优先 Zyzb 加权 ROE，降级 CPD 摊薄 ROE
  const cpdRoePct =
    finance?.WEIGHTAVG_ROE != null
      ? finance.WEIGHTAVG_ROE * 100
      : finance?.ROE_DILUTED != null ? finance.ROE_DILUTED * 100 : null;
  const roePct = zyzbLatest?.ROEJQ ?? cpdRoePct;
  const roe = roePct != null ? roePct / 100 : null;

  // 近 5 年年报平均 ROE（annualRows 全部为年报，按时间倒序）
  const annualRoes = annualRows
    .filter((r) => typeof r.ROEJQ === "number")
    .slice(0, 5);
  const returnOnEquity5yAvg =
    annualRoes.length > 0
      ? annualRoes.reduce((s, r) => s + (r.ROEJQ ?? 0), 0) /
        annualRoes.length /
        100
      : null;

  // ROE 历史
  const roeHistory = annualRows
    .map((r) => ({
      year: r.REPORT_DATE ? new Date(r.REPORT_DATE).getFullYear() : 0,
      roe: r.ROEJQ != null ? r.ROEJQ / 100 : null,
    }))
    .filter((x) => x.year && x.roe != null)
    .reverse();

  // 毛利率/净利率：优先 Zyzb，降级 CPD
  const cpdGrossMarginPct =
    finance?.GROSS_PROFIT_RATIO != null
      ? finance.GROSS_PROFIT_RATIO * 100
      : finance?.XSMLL != null ? finance.XSMLL : null;
  const grossMarginPct = zyzbLatest?.XSMLL ?? cpdGrossMarginPct;
  const grossMargin =
    grossMarginPct != null ? grossMarginPct / 100 : null;

  const cpdProfitMarginPct =
    finance?.NET_PROFIT_RATIO != null
      ? finance.NET_PROFIT_RATIO * 100
      : null;
  const profitMarginPct = zyzbLatest?.XSJLL ?? cpdProfitMarginPct;
  const profitMargin =
    profitMarginPct != null ? profitMarginPct / 100 : null;

  // 速动比率/流动比率：优先 Zyzb，降级 CPD
  const quickRatio =
    zyzbLatest?.SD ?? finance?.QUICK_RATIO ?? null;
  const currentRatio =
    zyzbLatest?.LD ?? finance?.CURRENT_RATIO ?? null;

  // 营收总额
  const totalRevenue =
    zyzbLatest?.TOTALOPERATEREVE ??
    finance?.TOTAL_OPERATE_INCOME ??
    null;

  // 历史营收（annualRows 年报）
  const revenueHistory = annualRows
    .map((r) => ({
      year: r.REPORT_DATE ? new Date(r.REPORT_DATE).getFullYear() : 0,
      revenue: r.TOTALOPERATEREVE ?? null,
    }))
    .filter((x) => x.year && x.revenue != null)
    .reverse();

  // 行业（从 CPD 或 Zyzb 获取）
  const industry =
    finance?.BOARD_NAME ?? finance?.PUBLISHNAME ?? null;

  // PEG = PE / 净利润增长率%（用百分比原值，如 PE=40 / 增长21.78% = 1.84）
  const pegRatio =
    trailingPE != null &&
    trailingPE > 0 &&
    netProfitGrowthPct != null &&
    netProfitGrowthPct > 0
      ? trailingPE / netProfitGrowthPct
      : null;

  // 分析师共识
  const targetMeanPrice = analyst?.targetMeanPrice ?? null;
  const targetHighPrice = analyst?.targetHighPrice ?? null;
  const targetLowPrice = analyst?.targetLowPrice ?? null;
  const numberOfAnalysts = analyst?.numberOfAnalysts ?? null;
  const recommendationMean = analyst?.recommendationMean ?? null;

  // 目标价上涨空间
  let targetUpside: number | null = null;
  if (
    targetMeanPrice != null &&
    currentPrice != null &&
    currentPrice > 0
  ) {
    targetUpside = (targetMeanPrice - currentPrice) / currentPrice;
  }

  const warnings: string[] = [];

  return {
    ticker,
    name: quote.f58 ?? null,
    trailingPE,
    forwardPE: null,
    pegRatio,
    industry,
    industryPE,
    sector: null,
    industryRank: null,
    currentPrice,
    targetMeanPrice,
    targetHighPrice,
    targetLowPrice,
    targetMedianPrice: null,
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
    news: cnNews,
    fetchedAt: new Date().toISOString(),
    dataSource: "eastmoney",
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 东方财富分析师研报共识                                               */
/* ------------------------------------------------------------------ */

/**
 * 从东方财富研报接口获取分析师共识（目标价/评级/机构数）。
 */
async function fetchEastmoneyAnalystConsensus(
  ticker: string
): Promise<AnalystConsensus | null> {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return null;
  const [, code] = m;

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
      const raw = r.indvAimPriceT ?? r.indvAimPriceL ?? null;
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

    // 评级聚合：取最近 10 条
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

/* ------------------------------------------------------------------ */
/* 东方财富个股新闻                                                     */
/* ------------------------------------------------------------------ */

/**
 * 从东方财富获取 A 股个股新闻（公开 API，无需认证）。
 * 返回统一新闻结构（供 analyzeNewsSentiment 关键词分析与消息面提示词使用）。
 */
export async function fetchCNNews(
  ticker: string
): Promise<
  Array<{
    title: string;
    source?: string;
    date?: string;
    summary?: string;
    url?: string;
  }>
> {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return [];
  const [, code, ex] = m;
  const secid = ex === "SH" ? `1.${code}` : `0.${code}`;

  try {
    const url =
      `https://np-listapi.eastmoney.com/comm/web/getListInfo` +
      `?client=web&biz=web_news_pre&dataNode=news_pre` +
      `&mTypeAndCode=${encodeURIComponent(secid)}&type=1` +
      `&sortEnd=&pageSize=20&pageNo=1`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: "https://data.eastmoney.com/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];

    const json = (await res.json()) as EMNewsResp;
    const list = json?.data?.list;
    if (!Array.isArray(list) || list.length === 0) return [];

    const news = list
      .map(
        (item): {
          title: string;
          source?: string;
          date?: string;
          url?: string;
        } | null => {
          const title = (item.Art_Title ?? "").trim();
          if (!title) return null;
          let date: string | undefined;
          if (item.Art_ShowTime) {
            const d = new Date(
              item.Art_ShowTime.replace(" ", "T") + "+08:00"
            );
            if (!isNaN(d.getTime())) date = d.toISOString();
          }
          const link =
            item.Art_Url?.trim() ||
            item.Art_OriginUrl?.trim() ||
            undefined;
          return {
            title,
            source: "东方财富",
            date,
            url: link,
          };
        }
      )
      .filter(
        (
          n
        ): n is {
          title: string;
          source?: string;
          date?: string;
          url?: string;
        } => n !== null
      );

    return news.slice(0, 15);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 获取 A 股财务数据：统一东方财富数据源。
 *
 * 东方财富提供全部核心指标（行情/财务/行业PE/分析师/新闻），
 * 无需多数据源拼凑。百度财经目标价由 finance.ts 中覆盖。
 */
export async function fetchCNFinancialMetrics(
  ticker: string
): Promise<FinancialMetrics> {
  const cnTicker =
    ticker.match(/^(\d{6})\.(SH|SZ)$/i)
      ? ticker.toUpperCase()
      : (() => {
          const code = ticker.replace(/\.(SH|SZ|SS)$/i, "").trim();
          if (/^\d{6}$/.test(code)) {
            const exchange = code.startsWith("6") ? "SH" : "SZ";
            return `${code}.${exchange}`;
          }
          return ticker.toUpperCase();
        })();

  const metrics = await fetchEastmoneyMetrics(cnTicker);

  if (metrics) {
    return metrics;
  }

  // 东方财富获取失败，返回空 fallback
  return {
    ticker: cnTicker,
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
    warnings: ["东方财富数据获取失败"],
  };
}
