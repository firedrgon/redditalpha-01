import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let prismaClient: PrismaClient | null = null;
let initAttempted = false;
let initError: Error | null = null;

function resolveDatabaseUrl(): string | null {
  return (
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

export function getPrisma(): PrismaClient | null {
  if (initAttempted) {
    return prismaClient;
  }
  initAttempted = true;

  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    initError = new Error("No database URL configured");
    return null;
  }

  try {
    if (globalForPrisma.prisma) {
      prismaClient = globalForPrisma.prisma;
      return prismaClient;
    }
    prismaClient = new PrismaClient({
      datasourceUrl: dbUrl,
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
    if (process.env.NODE_ENV !== "production") {
      globalForPrisma.prisma = prismaClient;
    }
    return prismaClient;
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    prismaClient = null;
    return null;
  }
}

export function isDbAvailable(): boolean {
  return getPrisma() !== null;
}

export function getDbInitError(): Error | null {
  getPrisma();
  return initError;
}
