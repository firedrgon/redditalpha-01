const { execSync } = require("child_process");

function getDbUrl() {
  // Vercel Postgres (Neon) 会注入 POSTGRES_PRISMA_URL / POSTGRES_URL；
  // 通用场景下也可直接配置 DATABASE_URL。
  return (
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

function main() {
  const dbUrl = getDbUrl();

  console.log("🔧 Generating Prisma Client...");
  execSync("npx prisma generate", { stdio: "inherit" });

  if (!dbUrl) {
    // 本地未配置数据库时，仅生成 client 即可。
    // 运行时 getPrisma() 会返回 null，数据层自动降级到内存模式，
    // 便于本地开发无需安装 Postgres 也能跑起来（数据不持久）。
    console.log("ℹ️  No DATABASE_URL configured, skipping db push (in-memory mode at runtime)");
    return;
  }

  process.env.DATABASE_URL = dbUrl;

  // 清理 FinanceSnapshot 重复数据：必须在 db push 之前执行，
  // 否则新增的 ticker @unique 约束会因历史重复行而创建失败。
  // 脚本通过 AppSetting 标记保证只执行一次，后续部署自动跳过。
  console.log("🧹 Running FinanceSnapshot cleanup (idempotent, runs once)...");
  try {
    execSync("node scripts/finance-snapshot-cleanup.js", { stdio: "inherit" });
  } catch (err) {
    console.warn("⚠️  FinanceSnapshot cleanup failed (continuing):", err.message);
  }

  console.log("📊 Pushing database schema...");
  try {
    execSync("npx prisma db push --skip-generate", { stdio: "inherit" });
    console.log("✅ Database schema synced successfully");
  } catch (err) {
    console.warn("⚠️  Database schema push failed (continuing build anyway):", err.message);
  }

  // 公开化遗留的 userId=NULL 行迁移为匿名哨兵 __anon__（幂等，非致命）。
  console.log("🔄 Migrating legacy NULL userId rows to anon pool...");
  try {
    execSync("node scripts/anon-migration.js", { stdio: "inherit" });
  } catch (err) {
    console.warn("⚠️  anon migration failed (non-fatal, continuing):", err.message);
  }

  // 确保匿名哨兵用户 __anon__ 存在（公开池外键归属所必需，幂等，非致命）。
  console.log("👤 Ensuring anon sentinel user exists...");
  try {
    execSync("node scripts/ensure-anon-user.js", { stdio: "inherit" });
  } catch (err) {
    console.warn("⚠️  ensure anon user failed (non-fatal, continuing):", err.message);
  }
}

main();
