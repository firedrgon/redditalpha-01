import { NextRequest, NextResponse } from "next/server";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  updateFavorite,
  setPinned,
  setStarred,
  clearAnalysis,
} from "@/lib/db";
import { detectMarket, normalizeCNTicker } from "@/lib/market";

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
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");

  if (ticker) {
    const normalized = normalizeTicker(ticker);
    const fav = await isFavorite(normalized);
    return NextResponse.json({ ticker: normalized, isFavorite: fav });
  }

  const favorites = await listFavorites();
  return NextResponse.json({ favorites });
}

interface AddBody {
  ticker: string;
  name?: string;
  note?: string;
  tags?: string[];
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as AddBody;
  const ticker = normalizeTicker(body.ticker ?? "");

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  const fav = await addFavorite(ticker, {
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
  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const ticker = normalizeTicker(body.ticker ?? "");

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  // 置顶 / 取消置顶走独立逻辑（不影响 name/note/tags）
  if (typeof body.pinned === "boolean") {
    try {
      const fav = await setPinned(ticker, body.pinned);
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
      const fav = await setStarred(ticker, body.starred);
      return NextResponse.json({ favorite: fav });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 404 }
      );
    }
  }

  try {
    const fav = await updateFavorite(ticker, {
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
  const { searchParams } = new URL(request.url);
  const rawTicker = searchParams.get("ticker");

  if (!rawTicker) {
    return NextResponse.json({ error: "缺少 ticker 参数" }, { status: 400 });
  }

  const ticker = normalizeTicker(rawTicker);

  try {
    await removeFavorite(ticker);
    // 同步清除该 ticker 的分析记录，避免残留无主数据。
    // 删除失败不影响收藏删除的主流程。
    try {
      await clearAnalysis(ticker);
    } catch (cacheErr) {
      console.error("[favorites] clearAnalysis failed:", cacheErr);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 }
    );
  }
}
