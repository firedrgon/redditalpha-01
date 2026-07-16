import { getPrisma } from "./prisma";
import type { Favorite as PrismaFavorite } from "@prisma/client";

export interface Favorite {
  id: string;
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

const memoryFavorites: Map<string, Favorite> = new Map();

function mapFavorite(r: PrismaFavorite): Favorite {
  return {
    id: r.id,
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

function getMemoryAll(): Favorite[] {
  return sortFavorites(Array.from(memoryFavorites.values()));
}

export async function listFavorites(): Promise<Favorite[]> {
  const prisma = getPrisma();
  if (!prisma) return getMemoryAll();

  try {
    const rows = await prisma.favorite.findMany({
      orderBy: [{ pinned: "desc" }, { pinnedAt: "desc" }, { createdAt: "desc" }],
    });
    return sortFavorites(rows.map(mapFavorite));
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
          pinned: false,
          pinnedAt: null,
          starred: false,
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
          pinned: false,
          pinnedAt: null,
          starred: false,
          createdAt: now,
          updatedAt: now,
        };
    memoryFavorites.set(upper, fav);
    return fav;
  }
}

/**
 * 设置收藏项的置顶状态
 * 置顶时记录 pinnedAt（用于置顶项之间的排序），取消置顶时清空
 */
export async function setPinned(
  ticker: string,
  pinned: boolean
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    const existing = memoryFavorites.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const now = Date.now();
    const updated: Favorite = {
      ...existing,
      pinned,
      pinnedAt: pinned ? now : null,
      updatedAt: now,
    };
    memoryFavorites.set(upper, updated);
    return updated;
  }

  try {
    const row = await prisma.favorite.update({
      where: { ticker: upper },
      data: {
        pinned,
        pinnedAt: pinned ? new Date() : null,
      },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryFavorites.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const now = Date.now();
    const updated: Favorite = {
      ...existing,
      pinned,
      pinnedAt: pinned ? now : null,
      updatedAt: now,
    };
    memoryFavorites.set(upper, updated);
    return updated;
  }
}

/**
 * 设置收藏项的关注状态
 */
export async function setStarred(
  ticker: string,
  starred: boolean
): Promise<Favorite> {
  const upper = ticker.toUpperCase();
  const prisma = getPrisma();
  if (!prisma) {
    const existing = memoryFavorites.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated: Favorite = {
      ...existing,
      starred,
      updatedAt: Date.now(),
    };
    memoryFavorites.set(upper, updated);
    return updated;
  }

  try {
    const row = await prisma.favorite.update({
      where: { ticker: upper },
      data: { starred },
    });
    return mapFavorite(row);
  } catch {
    const existing = memoryFavorites.get(upper);
    if (!existing) throw new Error("收藏不存在");
    const updated: Favorite = {
      ...existing,
      starred,
      updatedAt: Date.now(),
    };
    memoryFavorites.set(upper, updated);
    return updated;
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
  } catch (err) {
    // P2025 = 记录不存在，删除是幂等的，不算错误。
    // 其他错误（连接失败、schema 不匹配等）必须上抛，
    // 否则 API 返回 success 但记录仍在 DB 中，刷新后「移除不生效」。
    const code =
      (err as { code?: string })?.code ?? "";
    if (code === "P2025") {
      memoryFavorites.delete(upper);
      return;
    }
    console.error("[favorites] removeFavorite DB error:", err);
    throw err;
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
