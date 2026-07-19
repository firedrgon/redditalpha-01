import { NextRequest, NextResponse } from "next/server";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  updateFavorite,
  setPinned,
  setStarred,
} from "@/lib/db";
import { detectMarket, normalizeCNTicker } from "@/lib/market";
import { requireUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** 规范化 ticker：A 股补全 .SH/.SZ 后缀，美股统一大写 */
function normalizeTicker(raw: string): string {
  const t = raw.trim();
  if (detectMarket(t) === "CN") {
    return normalizeCNTicker(t) ?? t.toUpperCase();
  }
  return t.toUpperCase();
}

export async function GET(request: NextRequest) {
  const { user } = await requireUser();
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");

  if (!user) {
    if (ticker) {
      const normalized = normalizeTicker(ticker);
      return NextResponse.json({
        ticker: normalized,
        isFavorite: false,
        requiresAuth: true,
      });
    }
    return NextResponse.json({ favorites: [], requiresAuth: true });
  }

  if (ticker) {
    const normalized = normalizeTicker(ticker);
    const fav = await isFavorite(user.id, normalized);
    return NextResponse.json({ ticker: normalized, isFavorite: fav });
  }

  const favorites = await listFavorites(user.id);
  return NextResponse.json({ favorites });
}

interface AddBody {
  ticker: string;
  name?: string;
  note?: string;
  tags?: string[];
}

export async function POST(request: NextRequest) {
  const { user, response } = await requireUser();
  if (response || !user) return response;

  const body = (await request.json().catch(() => ({}))) as AddBody;
  const ticker = normalizeTicker(body.ticker ?? "");

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  const fav = await addFavorite(user.id, ticker, {
    name: body.name,
    note: body.note,
    tags: body.tags,
  });

  return NextResponse.json({ favorite: fav });
}

interface PatchBody {
  ticker: string;
  name?: string;
  note?: string;
  tags?: string[];
  pinned?: boolean; // 置顶 / 取消置顶
  starred?: boolean; // 关注 / 取消关注
}

export async function PATCH(request: NextRequest) {
  const { user, response } = await requireUser();
  if (response || !user) return response;

  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const ticker = normalizeTicker(body.ticker ?? "");

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  // 置顶 / 取消置顶走独立逻辑（不影响 name/note/tags）
  if (typeof body.pinned === "boolean") {
    try {
      const fav = await setPinned(user.id, ticker, body.pinned);
      return NextResponse.json({ favorite: fav });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 404 }
      );
    }
  }

  // 关注 / 取消关注走独立逻辑
  if (typeof body.starred === "boolean") {
    try {
      const fav = await setStarred(user.id, ticker, body.starred);
      return NextResponse.json({ favorite: fav });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 404 }
      );
    }
  }

  try {
    const fav = await updateFavorite(user.id, ticker, {
      name: body.name,
      note: body.note,
      tags: body.tags,
    });
    return NextResponse.json({ favorite: fav });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const { user, response } = await requireUser();
  if (response || !user) return response;

  const { searchParams } = new URL(request.url);
  const rawTicker = searchParams.get("ticker");

  if (!rawTicker) {
    return NextResponse.json({ error: "缺少 ticker 参数" }, { status: 400 });
  }

  const normalized = normalizeTicker(rawTicker);
  const rawUpper = rawTicker.trim().toUpperCase();

  // 同时尝试规范化和原始形式，处理历史未规范化的 DB 数据
  // （例如旧数据存的是 "600267" 而非 "600267.SH"）
  const candidates = [...new Set([normalized, rawUpper])];

  try {
    let totalDeleted = 0;
    for (const t of candidates) {
      totalDeleted += await removeFavorite(user.id, t);
    }

    return NextResponse.json({
      success: true,
      deleted: totalDeleted,
      tried: candidates,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
