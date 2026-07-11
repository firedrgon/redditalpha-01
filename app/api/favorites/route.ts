import { NextRequest, NextResponse } from "next/server";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  updateFavorite,
  setPinned,
  setStarred,
  clearCachedAnalysisDB as clearCachedAnalysis,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");

  if (ticker) {
    const fav = await isFavorite(ticker);
    return NextResponse.json({ ticker: ticker.toUpperCase(), isFavorite: fav });
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
  const ticker = body.ticker?.trim().toUpperCase();

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
  const ticker = body.ticker?.trim().toUpperCase();

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
  const ticker = searchParams.get("ticker");

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker 参数" }, { status: 400 });
  }

  try {
    await removeFavorite(ticker);
    // 同步清除该 ticker 的分析缓存，避免残留无主数据。
    // 分析缓存删除失败不影响收藏删除的主流程。
    try {
      await clearCachedAnalysis(ticker);
    } catch (cacheErr) {
      console.error("[favorites] clearCachedAnalysis failed:", cacheErr);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 }
    );
  }
}
