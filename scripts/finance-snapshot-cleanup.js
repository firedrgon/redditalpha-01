/**
 * FinanceSnapshot 重复数据清理脚本（一次性）
 *
 * 背景：schema 给 FinanceSnapshot.ticker 加了 @unique 约束，要求每个 ticker
 * 只保留一条快照。但历史库里同一 ticker 可能按 snapshotDate 累积了多条记录，
 * 直接 prisma db push 会因唯一约束冲突而失败。本脚本在 db push 之前执行，
 * 按 ticker 分组、保留最新一条（snapshotDate 最大），删除其余。
 *
 * 幂等 & 只跑一次：通过 AppSetting 表的 marker 记录是否已清理。
 *  - 首次部署（升级现有库）：删除重复 → 写入 marker → 后续部署命中 marker 跳过。
 *  - 全新数据库：FinanceSnapshot 表不存在 / 无数据，清理为 no-op；
 *    AppSetting 表可能尚未创建，marker 写入失败，下次部署再写（无害，因为清理本身是 no-op）。
 *
 * 失败不阻塞部署：任何异常都只打 warning，让 db-setup.js 继续执行 db push。
 */

const { PrismaClient } = require("@prisma/client");

const MARKER_KEY = "finance_snapshot_cleanup_v1";

function getDbUrl() {
  return (
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

async function isCleanupDone(prisma) {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: MARKER_KEY },
    });
    return !!row;
  } catch {
    // AppSetting 表尚未创建（全新数据库首次部署）→ 视为未完成
    return false;
  }
}

async function markCleanupDone(prisma) {
  try {
    await prisma.appSetting.upsert({
      where: { key: MARKER_KEY },
      create: {
        key: MARKER_KEY,
        value: JSON.stringify({ doneAt: new Date().toISOString() }),
      },
      update: {
        value: JSON.stringify({ doneAt: new Date().toISOString() }),
      },
    });
    return true;
  } catch {
    // AppSetting 表尚未创建（db push 还没跑）→ 本次不写标记，下次部署再写
    return false;
  }
}

async function cleanupDuplicates(prisma) {
  let rows;
  try {
    // 按 ticker 升序、snapshotDate 降序拉取全部快照
    rows = await prisma.financeSnapshot.findMany({
      select: { id: true, ticker: true, snapshotDate: true },
      orderBy: [{ ticker: "asc" }, { snapshotDate: "desc" }],
    });
  } catch {
    // FinanceSnapshot 表尚未创建（全新数据库）→ 无需清理
    console.log("ℹ️  FinanceSnapshot table not found, nothing to clean.");
    return 0;
  }

  // 每个 ticker 保留第一条（最新），其余收集到待删除列表
  const seen = new Set();
  const idsToDelete = [];
  for (const row of rows) {
    if (seen.has(row.ticker)) {
      idsToDelete.push(row.id);
    } else {
      seen.add(row.ticker);
    }
  }

  if (idsToDelete.length === 0) {
    console.log("✅ No duplicate FinanceSnapshot rows found.");
    return 0;
  }

  const result = await prisma.financeSnapshot.deleteMany({
    where: { id: { in: idsToDelete } },
  });
  console.log(
    `✅ Deleted ${result.count} duplicate FinanceSnapshot rows across ${seen.size} tickers (kept latest per ticker).`
  );
  return result.count;
}

async function main() {
  const dbUrl = getDbUrl();
  if (!dbUrl) {
    console.log("ℹ️  No DATABASE_URL configured, skipping FinanceSnapshot cleanup.");
    return;
  }

  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  try {
    if (await isCleanupDone(prisma)) {
      console.log("ℹ️  FinanceSnapshot cleanup already done (marker found), skipping.");
      return;
    }

    const deleted = await cleanupDuplicates(prisma);
    const marked = await markCleanupDone(prisma);
    if (!marked) {
      console.log(
        "ℹ️  Marker not written (AppSetting table may not exist yet); will retry on next deploy."
      );
    } else if (deleted === 0) {
      console.log("✅ Cleanup marked as done (no duplicates existed).");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // 清理失败不阻塞部署：db push 仍会尝试执行
  console.error("⚠️  FinanceSnapshot cleanup failed:", err?.message || err);
  process.exitCode = 0;
});
