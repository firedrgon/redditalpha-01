import { auth } from "@/auth";

/** 匿名（未登录）用户的虚拟 userId 哨兵值。
 * 用哨兵代替 NULL：避免 Prisma 复合唯一约束 (userId,ticker) 在 NULL 下不唯一，
 * 也规避「可为空字段不能用于唯一 where」的类型限制。 */
export const ANON_USER_ID = "__anon__";

export interface SessionUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/**
 * 在服务端（Route Handler / Server Component）获取当前登录用户。
 * 未登录返回 null。NextAuth v5 + Prisma Adapter（database 策略）下，
 * session.user 会携带 adapter 提供的 id（来自 User 表）。
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) return null;
  const u = session!.user as {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
  return { id, ...u };
}
