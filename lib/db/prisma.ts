import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let prismaClient: PrismaClient | null = null;
let initError: Error | null = null;

function resolveDatabaseUrl(): string | null {
  return (
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

/**
 * 获取 PrismaClient 单例。
 *
 * 注意：此前版本用 `initAttempted` 一次性开关，冷启动失败后该 serverless 实例
 * 生命周期内永不重试，导致 getPrisma() 永远返回 null，数据层全部降级到内存 Map，
 * 进而出现"DB 删了数据页面仍显示旧数据"的故障。现已改为可重试。
 *
 * 返回 null 仅代表「未配置 DATABASE_URL」——此时本地开发可走内存降级。
 * 若配置了 URL 但连接失败，错误会在实际查询时抛出，由调用方处理。
 */
export function getPrisma(): PrismaClient | null {
  // 已有客户端（含跨实例复用的 globalForPrisma）直接返回
  if (prismaClient) return prismaClient;
  if (globalForPrisma.prisma) {
    prismaClient = globalForPrisma.prisma;
    return prismaClient;
  }

  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    // 未配置数据库 URL：本地开发场景，调用方走内存降级
    initError = new Error("No database URL configured");
    return null;
  }

  try {
    prismaClient = new PrismaClient({
      datasourceUrl: dbUrl,
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
    if (process.env.NODE_ENV !== "production") {
      globalForPrisma.prisma = prismaClient;
    }
    initError = null;
    return prismaClient;
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    prismaClient = null;
    console.error("[prisma] PrismaClient 初始化失败:", initError.message);
    return null;
  }
}

export function isDbAvailable(): boolean {
  return resolveDatabaseUrl() !== null;
}

export function getDbInitError(): Error | null {
  return initError;
}
