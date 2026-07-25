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
  f171?: number; // 股息率（百分比，如 1.23 表示 1.23%）
}

interface EMMarketResp {
  data?: EMMarketData;
}

/** RPT_LICO_FN_CPD 财务摘要行（字段名与东方财富实际返回一致） */
interface EMFinanceRow {
  REPORTDATE?: string; // 报告日期（注意无下划线）
  TOTAL_OPERATE_INCOME?: number; // 营业总收入
  PARENT_NETPROFIT?: number; // 归母净利润
  WEIGHTAVG_ROE?: number; // 加权 ROE（百分比，如 6.18 表示 6.18%）
  YSTZ?: number; // 营收同比增长（百分比，如 56.52 表示 56.52%）
  SJLTZ?: number; // 净利润同比增长（百分比）
  XSMLL?: number; // 销售毛利率（百分比）
  BPS?: number; // 每股净资产
  BOARD_CODE?: string; // 行业板块代码
  BOARD_NAME?: string; // 行业名
  PUBLISHNAME?: string; // 行业别名
  BASIC_EPS?: number; // 基本每股收益
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

/** 利润表行（RPT_DMSK_FN_INCOME） */
interface EMIncomeRow {
  REPORT_DATE?: string;
  OPERATE_PROFIT?: number; // 营业利润（≈ EBIT）
  PARENT_NETPROFIT?: number; // 归母净利润
  BASIC_EPS?: number; // 基本每股收益
}

/** 资产负债表行（RPT_DMSK_FN_BALANCE） */
interface EMBalanceRow {
  REPORT_DATE?: string;
  TOTAL_LIABILITIES?: number; // 负债合计
  TOTAL_EQUITY?: number; // 所有者权益合计
  MONETARYFUNDS?: number; // 货币资金
}

/** 现金流表行（RPT_DMSK_FN_CASHFLOW） */
interface EMCashFlowRow {
  REPORT_DATE?: string;
  NETCASH_OPERATE?: number; // 经营活动现金流净额
  FREE_CASH_FLOW?: number; // 自由现金流
}

/** K 线响应（push2his，用于 52 周高低） */
interface EMKlineResp {
  data?: {
    klines?: string[]; // 每个元素 "日期,开,收,高,低,量,..."
  };
}

/** 预约披露响应 */
interface EMPredictDateResp {
  result?: {
    data?: Array<Record<string, unknown>>;
  };
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
  /** 评级分布（强买/买/持/卖/强卖 家数） */
  distribution?: {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  } | null;
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
  let boardCode: string | null = null; // 行业板块代码（用于同业对比定位成分股），下方 CPD 抓取时赋值

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
        "f43,f44,f45,f46,f57,f58,f60,f116,f117,f162,f167,f168,f170,f171,f184,f185,f186,f187,f188,f189";
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
        `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=6&sortColumns=REPORTDATE&sortTypes=-1`,
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
      // 先取 CPD 获取行业板块代码（boardCode 已在函数顶部声明）
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
      // 取行业成分股 PE 中位数（比简单平均更抗极端值干扰）
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
              typeof v === "number" && v > 0 && v < 300
          )
          .sort((a, b) => a - b);
        if (pes.length === 0) return null;
        const mid = Math.floor(pes.length / 2);
        return pes.length % 2
          ? pes[mid]
          : (pes[mid - 1] + pes[mid]) / 2;
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

