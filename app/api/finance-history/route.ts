import { NextRequest, NextResponse } from "next/server";
import { getFinanceHistory, getLatestFinanceSnapshot } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");
  const days = parseInt(searchParams.get("days") || "30", 10);
  const latest = searchParams.get("latest") === "true";

  if (!ticker) {
    return NextResponse.json({ error: "缺少 ticker 参数" }, { status: 400 });
  }

  const upper = ticker.toUpperCase();

  if (latest) {
    const snapshot = await getLatestFinanceSnapshot(upper);
    return NextResponse.json({ snapshot });
  }

  const history = await getFinanceHistory(upper, days);
  return NextResponse.json({ history, ticker: upper, days });
}
