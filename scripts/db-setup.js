const { execSync } = require("child_process");

function getDbUrl() {
  return (
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

function main() {
  const dbUrl = getDbUrl();

  if (!dbUrl) {
    console.log("ℹ️  No database URL configured, skipping db push");
    process.env.DATABASE_URL = "file:./dev.db";
    execSync("npx prisma generate", { stdio: "inherit" });
    return;
  }

  process.env.DATABASE_URL = dbUrl;

  console.log("🔧 Generating Prisma Client...");
  execSync("npx prisma generate", { stdio: "inherit" });

  console.log("📊 Pushing database schema...");
  try {
    execSync("npx prisma db push --skip-generate", { stdio: "inherit" });
    console.log("✅ Database schema synced successfully");
  } catch (err) {
    console.warn("⚠️  Database schema push failed (continuing build anyway):", err.message);
  }
}

main();
