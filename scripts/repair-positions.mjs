/**
 * 持仓修复脚本（一次性）
 *
 * 背景：历史回补脚本（backfill-positions.mjs）在为「持仓功能上线前」的旧 buy 信号
 * 建仓时，因 SignalAlert.price 当时恒为 null，把 entryPrice 记成了 0、shares 记成 0，
 * 产生一批 entryPrice=0 / shares=0 的「幽灵持仓」（渲染为「—」，算不出未实现盈亏）。
 *
 * 本脚本：扫描 entryPrice<=0 的持仓（OPEN 与 CLOSED），按 ticker 取当前现价回填：
 *   - entryPrice = 当前现价（近似值，仅作展示修复，非历史精确价）
 *   - shares     = capital / entryPrice
 *   - 回写关联 alert.price
 *   - CLOSED 且 exitPrice>0 时，重算 pnl/pnlPct
 *
 * 幂等：只处理 entryPrice<=0 的记录；已正常的持仓不动。
 * 行情来源：读 AppSetting 的 finance_config（finnhub/fmp key），US 走 Finnhub→FMP→Yahoo，
 *          CN 走东方财富 push2；取不到价则跳过该条（保留 0，不破坏）。
 *
 * 运行：node scripts/repair-positions.mjs
 */
import { PrismaClient } from "@prisma/client";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function marketOf(ticker) {
  const t = (ticker || "").trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|SS)$/.test(t)) return "CN";
  if (/^(SH|SZ)\d{6}$/.test(t)) return "CN";
  if (/^\d{6}$/.test(t)) return "CN";
  return "US";
}

async function readFinanceConfig(p) {
  try {
    const row = await p.appSetting.findUnique({ where: { key: "finance_config" } });
    if (row?.value) return JSON.parse(row.value);
  } catch {}
  return {};
}

async function fetchUSPrice(ticker, cfg) {
  // 1) Finnhub
  if (cfg.finnhubApiKey) {
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(cfg.finnhubApiKey)}`;
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        if (typeof d.c === "number" && d.c > 0) return d.c;
      }
    } catch {}
  }
  // 2) FMP
  if (cfg.fmpApiKey) {
    try {
      const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(ticker)}?apikey=${encodeURIComponent(cfg.fmpApiKey)}`;
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (res.ok) {
        const arr = await res.json();
        const d = arr?.[0];
        if (d && typeof d.price === "number" && d.price > 0) return d.price;
      }
    } catch {}
  }
  // 3) Yahoo 兜底（429 限流时重试 + 退避）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (res.ok) {
        const j = await res.json();
        const m = j?.chart?.result?.[0]?.meta;
        if (m && typeof m.regularMarketPrice === "number" && m.regularMarketPrice > 0) return m.regularMarketPrice;
      }
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // 4) 腾讯财经兜底（国内可达、免 key；Yahoo 被墙时也能取到美股价）
  try {
    const sym = ticker.replace(/\W/g, "").toUpperCase();
    const res = await fetch(`https://qt.gtimg.cn/q=us${sym}`, {
      headers: { "User-Agent": UA, Referer: "https://finance.qq.com" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const txt = new TextDecoder("gbk").decode(buf);
      const m = txt.match(/="([^"]*)"/);
      if (m) {
        const f = m[1].split("~");
        const price = Number(f[3]);
        if (Number.isFinite(price) && price > 0) return price;
      }
    }
  } catch {}
  return null;
}

async function fetchCNPrice(ticker) {
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/i);
  if (!m) return null;
  const code = m[1];
  const ex = m[2].toUpperCase();
  const secid = ex === "SH" ? `1.${code}` : `0.${code}`;
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f170`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json?.data;
    if (d && typeof d.f43 === "number" && d.f43 > 0) return d.f43 / 100;
  } catch {}
  return null;
}

async function fetchPrice(ticker, cfg) {
  return marketOf(ticker) === "CN" ? fetchCNPrice(ticker) : fetchUSPrice(ticker, cfg);
}

async function main() {
  const p = new PrismaClient();
  await p.$connect();
  const cfg = await readFinanceConfig(p);

  const broken = await p.position.findMany({
    where: { entryPrice: { lte: 0 } },
    select: { id: true, ticker: true, status: true, capital: true, entryAlertId: true, exitPrice: true },
  });

  console.log(`[repair-positions] 找到 entryPrice<=0 的持仓 ${broken.length} 条`);

  let repaired = 0;
  let skipped = 0;
  for (const pos of broken) {
    const price = await fetchPrice(pos.ticker, cfg);
    // 每支之间稍作间隔，避免 Yahoo 429 限流
    await new Promise((r) => setTimeout(r, 800));
    if (price == null) {
      console.log(`  跳过 ${pos.ticker}（取不到现价）`);
      skipped++;
      continue;
    }
    const shares = pos.capital > 0 ? pos.capital / price : 0;
    const data = { entryPrice: price, shares };
    if (pos.status === "CLOSED" && pos.exitPrice != null && pos.exitPrice > 0) {
      data.pnl = (pos.exitPrice - price) * shares;
      data.pnlPct = (pos.exitPrice / price - 1) * 100;
    }
    await p.position.update({ where: { id: pos.id }, data });
    if (pos.entryAlertId) {
      await p.signalAlert.updateMany({ where: { id: pos.entryAlertId }, data: { price } });
    }
    console.log(`  修复 ${pos.ticker} (${pos.status}) entryPrice=${price.toFixed(2)} shares=${shares.toFixed(4)}`);
    repaired++;
  }

  console.log(`[repair-positions] 完成：修复=${repaired}，跳过=${skipped}`);
  await p.$disconnect();
}

main().catch((err) => {
  console.error("[repair-positions] 失败:", err);
  process.exit(1);
});
