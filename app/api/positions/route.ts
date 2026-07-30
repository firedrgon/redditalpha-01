import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-guards";
import { getPrisma } from "@/lib/db/prisma";
import { fetchQuotes } from "@/lib/quote";

export const dynamic = "force-dynamic";

const EMPTY_SUMMARY = {
  invested: 0,
  currentValue: 0,
  unrealized: 0,
  realized: 0,
  winRate: 0,
  openCount: 0,
  closedCount: 0,
};

export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ open: [], closed: [], summary: EMPTY_SUMMARY });
  }

  const [open, closed] = await Promise.all([
    prisma.position.findMany({
      where: { userId: user.id, status: "OPEN" },
      orderBy: { entryAt: "desc" },
    }),
    prisma.position.findMany({
      where: { userId: user.id, status: "CLOSED" },
      orderBy: { exitAt: "desc" },
      take: 100,
    }),
  ]);

  // 当前价（批量），用于算未实现盈亏
  const quotes =
    open.length > 0
      ? await fetchQuotes(open.map((o) => o.ticker))
      : ({} as Record<string, { price: number | null }>);

  let invested = 0;
  let currentValue = 0;
  let unrealized = 0;

  const openView = open.map((o) => {
    const q = quotes[o.ticker.toUpperCase()];
    const price = q?.price ?? null;
    const pnl = price != null ? (price - o.entryPrice) * o.shares : null;
    const pnlPct =
      price != null && o.entryPrice > 0
        ? (price / o.entryPrice - 1) * 100
        : null;
    if (price != null) {
      currentValue += price * o.shares;
      unrealized += pnl ?? 0;
    }
    invested += o.capital;
    return {
      ...o,
      currentPrice: price,
      unrealizedPnl: pnl,
      unrealizedPnlPct: pnlPct,
    };
  });

  const realized = closed.reduce((s, c) => s + (c.pnl ?? 0), 0);
  const wins = closed.filter((c) => (c.pnl ?? 0) > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

  return NextResponse.json({
    open: openView,
    closed,
    summary: {
      invested,
      currentValue,
      unrealized,
      realized,
      winRate,
      openCount: open.length,
      closedCount: closed.length,
    },
  });
}
