import { prisma } from "./prisma";
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

export async function listFavorites(): Promise<Favorite[]> {
  const rows = await prisma.favorite.findMany({
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapFavorite);
}

export async function isFavorite(ticker: string): Promise<boolean> {
  const count = await prisma.favorite.count({
    where: { ticker: ticker.toUpperCase() },
  });
  return count > 0;
}

export async function addFavorite(
  ticker: string,
  data?: { name?: string; note?: string; tags?: string[] }
): Promise<Favorite> {
  const row = await prisma.favorite.upsert({
    where: { ticker: ticker.toUpperCase() },
    update: {
      name: data?.name,
      note: data?.note,
      tags: data?.tags ? JSON.stringify(data.tags) : undefined,
    },
    create: {
      ticker: ticker.toUpperCase(),
      name: data?.name,
      note: data?.note,
      tags: data?.tags ? JSON.stringify(data.tags) : null,
    },
  });
  return mapFavorite(row);
}

export async function removeFavorite(ticker: string): Promise<void> {
  await prisma.favorite.delete({
    where: { ticker: ticker.toUpperCase() },
  });
}

export async function updateFavorite(
  ticker: string,
  data: { name?: string; note?: string; tags?: string[] }
): Promise<Favorite> {
  const row = await prisma.favorite.update({
    where: { ticker: ticker.toUpperCase() },
    data: {
      name: data.name,
      note: data.note,
      tags: data.tags ? JSON.stringify(data.tags) : undefined,
    },
  });
  return mapFavorite(row);
}
