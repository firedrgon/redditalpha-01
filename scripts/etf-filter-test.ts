/**
 * 验证估值/ PB 分位筛选逻辑：修复前 vs 修复后。
 * 复现 bug —— 主升浪池里最主流的沪深300ETF 走「代理分位」(proxy=true)，
 * 旧逻辑把它「排除在筛选外」(continue)，导致点「合理≤60%」它凭空消失、点「低估≤30%」列表几乎空。
 * 新逻辑：代理分位也按值参与筛选（p<=cap 保留）。
 */

interface Item {
  code: string;
  fundData: { valuation: { indexPePercentile: number | null; proxy: boolean } } | null;
}

// 构造：A=沪深300代理48(本应保留), B=中证500真实20(保留), C=分位null(缺失)
const items: Item[] = [
  { code: "510300", fundData: { valuation: { indexPePercentile: 48, proxy: true } } },
  { code: "000905", fundData: { valuation: { indexPePercentile: 20, proxy: false } } },
  { code: "123456", fundData: { valuation: { indexPePercentile: null, proxy: true } } },
];

function oldLogic(cap: number): string[] {
  const kept: string[] = [];
  let filteredOutEstimated = 0;
  let filteredOutUnknown = 0;
  for (const it of items) {
    const p = it.fundData?.valuation.indexPePercentile ?? null;
    if (p == null) { filteredOutUnknown++; continue; }
    if (it.fundData!.valuation.proxy) { filteredOutEstimated++; continue; } // 旧：代理排除
    if (p <= cap) kept.push(it.code);
  }
  console.log(`[旧] cap=${cap} kept=${kept.join(",")} 估算排除=${filteredOutEstimated} 缺失=${filteredOutUnknown}`);
  return kept;
}

function newLogic(cap: number): string[] {
  const kept: string[] = [];
  let filteredOutByCap = 0;
  let missing = 0;
  for (const it of items) {
    const p = it.fundData?.valuation.indexPePercentile ?? null;
    if (p == null) { missing++; continue; } // 新：仅 null 剔除
    if (p <= cap) kept.push(it.code);
    else filteredOutByCap++;
  }
  console.log(`[新] cap=${cap} kept=${kept.join(",")} 超阈值=${filteredOutByCap} 缺失=${missing}`);
  return kept;
}

console.log("=== 选「合理≤60%」(期望 510300+000905 都在) ===");
oldLogic(60);
newLogic(60);

console.log("\n=== 选「低估≤30%」(期望仅 000905) ===");
oldLogic(30);
newLogic(30);

// 断言新逻辑修复生效
const kept60 = newLogic(60);
const ok = kept60.includes("510300") && kept60.includes("000905") && !kept60.includes("123456");
console.log("\n[断言] 新逻辑下「合理≤60%」保留 510300(代理) 且剔除 123456(null) ->", ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
