// 确保匿名哨兵用户 __anon__ 存在。
// 公开资金池（Position / SignalAlert / Favorite）都以 __anon__ 作为 userId 归属，
// 这些列的 userId 是 NOT NULL + FK(User.id)，因此该用户必须存在，否则所有
// 「公开池」写入都会因外键约束失败（P2011 / 外键违反）。
// 此前 db-setup 漏建此用户，导致 anon 公开池逻辑悬空。此处幂等补齐。
const { PrismaClient } = require("@prisma/client");

const ANON = "__anon__";
const ANON_EMAIL = "__anon__@system.local";

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { id: ANON } });
    if (existing) {
      console.log("✅ anon 哨兵用户已存在:", ANON);
      return;
    }
    await prisma.user.create({
      data: { id: ANON, email: ANON_EMAIL, name: "匿名公开池" },
    });
    console.log("✅ 已创建 anon 哨兵用户:", ANON);
  } catch (e) {
    console.warn("⚠️ 创建 anon 用户失败（非致命，可忽略）:", e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
