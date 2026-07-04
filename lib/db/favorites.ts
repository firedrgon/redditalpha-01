import { getPrisma } from "./prisma";
import type { Favorite as PrismaFavorite } from "@prisma/client";

export interface Favorite {
  id: string;
  ticker: string;
  name?: string | null;
  note?: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

const memoryFavorites: Map<string, Favorite> = new Map();

function mapFavorite(r: PrismaFavorite): Favorite {
  return {
    id: r.id,
    ticker: r.ticker,
    name: r.name,
    note: r.note,
    tags: r.tags ? JSON.parse(r.tags) : [],
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

function getMemoryAll(): Favorite[] {
  return Array.from(memoryFavorites.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
}

export async function listFavorites(): Promise<Favorite[]> {
  const prisma = getPrisma();
  if (!prisma) return getMemoryAll();

  try {
    const rows = await prisma.favorite.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapFavorite);
  } catch {
    return getMemoryAll();
  }
}

export async function addFavorite(
  ticker: string,
  data?: { name?: string; note?: string; tags?: string[] }
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    const existing = memoryFavorites.get(upper);
    const now = Date.now();
    const fav: Favorite = existing
      ? { ...existing, name: data?.name ?? existing.name, note: data?.note ?? existing.note, tags: data?.tags ?? existing.tags, updatedAt: now }
      : {
          id: `fav-${now}-${Math.random().toString(36).slice(2, 6)}`,
          ticker: upper,
          name: data?.name ?? null,
          note: data?.note ?? null,
          tags: data?.tags ?? [],
          createdAt: now,
          updatedAt: now,
        };
    memoryFavorites.set(upper, fav);
    return fav;
  }

  try {
    const row = await prisma.favorite.upsert({
      where: { ticker: upper },
      update: {
        name: data?.name,
        note: data?.note,
        tags: data?.tags ? JSON.stringify(data.tags) : undefined,
      },
      create: {
        ticker: upper,
        name: data?.name,
        note: data?.note,
        tags: data?.tags ? JSON.stringify(data.tags) : null,
      },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryFavorites.get(upper);
    const now = Date.now();
    const fav: Favorite = existing
      ? { ...existing, name: data?.name ?? existing.name, note: data?.note ?? existing.note, tags: data?.tags ?? existing.tags, updatedAt: now }
      : {
          id: `fav-${now}-${Math.random().toString(36).slice(2, 6)}`,
          ticker: upper,
          name: data?.name ?? null,
          note: data?.note ?? null,
          tags: data?.tags ?? [],
          createdAt: now,
          updatedAt: now,
        };
    memoryFavorites.set(upper, fav);
    return fav;
  }
}

export async function removeFavorite(ticker: string): Promise<void> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    memoryFavorites.delete(upper);
    return;
  }

  try {
    await prisma.favorite.delete({
      where: { ticker: upper },
    });
  } catch {
    memoryFavorites.delete(upper);
  }
}

export async function updateFavorite(
  ticker: string,
  data: { name?: string; note?: string; tags?: string[] }
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    const existing = memoryFavorites.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated = { ...existing, ...data, updatedAt: Date.now() };
    memoryFavorites.set(upper, updated);
    return updated;
  }

  try {
    const row = await prisma.favorite.update({
      where: { ticker: upper },
      data: {
        name: data.name,
        note: data.note,
        tags: data.tags ? JSON.stringify(data.tags) : undefined,
      },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryFavorites.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated = { ...existing, ...data, updatedAt: Date.now() };
    memoryFavorites.set(upper, updated);
    return updated;
  }
}

export async function isFavorite(ticker: string): Promise<boolean> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) return memoryFavorites.has(upper);

  try {
    const count = await prisma.favorite.count({
      where: { ticker: upper },
    });
    return count > 0;
  } catch {
    return memoryFavorites.has(upper);
  }
}
