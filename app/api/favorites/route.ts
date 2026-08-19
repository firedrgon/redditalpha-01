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
  clearFinanceSnapshot,
} from "@/lib/db";
import { getCurrentUser, ANON_USER_ID } from "@/lib/auth";
import { detectMarket, normalizeCNTicker } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** 规范化收藏 ticker。
 * - ETF 代码：6 位纯数字、按 5xxxxx / 1[5-9]xxxx 识别（上交所/深交所 ETF 专用段，
 *   与 A 股股票代码段 60/68/00/30/8/4 不冲突），不补 .SH/.SZ 后缀，保持裸代码，
 *   这样收藏存取的 ticker 与 ETF 卡片 / /etf-evaluate?code= 用的裸代码一致。
 * - 其余：A 股补全 .SH/.SZ 后缀，美股统一大写（原有行为不变）。
 */
function normalizeFavoriteTicker(raw: string): string {
  const t = raw.trim();
  if (/^\d{6}$/.test(t) && /^(5\d{5}|1[5-9]\d{4})$/.test(t)) {
    return t.toUpperCase();
  }
  if (detectMarket(t) === "CN") {
    return normalizeCNTicker(t) ?? t.toUpperCase();
  }
  return t.toUpperCase();
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const uid = user?.id ?? ANON_USER_ID;

  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");

  if (ticker) {
    const normalized = normalizeFavoriteTicker(ticker);
    const fav = await isFavorite(normalized, uid);
    return NextResponse.json({ ticker: normalized, isFavorite: fav });
  }

  const favorites = await listFavorites(uid);
  return NextResponse.json({ favorites });
}

interface AddBody {
  ticker: string;
  name?: string;
  note?: string;
  tags?: string[];
  assetType?: string; // "ETF" | "STOCK" | 省略
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const uid = user?.id ?? ANON_USER_ID;

  const body = (await request.json().catch(() => ({}))) as AddBody;
  const ticker = normalizeFavoriteTicker(body.ticker ?? "");

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  const fav = await addFavorite(
    ticker,
    { name: body.name, note: body.note, tags: body.tags, assetType: body.assetType },
    uid
  );

  return NextResponse.json({ favorite: fav });
}

interface PatchBody {
  ticker: string;
  name?: string;
  note?: string;
  tags?: string[];
  assetType?: string;
  pinned?: boolean; // 置顶 / 取消置顶
  starred?: boolean; // 关注 / 取消关注
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  const uid = user?.id ?? ANON_USER_ID;

  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const ticker = normalizeFavoriteTicker(body.ticker ?? "");

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker" }, { status: 400 });
  }

  // 置顶 / 取消置顶走独立逻辑（不影响 name/note/tags/assetType）
  if (typeof body.pinned === "boolean") {
    try {
      const fav = await setPinned(ticker, body.pinned, uid);
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
      const fav = await setStarred(ticker, body.starred, uid);
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
      assetType: body.assetType,
    }, uid);
    return NextResponse.json({ favorite: fav });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  const uid = user?.id ?? ANON_USER_ID;

  const { searchParams } = new URL(request.url);
  const rawTicker = searchParams.get("ticker");

  if (!rawTicker) {
    return NextResponse.json({ error: "缺少 ticker 参数" }, { status: 400 });
  }

  const normalized = normalizeFavoriteTicker(rawTicker);
  const rawUpper = rawTicker.trim().toUpperCase();

  // 同时尝试规范化和原始形式，处理历史未规范化的 DB 数据
  // （例如旧数据存的是 "600267" 而非 "600267.SH"）
  const candidates = [...new Set([normalized, rawUpper])];

  try {
    let totalDeleted = 0;
    for (const t of candidates) {
      totalDeleted += await removeFavorite(t, uid);
    }

    // 同步清除该 ticker 的分析记录和财务快照
    for (const t of candidates) {
      try {
        await clearAnalysis(t);
      } catch (cacheErr) {
        console.error("[favorites] clearAnalysis failed:", cacheErr);
      }
      try {
        await clearFinanceSnapshot(t);
      } catch (snapshotErr) {
        console.error("[favorites] clearFinanceSnapshot failed:", snapshotErr);
      }
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
