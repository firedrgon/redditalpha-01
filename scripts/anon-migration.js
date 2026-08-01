// 把此前「公开化」遗留的 userId=NULL 行迁移为匿名哨兵 __anon__，
// 使旧的全站公开收藏/持仓并入匿名资金池，避免数据孤儿化。
// 幂等：只处理 userId IS NULL 的行，重复运行安全。
// 必须在 prisma db push 之后执行（确保 userId 列与唯一索引已存在）。
const { PrismaClient } = require("@prisma/client");

const ANON = "__anon__";

async function main() {
  const prisma = new PrismaClient();
  try {
    // Favorite 有 (userId,ticker) 唯一约束：先按 ticker 去重（保留 id 最大的行），
    // 否则回填 __anon__ 后可能触发唯一冲突。
    try {
      await prisma.$executeRawUnsafe(`
        DELETE FROM "Favorite" a
        USING "Favorite" b
        WHERE a."userId" IS NULL AND b."userId" IS NULL
          AND a."ticker" = b."ticker" AND a."id" < b."id"
      `);
    } catch (e) {
      console.warn("⚠️ Favorite 去重跳过（可能列尚不存在）:", e.message);
    }

    const fav = await prisma.$executeRawUnsafe(
      `UPDATE "Favorite" SET "userId" = '${ANON}' WHERE "userId" IS NULL`
    );
    const pos = await prisma.$executeRawUnsafe(
      `UPDATE "Position" SET "userId" = '${ANON}' WHERE "userId" IS NULL`
    );
    const f = typeof fav === "number" ? fav : fav?.count ?? "?";
    const p = typeof pos === "number" ? pos : pos?.count ?? "?";
    console.log(`✅ anon 迁移完成: Favorite ${f} 行, Position ${p} 行 -> ${ANON}`);
  } catch (e) {
    console.warn("⚠️ anon 迁移失败（非致命，可忽略）:", e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
