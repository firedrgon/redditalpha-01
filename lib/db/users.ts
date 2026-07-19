import { getPrisma } from "./prisma";

export interface AuthUserRecord {
  id: string;
  email: string | null;
  name: string | null;
  passwordHash: string | null;
  isAdmin: boolean;
}

export async function getUserByEmail(email: string): Promise<AuthUserRecord | null> {
  const prisma = getPrisma();
  if (!prisma) return null;

  return prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      isAdmin: true,
    },
  });
}

export async function createUserWithPassword(input: {
  email: string;
  passwordHash: string;
  name?: string | null;
}): Promise<AuthUserRecord> {
  const prisma = getPrisma();
  if (!prisma) {
    throw new Error("数据库未配置，无法创建用户");
  }

  return prisma.user.create({
    data: {
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      name: input.name?.trim() || null,
    },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      isAdmin: true,
    },
  });
}

export async function promoteFirstAdminAndMigrateLegacyFavorites(
  userId: string
): Promise<{ promoted: boolean; migratedCount: number }> {
  const prisma = getPrisma();
  if (!prisma) {
    throw new Error("数据库未配置，无法初始化管理员账号");
  }

  return prisma.$transaction(async (tx) => {
    const currentUser = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, isAdmin: true },
    });

    if (!currentUser) {
      throw new Error(`用户不存在: ${userId}`);
    }

    if (currentUser.isAdmin) {
      return { promoted: false, migratedCount: 0 };
    }

    const adminCount = await tx.user.count({
      where: { isAdmin: true },
    });

    if (adminCount > 0) {
      return { promoted: false, migratedCount: 0 };
    }

    await tx.user.update({
      where: { id: userId },
      data: { isAdmin: true },
    });

    const migrated = await tx.favorite.updateMany({
      where: { userId: null },
      data: { userId },
    });

    return { promoted: true, migratedCount: migrated.count };
  });
}