  // —— A 股研报增强抓取（利润表 / 资产负债表 / 现金流 / 52 周 / 预约披露，并行）——
  const [
    incomeResult,
    balanceResult,
    cashFlowResult,
    klineResult,
    predictResult,
  ] = await Promise.allSettled([
    // 8. 利润表（营业利润 / 净利润 / EPS）
    (async (): Promise<EMIncomeRow | null> => {
      try {
        const res = await fetch(
          `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_FN_INCOME&columns=ALL&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1`,
          {
            headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { result?: { data?: EMIncomeRow[] } };
        return json.result?.data?.[0] ?? null;
      } catch {
        return null;
      }
    })(),
    // 9. 资产负债表（负债 / 权益 / 货币资金）
    (async (): Promise<EMBalanceRow | null> => {
      try {
        const res = await fetch(
          `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_FN_BALANCE&columns=ALL&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1`,
          {
            headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { result?: { data?: EMBalanceRow[] } };
        return json.result?.data?.[0] ?? null;
      } catch {
        return null;
      }
    })(),
    // 10. 现金流表（经营现金流 / 自由现金流）
    (async (): Promise<EMCashFlowRow | null> => {
      try {
        const res = await fetch(
          `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_FN_CASHFLOW&columns=ALL&filter=(SECUCODE="${emCode}")&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1`,
          {
            headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { result?: { data?: EMCashFlowRow[] } };
        return json.result?.data?.[0] ?? null;
      } catch {
        return null;
      }
    })(),
    // 11. 52 周高低（push2his 日 K 近 252 根）
    (async (): Promise<{ high: number; low: number } | null> => {
      try {
        const res = await fetch(
          `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=252&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55`,
          {
            headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) return null;
        const json = (await res.json()) as EMKlineResp;
        const klines = json.data?.klines ?? [];
        if (klines.length === 0) return null;
        let high = -Infinity;
        let low = Infinity;
        for (const k of klines) {
          const parts = k.split(",");
          const h = parseFloat(parts[3]); // 高 (f54)
          const l = parseFloat(parts[4]); // 低 (f55)
          if (!isNaN(h) && h > 0) high = Math.max(high, h);
          if (!isNaN(l) && l > 0) low = Math.min(low, l);
        }
        if (high === -Infinity || low === Infinity) return null;
        return { high, low };
      } catch {
        return null;
      }
    })(),
    // 12. 财报预约披露日
    (async (): Promise<string | null> => {
      try {
        const res = await fetch(
          `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_PUBLIC_BASICINFO&columns=ALL&filter=(SECURITY_CODE="${code}")&pageSize=1`,
          {
            headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
            signal: AbortSignal.timeout(6000),
          }
        );
        if (!res.ok) return null;
        const json = (await res.json()) as EMPredictDateResp;
        const row = json.result?.data?.[0];
        if (!row) return null;
        for (const key of Object.keys(row)) {
          if (/PREDICT|预约|PERFORM_DATE|FINANCE_DATE/i.test(key)) {
            const v = row[key];
            if (typeof v === "string" && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v)) {
              return v.slice(0, 10);
            }
          }
        }
        return null;
      } catch {
        return null;
      }
    })(),
  ]);

  const incomeRow =
    incomeResult.status === "fulfilled" ? incomeResult.value : null;
  const balanceRow =
    balanceResult.status === "fulfilled" ? balanceResult.value : null;
  const cashFlowRow =
    cashFlowResult.status === "fulfilled" ? cashFlowResult.value : null;
  const kline52 =
    klineResult.status === "fulfilled" ? klineResult.value : null;
  const predictDate =
    predictResult.status === "fulfilled" ? predictResult.value : null;

  // 行情基础
  if (!quote || !quote.f58) return null;

  const priceDivisor = 100; // 东方财富价格单位：分 → 元
  const currentPrice = quote.f43 != null ? quote.f43 / priceDivisor : null;
  // PE(f162) 和 PB(f167) 同样以分为单位，需 /100
  const trailingPE = quote.f162 != null ? quote.f162 / 100 : null;
  const pbRatio = quote.f167 != null ? quote.f167 / 100 : null;
  const marketCap = quote.f116 != null ? quote.f116 : null;

  // 财务摘要（CPD，最近一期）
  const finance = financeHistory[0] ?? null;

  // Zyzb 最新一期
  const zyzbLatest = zyzbRows[0] ?? null;

  // 营收同比增长：优先 Zyzb（最新季报），降级 CPD（YSTZ 已是百分比）
  const cpdRevenueGrowthPct = finance?.YSTZ ?? null;
  const revenueGrowthPct =
    zyzbLatest?.TOTALOPERATEREVETZ ?? cpdRevenueGrowthPct;
  const revenueGrowthYoY =
    revenueGrowthPct != null ? revenueGrowthPct / 100 : null;

  // 季度/TTM 营收增长（与 revenueGrowthYoY 同源）
  const quarterlyRevenueGrowth = revenueGrowthYoY;

  // 净利润同比增长（保留百分比原值用于 PEG 计算，SJLTZ 已是百分比）
  const cpdNetProfitGrowthPct = finance?.SJLTZ ?? null;
  const netProfitGrowthPct =
    zyzbLatest?.PARENTNETPROFITTZ ?? cpdNetProfitGrowthPct;

  // ROE：优先 Zyzb 加权 ROE，降级 CPD WEIGHTAVG_ROE（均已是百分比）
  const cpdRoePct = finance?.WEIGHTAVG_ROE ?? null;
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

  // 毛利率：优先 Zyzb，降级 CPD（XSMLL 已是百分比）
  const cpdGrossMarginPct = finance?.XSMLL ?? null;
  const grossMarginPct = zyzbLatest?.XSMLL ?? cpdGrossMarginPct;
  const grossMargin =
    grossMarginPct != null ? grossMarginPct / 100 : null;

  // 净利率：优先 Zyzb（XSJLL），降级 CPD（手动计算）
  const cpdProfitMarginPct =
    finance?.PARENT_NETPROFIT != null &&
    finance?.TOTAL_OPERATE_INCOME != null &&
    finance.TOTAL_OPERATE_INCOME > 0
      ? (finance.PARENT_NETPROFIT / finance.TOTAL_OPERATE_INCOME) * 100
      : null;
  const profitMarginPct = zyzbLatest?.XSJLL ?? cpdProfitMarginPct;
  const profitMargin =
    profitMarginPct != null ? profitMarginPct / 100 : null;

  // 速动比率/流动比率：仅 Zyzb 提供，CPD 无此字段
  const quickRatio = zyzbLatest?.SD ?? null;
  const currentRatio = zyzbLatest?.LD ?? null;

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

  // —— A 股研报增强字段映射 ——
  const netIncome =
    zyzbLatest?.PARENTNETPROFIT ??
    finance?.PARENT_NETPROFIT ??
    incomeRow?.PARENT_NETPROFIT ??
    null;
  const trailingEps = finance?.BASIC_EPS ?? incomeRow?.BASIC_EPS ?? null;
  const operatingIncome = incomeRow?.OPERATE_PROFIT ?? null;
  const totalDebt = balanceRow?.TOTAL_LIABILITIES ?? null;
  const totalEquity = balanceRow?.TOTAL_EQUITY ?? null;
  const totalCash = balanceRow?.MONETARYFUNDS ?? null;
  const operatingCashFlow = cashFlowRow?.NETCASH_OPERATE ?? null;
  const freeCashFlow = cashFlowRow?.FREE_CASH_FLOW ?? null;
  const dividendYield = quote.f171 != null ? quote.f171 / 100 : null;
  const week52High = kline52?.high ?? null;
  const week52Low = kline52?.low ?? null;
  const nextEarningsDate = predictDate ?? null;
  const analystRatings = analyst?.distribution ?? null;

  // 企业价值与估值倍数
  let enterpriseValue: number | null = null;
  if (
    marketCap != null &&
    totalDebt != null &&
    totalCash != null
  ) {
    enterpriseValue = marketCap + totalDebt - totalCash;
  }
  const evEbit =
    enterpriseValue != null && operatingIncome && operatingIncome > 0
      ? enterpriseValue / operatingIncome
      : null;
  const evEbitda =
    enterpriseValue != null &&
    incomeRow &&
    (incomeRow as { EBITDA?: number }).EBITDA != null &&
    (incomeRow as { EBITDA?: number }).EBITDA! > 0
      ? enterpriseValue / (incomeRow as { EBITDA?: number }).EBITDA!
      : null;
  const debtToEquity =
    totalDebt != null && totalEquity != null && totalEquity > 0
      ? totalDebt / totalEquity
      : null;

  const warnings: string[] = [];

  return {
    ticker,
    name: quote.f58 ?? null,
    trailingPE,
    forwardPE: null,
    pegRatio,
    industry,
    boardCode,
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
    changePercent: quote.f170 != null ? quote.f170 / 100 : null,
    netIncome,
    operatingIncome,
    trailingEps,
    forwardEps: null,
    dividendYield,
    ebitda: incomeRow ? (incomeRow as { EBITDA?: number }).EBITDA ?? null : null,
    evEbit,
    evEbitda,
    enterpriseValue,
    operatingCashFlow,
    freeCashFlow,
    totalCash,
    totalDebt,
    debtToEquity,
    week52High,
    week52Low,
    ytdPercent: null,
    nextEarningsDate,
    analystRatings,
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
  ticker: string,
  timeoutMs: number = 8000
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
        signal: AbortSignal.timeout(timeoutMs),
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

    // 评级聚合：取最近 10 条算均值
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

    // 评级分布（全量报告统计家数）
    const dist = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 };
    for (const r of reports) {
      const name = r.emRatingName ?? r.sRatingName;
      if (!name) continue;
      const v = RATING_VALUE_MAP[name];
      if (v === 1) dist.strongBuy++;
      else if (v === 2) dist.buy++;
      else if (v === 3) dist.hold++;
      else if (v === 4) dist.sell++;
      else if (v === 5) dist.strongSell++;
    }
    const distribution =
      dist.strongBuy + dist.buy + dist.hold + dist.sell + dist.strongSell > 0
        ? dist
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
      distribution,
    };
  } catch {
    return null;
  }
}

export interface CNPeer {
  ticker: string;
  name: string | null;
  price: number | null;
  changePercent: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  evEbitda: number | null;
  pb: number | null;
  targetMeanPrice: number | null;
}

/**
 * 从东方财富 clist 接口获取同行业可比公司（A 股同业对比）。
 * 通过行业板块代码列出成分股，对每只 peer 抓分析师目标价，组装成 CNPeer[]。
 */
export async function fetchCNPeers(
  selfCode: string,
  boardCode: string | null,
  notes: string[]
): Promise<CNPeer[] | null> {
  if (!boardCode) return null;
  const selfNum = selfCode.match(/^(\d{6})/)?.[1];
  try {
    const res = await fetch(
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fs=b:${boardCode}&fields=f12,f14,f9,f20,f23,f57`,
      {
        headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        diff?: Array<{
          f12?: string;
          f14?: string;
          f9?: number;
          f20?: number;
          f23?: number;
          f57?: string;
        }>;
      };
    };
    const list = json.data?.diff ?? [];
    const peers = list
      .filter((x) => x.f57 && selfNum && !x.f57.toUpperCase().includes(selfNum))
      .slice(0, 5);
    if (peers.length === 0) return null;

    const valid = (
      await Promise.all(
        peers.map(async (p) => {
          const [mktNum, code] = (p.f57 as string).split(".");
          const sym = mktNum === "1" ? "SH" : "SZ";
          const peerCode = `${code}.${sym}`;
          const consensus = await fetchEastmoneyAnalystConsensus(
            peerCode,
            5000
          ).catch(() => null);
          return {
            ticker: peerCode,
            name: p.f14 ?? null,
            price: null,
            changePercent: null,
            marketCap: p.f20 ?? null,
            trailingPE: p.f9 ?? null,
            forwardPE: null,
            evEbitda: null,
            pb: p.f23 ?? null,
            targetMeanPrice: consensus?.targetMeanPrice ?? null,
          } as CNPeer;
        })
      )
    ).filter((r) => r.marketCap != null || r.trailingPE != null);

    if (valid.length === 0) {
      notes.push("同业对标数据获取失败，已跳过同业对比。");
      return null;
    }
    return valid;
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
    boardCode: null,
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
    changePercent: null,
    netIncome: null,
    operatingIncome: null,
    trailingEps: null,
    forwardEps: null,
    dividendYield: null,
    ebitda: null,
    evEbit: null,
    evEbitda: null,
    enterpriseValue: null,
    operatingCashFlow: null,
    freeCashFlow: null,
    totalCash: null,
    totalDebt: null,
    debtToEquity: null,
    week52High: null,
    week52Low: null,
    ytdPercent: null,
    nextEarningsDate: null,
    analystRatings: null,
    news: [],
    fetchedAt: new Date().toISOString(),
    dataSource: "fallback",
    warnings: ["东方财富数据获取失败"],
  };
}
