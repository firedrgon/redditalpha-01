/**
 * 历史持仓回补脚本（一次性）
 *
 * 扫描已有的 buy/sell SignalAlert，按 (userId, ticker) 时间序 FIFO 配对，
 * 重建模拟持仓 Position 记录：
 *   - buy alert  → 开一个 OPEN 持仓（entryAlertId 关联该 alert）
 *   - sell alert → 关闭该 (userId, ticker) 最早的一个 OPEN 持仓（exitAlertId 关联该 alert）
 *
 * 价格取 alert.price（本功能上线后写入的 alert 才有；更早的 alert 为 null，
 *   此时建仓股数记为 0、平仓盈亏记为 null，仅保留进出场标记）。
 *
 * 幂等：若 buy/sell alert 已经有关联的 Position（entryAlertId / exitAlertId），
 *   跳过不再重复创建（兼容 live signals-runner 已写入的持仓）。
 *
 * 币种：ticker 命中 A 股规则 → CNY / 市场=CN，否则 USD / US。
 *
 * 运行：node scripts/backfill-positions.mjs
 */
import { PrismaClient } from "@prisma/client";

const DAY = 86_400_000;
const DEFAULT_CN = 10000;
const DEFAULT_US = 10000;

// 简易 A 股识别（与 lib/market 一致，仅用于 CN/US 区分）
function marketOf(ticker) {
  const t = (ticker || "").trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|SS)$/.test(t)) return "CN";
  if (/^(SH|SZ)\d{6}$/.test(t)) return "CN";
  if (/^\d{6}$/.test(t)) return "CN";
  return "US";
}

async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();

  // 读取每笔本金配置（AppSetting 存纯数字字符串；缺省用默认）
  async function readCapital(key, fallback) {
    try {
      const row = await prisma.appSetting.findUnique({ where: { key } });
      const n = row ? Number(row.value) : NaN;
      return Number.isFinite(n) && n > 0 ? n : fallback;
    } catch {
      return fallback;
    }
  }
  const capCN = await readCapital("simCapitalPerTradeCN", DEFAULT_CN);
  const capUS = await readCapital("simCapitalPerTradeUS", DEFAULT_US);

  const alerts = await prisma.signalAlert.findMany({
    where: { signalType: { in: ["buy", "sell"] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      ticker: true,
      tickerName: true,
      signalType: true,
      price: true,
      createdAt: true,
    },
  });

  // 按 (userId|ticker) 分组
  const groups = new Map();
  for (const a of alerts) {
    const key = `${a.userId}|${a.ticker}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  let createdOpen = 0;
  let closedOpen = 0;
  let skippedBuy = 0;
  let skippedSell = 0;

  for (const [, list] of groups) {
    // opens 维护本组在当前遍历中已经创建的 OPEN 持仓（内存态）
    const opens = [];

    for (const a of list) {
      const market = marketOf(a.ticker);
      const assetType = market === "CN" ? "CN" : "US";
      const currency = market === "CN" ? "CNY" : "USD";
      const capital = market === "CN" ? capCN : capUS;

      if (a.signalType === "buy") {
        // 幂等：已有关联该 alert 的持仓则跳过
        const exists = await prisma.position.findFirst({
          where: { entryAlertId: a.id },
        });
        if (exists) {
          skippedBuy++;
          continue;
        }
        const entryPrice = a.price;
        const shares = entryPrice && entryPrice > 0 ? capital / entryPrice : 0;
        const pos = await prisma.position.create({
          data: {
            userId: a.userId,
            ticker: a.ticker,
            tickerName: a.tickerName || undefined,
            assetType,
            currency,
            status: "OPEN",
            entryPrice: entryPrice ?? 0,
            entryAt: a.createdAt,
            entryAlertId: a.id,
            shares,
            capital,
          },
        });
        opens.push({
          id: pos.id,
          entryAt: a.createdAt,
          entryPrice: entryPrice ?? 0,
          shares,
          status: "OPEN",
        });
        createdOpen++;
      } else {
        // sell：幂等检查
        const exists = await prisma.position.findFirst({
          where: { exitAlertId: a.id },
        });
        if (exists) {
          skippedSell++;
          continue;
        }
        // FIFO：优先关闭本组内存里最早的 OPEN，否则查库
        let open = opens.find((o) => o.status === "OPEN");
        let fromDb = false;
        if (!open) {
          const dbOpen = await prisma.position.findFirst({
            where: { userId: a.userId, ticker: a.ticker, status: "OPEN" },
            orderBy: { entryAt: "asc" },
          });
          if (!dbOpen) continue; // 没有可平的历史持仓
          open = {
            id: dbOpen.id,
            entryAt: dbOpen.entryAt,
            entryPrice: dbOpen.entryPrice,
            shares: dbOpen.shares,
            status: "OPEN",
          };
          fromDb = true;
        }

        const exitPrice = a.price;
        const entryPrice = open.entryPrice;
        const shares = open.shares;
        const holdDays = Math.floor(
          (new Date(a.createdAt).getTime() - new Date(open.entryAt).getTime()) /
            DAY
        );
        let pnl = null;
        let pnlPct = null;
        if (exitPrice != null && entryPrice > 0) {
          pnl = (exitPrice - entryPrice) * shares;
          pnlPct = (exitPrice / entryPrice - 1) * 100;
        }
        await prisma.position.update({
          where: { id: open.id },
          data: {
            assetType,
            currency,
            status: "CLOSED",
            exitPrice: exitPrice ?? undefined,
            exitAt: a.createdAt,
            exitAlertId: a.id,
            holdDays,
            pnl,
            pnlPct,
          },
        });
        // 标记内存态已平（仅当来自内存数组）
        const mem = opens.find((o) => o.id === open.id);
        if (mem) mem.status = "CLOSED";
        closedOpen++;
      }
    }
  }

  console.log(
    `[backfill-positions] 完成：新建 OPEN=${createdOpen}，平仓=${closedOpen}，` +
      `跳过(已存在 buy)=${skippedBuy}，跳过(已存在 sell)=${skippedSell}；` +
      `扫描 alert=${alerts.length}，分组=${groups.size}`
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[backfill-positions] 失败:", err);
  process.exit(1);
});
