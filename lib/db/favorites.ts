import { getPrisma } from "./prisma";
import type { Favorite as PrismaFavorite } from "@prisma/client";

export interface Favorite {
  id: string;
  userId?: string | null;
  ticker: string;
  name?: string | null;
  note?: string | null;
  tags: string[];
  pinned: boolean;
  pinnedAt: number | null;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
}

const memoryFavoritesByUser: Map<string, Map<string, Favorite>> = new Map();

function getMemoryStore(userId: string): Map<string, Favorite> {
  const store = memoryFavoritesByUser.get(userId);
  if (store) return store;
  const next = new Map<string, Favorite>();
  memoryFavoritesByUser.set(userId, next);
  return next;
}

function mapFavorite(r: PrismaFavorite): Favorite {
  return {
    id: r.id,
    userId: r.userId,
    ticker: r.ticker,
    name: r.name,
    note: r.note,
    tags: r.tags ? JSON.parse(r.tags) : [],
    pinned: r.pinned,
    pinnedAt: r.pinnedAt ? r.pinnedAt.getTime() : null,
    starred: r.starred,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

/**
 * 排序：置顶项优先（按 pinnedAt 降序，null 在后），非置顶项按 createdAt 降序
 */
function sortFavorites(list: Favorite[]): Favorite[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const aT = a.pinnedAt ?? 0;
      const bT = b.pinnedAt ?? 0;
      return bT - aT;
    }
    return b.createdAt - a.createdAt;
  });
}

function getMemoryAll(userId: string): Favorite[] {
  return sortFavorites(Array.from(getMemoryStore(userId).values()));
}

export async function listFavorites(userId: string): Promise<Favorite[]> {
  const prisma = getPrisma();
  if (!prisma) return getMemoryAll(userId);

  try {
    const rows = await prisma.favorite.findMany({
      where: { userId },
      orderBy: [{ pinned: "desc" }, { pinnedAt: "desc" }, { createdAt: "desc" }],
    });
    return sortFavorites(rows.map(mapFavorite));
  } catch {
    return getMemoryAll(userId);
  }
}

export async function addFavorite(
  userId: string,
  ticker: string,
  data?: { name?: string; note?: string; tags?: string[] }
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  const memoryStore = getMemoryStore(userId);
  if (!prisma) {
    const existing = memoryStore.get(upper);
    const now = Date.now();
    const fav: Favorite = existing
      ? { ...existing, name: data?.name ?? existing.name, note: data?.note ?? existing.note, tags: data?.tags ?? existing.tags, updatedAt: now }
      : {
          id: `fav-${now}-${Math.random().toString(36).slice(2, 6)}`,
          userId,
          ticker: upper,
          name: data?.name ?? null,
          note: data?.note ?? null,
          tags: data?.tags ?? [],
          pinned: false,
          pinnedAt: null,
          starred: false,
          createdAt: now,
          updatedAt: now,
        };
    memoryStore.set(upper, fav);
    return fav;
  }

  try {
    const row = await prisma.favorite.upsert({
      where: { userId_ticker: { userId, ticker: upper } },
      update: {
        name: data?.name,
        note: data?.note,
        tags: data?.tags ? JSON.stringify(data.tags) : undefined,
      },
      create: {
        userId,
        ticker: upper,
        name: data?.name,
        note: data?.note,
        tags: data?.tags ? JSON.stringify(data.tags) : null,
      },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryStore.get(upper);
    const now = Date.now();
    const fav: Favorite = existing
      ? { ...existing, name: data?.name ?? existing.name, note: data?.note ?? existing.note, tags: data?.tags ?? existing.tags, updatedAt: now }
      : {
          id: `fav-${now}-${Math.random().toString(36).slice(2, 6)}`,
          userId,
          ticker: upper,
          name: data?.name ?? null,
          note: data?.note ?? null,
          tags: data?.tags ?? [],
          pinned: false,
          pinnedAt: null,
          starred: false,
          createdAt: now,
          updatedAt: now,
        };
    memoryStore.set(upper, fav);
    return fav;
  }
}

/**
 * 设置收藏项的置顶状态
 * 置顶时记录 pinnedAt（用于置顶项之间的排序），取消置顶时清空
 */
export async function setPinned(
  userId: string,
  ticker: string,
  pinned: boolean
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  const memoryStore = getMemoryStore(userId);
  if (!prisma) {
    const existing = memoryStore.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const now = Date.now();
    const updated: Favorite = {
      ...existing,
      pinned,
      pinnedAt: pinned ? now : null,
      updatedAt: now,
    };
    memoryStore.set(upper, updated);
    return updated;
  }

  try {
    const row = await prisma.favorite.update({
      where: { userId_ticker: { userId, ticker: upper } },
      data: {
        pinned,
        pinnedAt: pinned ? new Date() : null,
      },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryStore.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const now = Date.now();
    const updated: Favorite = {
      ...existing,
      pinned,
      pinnedAt: pinned ? now : null,
      updatedAt: now,
    };
    memoryStore.set(upper, updated);
    return updated;
  }
}

/**
 * 设置收藏项的关注状态
 */
export async function setStarred(
  userId: string,
  ticker: string,
  starred: boolean
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  const memoryStore = getMemoryStore(userId);
  if (!prisma) {
    const existing = memoryStore.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated: Favorite = {
      ...existing,
      starred,
      updatedAt: Date.now(),
    };
    memoryStore.set(upper, updated);
    return updated;
  }

  try {
    const row = await prisma.favorite.update({
      where: { userId_ticker: { userId, ticker: upper } },
      data: { starred },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryStore.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated: Favorite = {
      ...existing,
      starred,
      updatedAt: Date.now(),
    };
    memoryStore.set(upper, updated);
    return updated;
  }
}

export async function removeFavorite(userId: string, ticker: string): Promise<number> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  const memoryStore = getMemoryStore(userId);
  if (!prisma) {
    const existed = memoryStore.delete(upper);
    return existed ? 1 : 0;
  }

  // 用 deleteMany 而非 delete：deleteMany 在记录不存在时返回 {count:0}
  // 而非抛 P2025，让调用方明确知道是否真的删除了记录。
  try {
    const result = await prisma.favorite.deleteMany({
      where: { userId, ticker: upper },
    });
    return result.count;
  } catch (err) {
    console.error("[favorites] removeFavorite DB error:", err);
    throw err;
  }
}

export async function updateFavorite(
  userId: string,
  ticker: string,
  data: { name?: string; note?: string; tags?: string[] }
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  const memoryStore = getMemoryStore(userId);
  if (!prisma) {
    const existing = memoryStore.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated = { ...existing, ...data, updatedAt: Date.now() };
    memoryStore.set(upper, updated);
    return updated;
  }

  try {
    const row = await prisma.favorite.update({
      where: { userId_ticker: { userId, ticker: upper } },
      data: {
        name: data.name,
        note: data.note,
        tags: data.tags ? JSON.stringify(data.tags) : undefined,
      },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryStore.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated = { ...existing, ...data, updatedAt: Date.now() };
    memoryStore.set(upper, updated);
    return updated;
  }
}

export async function isFavorite(userId: string, ticker: string): Promise<boolean> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) return getMemoryStore(userId).has(upper);

  try {
    const count = await prisma.favorite.count({
      where: { userId, ticker: upper },
    });
    return count > 0;
  } catch {
    return getMemoryStore(userId).has(upper);
  }
}
