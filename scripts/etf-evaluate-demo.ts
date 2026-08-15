/**
 * ETF 估值+质量评估 Demo
 *
 * 运行： npx tsx scripts/etf-evaluate-demo.ts
 *
 * 目的：
 *   1. 用样例数据验证评分引擎（覆盖 A/B/C/D 与全缺数据边界）
 *   2. best-effort 试抓 1~2 只真实 ETF（沪深300ETF/创业板ETF）跑端到端
 */

import { evaluateEtf, type EtfValuationInput, type EtfQualityInput } from "../lib/etf-evaluate";
import { fetchEtfFundData, assembleEtfFundData } from "../lib/etf-fund-data";

function printBar(title: string) {
  console.log("\n" + "=".repeat(64));
  console.log(title);
  console.log("=".repeat(64));
}

async function main() {
  console.log("ETF 主升浪「估值+质量」评估引擎 · Demo");

  // ----------------------------------------------------------
  // 1. 样例：覆盖各档评级
  // ----------------------------------------------------------
  const samples: Array<{
    name: string;
    valuation: EtfValuationInput;
    quality: EtfQualityInput;
  }> = [
    {
      name: "样例A · 低估+优质工具",
      valuation: {
        indexPePercentile: 20,
        indexPbPercentile: 15,
        dividendYieldPct: 3.2,
        bondYieldPct: 2.5,
        epsRevisionUpPct: 15,
        proxy: false,
      },
      quality: {
        scaleYi: 120,
        dailyTurnoverWan: 50000,
        premiumDiscountPct: 0.05,
        trackingErrorPct: 0.15,
        feeRatePct: 0.15,
      },
    },
    {
      name: "样例B · 合理+中等工具",
      valuation: {
        indexPePercentile: 45,
        indexPbPercentile: 50,
        dividendYieldPct: 1.5,
        bondYieldPct: 2.5,
        epsRevisionUpPct: 0,
        proxy: false,
      },
      quality: {
        scaleYi: 8,
        dailyTurnoverWan: 8000,
        premiumDiscountPct: 0.2,
        trackingErrorPct: 0.4,
        feeRatePct: 0.5,
      },
    },
    {
      name: "样例C · 偏贵+规模偏小",
      valuation: {
        indexPePercentile: 70,
        indexPbPercentile: 65,
        dividendYieldPct: 0.8,
        bondYieldPct: 2.5,
        epsRevisionUpPct: -10,
        proxy: false,
      },
      quality: {
        scaleYi: 1.5,
        dailyTurnoverWan: 800,
        premiumDiscountPct: 0.4,
        trackingErrorPct: 0.8,
        feeRatePct: 0.6,
      },
    },
    {
      name: "样例D · 很贵+工具弱",
      valuation: {
        indexPePercentile: 85,
        indexPbPercentile: 80,
        dividendYieldPct: null,
        bondYieldPct: 2.5,
        epsRevisionUpPct: null,
        proxy: false,
      },
      quality: {
        scaleYi: 0.8,
        dailyTurnoverWan: 300,
        premiumDiscountPct: 1.2,
        trackingErrorPct: 2.5,
        feeRatePct: 0.8,
      },
    },
    {
      name: "样例 · 全缺数据（应中性处理）",
      valuation: {
        indexPePercentile: null,
        indexPbPercentile: null,
        dividendYieldPct: null,
        bondYieldPct: null,
        epsRevisionUpPct: null,
        proxy: false,
      },
      quality: {
        scaleYi: null,
        dailyTurnoverWan: null,
        premiumDiscountPct: null,
        trackingErrorPct: null,
        feeRatePct: null,
      },
    },
  ];

  printBar("样例评估");
  for (const s of samples) {
    const r = evaluateEtf({ valuation: s.valuation, quality: s.quality });
    console.log(`\n【${s.name}】`);
    console.log(`  综合: ${r.grade} (${r.totalScore?.toFixed(0) ?? "—"})`);
    console.log(
      `  估值维度: ${r.valuation.score?.toFixed(0) ?? "—"} (${r.valuation.grade})`
    );
    for (const m of r.valuation.metrics) {
      console.log(`    - ${m.label}: ${m.score?.toFixed(0) ?? "—"} | ${m.note}`);
    }
    console.log(
      `  质量维度: ${r.quality.score?.toFixed(0) ?? "—"} (${r.quality.grade})`
    );
    for (const m of r.quality.metrics) {
      console.log(`    - ${m.label}: ${m.score?.toFixed(0) ?? "—"} | ${m.note}`);
    }
    if (r.warnings.length) console.log(`  提示: ${r.warnings.join("；")}`);
    console.log(`  结论: ${r.summary}`);
  }

  // ----------------------------------------------------------
  // 2. 真实 ETF 试抓（best-effort，失败不阻塞）
  // ----------------------------------------------------------
  // ----------------------------------------------------------
  // 2b. 离线解析自测（不依赖网络，用真实数据结构验证解析正确性）
  // ----------------------------------------------------------
  printBar("离线解析自测（喂入真实结构，验证无 NaN）");

  // 沪深300ETF 风格：f162/f167 为 "-"（ETF 无 PE/PB），靠概况 HTML 拿费率+跟踪标的
  const hs300Market = {
    f43: 4726,
    f57: "510300",
    f58: "沪深300ETF华泰柏瑞",
    f116: 111905005224.448, // 元 → 1119 亿
    f162: "-",
    f167: "-",
    f171: 87, // → 0.87%
    f185: "-",
  };
  const hs300Html =
    "管理费0.15% 托管费0.05% 跟踪标的沪深300指数 跟踪误差0.12%";
  const hs300 = await assembleEtfFundData("510300", "SH", hs300Market, hs300Html);
  const hs300Ev = evaluateEtf({ valuation: hs300.valuation, quality: hs300.quality });
  console.log(`\n【离线·沪深300ETF风格】`);
  console.log(
    `  规模 ${hs300.raw.scaleYi?.toFixed(1)}亿 | 股息 ${hs300.raw.dividendYieldPct?.toFixed(2)}% | ` +
      `费率 ${hs300.raw.feeRatePct?.toFixed(2)}% | 跟踪误差 ${hs300.raw.trackingErrorPct?.toFixed(2)}% | ` +
      `跟踪标的 ${hs300.raw.trackIndexName}`
  );
  console.log(`  估值分位(代理): PE ${hs300.valuation.indexPePercentile ?? "—"} / PB ${hs300.valuation.indexPbPercentile ?? "—"}`);
  console.log(`  综合: ${hs300Ev.grade} (${hs300Ev.totalScore?.toFixed(0) ?? "—"}) | ${hs300Ev.summary}`);
  const anyNaN =
    [hs300.raw.scaleYi, hs300.raw.dividendYieldPct, hs300.raw.feeRatePct, hs300.raw.trackingErrorPct].some(
      (v) => v != null && !Number.isFinite(v)
    );
  console.log(`  NaN 检查: ${anyNaN ? "❌ 发现 NaN" : "✅ 无 NaN"}`);

  // 通用 ETF：自身带数值 PE/PB（验证代理分位换算）
  const genMarket = {
    f43: 1234,
    f57: "159915",
    f58: "创业板ETF",
    f116: 64370000000, // 643.7 亿
    f162: 3500, // → PE 35（贵）
    f167: 420, // → PB 4.2（贵）
    f171: 60, // → 0.60%
    f185: 800000000, // → 8 亿
  };
  const genHtml = "管理费0.50% 托管费0.10% 跟踪标的创业板指 跟踪误差0.20%";
  const gen = await assembleEtfFundData("159915", "SZ", genMarket, genHtml);
  const genEv = evaluateEtf({ valuation: gen.valuation, quality: gen.quality });
  console.log(`\n【离线·通用ETF(贵)】`);
  console.log(
    `  规模 ${gen.raw.scaleYi?.toFixed(1)}亿 | 日均成交 ${(gen.raw.dailyTurnoverWan ?? 0) / 10000}亿 | ` +
      `PE ${gen.raw.pe?.toFixed(2)} | PB ${gen.raw.pb?.toFixed(2)} | 费率 ${gen.raw.feeRatePct?.toFixed(2)}%`
  );
  console.log(`  估值分位(代理): PE ${gen.valuation.indexPePercentile?.toFixed(0)} / PB ${gen.valuation.indexPbPercentile?.toFixed(0)}`);
  console.log(`  综合: ${genEv.grade} (${genEv.totalScore?.toFixed(0) ?? "—"}) | ${genEv.summary}`);

  printBar("真实 ETF 端到端（best-effort，依赖网络）");
  const liveCodes: Array<{ code: string; board: "SH" | "SZ" }> = [
    { code: "510300", board: "SH" }, // 沪深300ETF
    { code: "159915", board: "SZ" }, // 创业板ETF
  ];
  for (const { code, board } of liveCodes) {
    try {
      const fd = await fetchEtfFundData(code, board);
      const ev = evaluateEtf({ valuation: fd.valuation, quality: fd.quality });
      console.log(`\n【${code} ${fd.name ?? ""}】`);
      console.log(
        `  综合评级: ${ev.grade} (${ev.totalScore?.toFixed(0) ?? "—"})`
      );
      console.log(
        `  规模 ${fd.raw.scaleYi?.toFixed(1) ?? "—"}亿 | 日均成交 ${
          fd.raw.dailyTurnoverWan != null
            ? (fd.raw.dailyTurnoverWan / 10000).toFixed(2)
            : "—"
        }亿 | PE ${fd.raw.pe?.toFixed(2) ?? "—"} | PB ${
          fd.raw.pb?.toFixed(2) ?? "—"
        } | 股息 ${fd.raw.dividendYieldPct?.toFixed(2) ?? "—"}% | 费率 ${
          fd.raw.feeRatePct?.toFixed(2) ?? "—"
        }%`
      );
      console.log(
        `  跟踪标的: ${fd.raw.trackIndexName ?? "—"} | 估值分位代理: ${
          fd.raw.proxy ? "是" : "否"
        }`
      );
      console.log(`  结论: ${ev.summary}`);
    } catch (err) {
      console.log(
        `\n【${code}】抓取失败（网络/反爬），跳过: ${(err as Error).message}`
      );
    }
  }

  printBar("Demo 完成");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
