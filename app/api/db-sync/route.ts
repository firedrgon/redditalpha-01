import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

/**
 * 手动同步数据库 schema。
 *
 * 当 Vercel 部署时 `prisma db push` 失败（如 build 阶段 DB 连接不可用），
 * 访问此端点可手动执行 schema 同步（添加缺失列、约束等）。
 *
 * 使用方式：部署后访问 /api/db-sync
 */
export async function GET() {
  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json(
      { error: "数据库未配置", success: false },
      { status: 500 }
    );
  }

  const results: string[] = [];

  // 1. AnalysisCache: 确保 technicalSignals 列存在
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AnalysisCache" ADD COLUMN IF NOT EXISTS "technicalSignals" TEXT`
    );
    results.push("✅ AnalysisCache.technicalSignals 列已就绪");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 如果列已存在，忽略错误
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      results.push("ℹ️ AnalysisCache.technicalSignals 列已存在");
    } else {
      results.push(`❌ AnalysisCache.technicalSignals 失败: ${msg}`);
    }
  }

  // 2. FinanceSnapshot: 确保 ticker 唯一约束
  try {
    // 先检查约束是否存在
    const constraintCheck = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*) as cnt FROM pg_constraint WHERE conname = 'FinanceSnapshot_ticker_key'`
    );
    if (Number(constraintCheck[0]?.cnt ?? 0) === 0) {
      // 先清理可能的重复数据（保留每个 ticker 最新的一条）
      await prisma.$executeRawUnsafe(
        `DELETE FROM "FinanceSnapshot" WHERE id NOT IN (
          SELECT DISTINCT ON (ticker) id FROM "FinanceSnapshot" ORDER BY ticker, "snapshotDate" DESC
        )`
      );
      // 添加唯一约束
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "FinanceSnapshot" ADD CONSTRAINT "FinanceSnapshot_ticker_key" UNIQUE ("ticker")`
      );
      results.push("✅ FinanceSnapshot.ticker 唯一约束已添加");
    } else {
      results.push("ℹ️ FinanceSnapshot.ticker 唯一约束已存在");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push(`❌ FinanceSnapshot 约束失败: ${msg}`);
  }

  // 3. 验证：检查表结构
  try {
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'AnalysisCache' ORDER BY ordinal_position`
    );
    const colNames = columns.map((c) => c.column_name);
    results.push(`📋 AnalysisCache 列: ${colNames.join(", ")}`);
  } catch (err) {
    results.push(`⚠️ 无法查询表结构: ${err instanceof Error ? err.message : String(err)}`);
  }

  const allSuccess = results.every((r) => !r.startsWith("❌"));

  return NextResponse.json({
    success: allSuccess,
    results,
    timestamp: new Date().toISOString(),
  });
}
