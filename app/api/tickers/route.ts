import { NextRequest, NextResponse } from "next/server";
import { enrichTickersWithNames } from "@/lib/ticker-names";

const SUBREDDITS = [
  "wallstreetbets",
  "stocks",
  "cryptocurrency",
  "investing",
  "pennystocks",
  "options",
  "stockmarket",
  "shortsqueeze",
] as const;

export type Subreddit = (typeof SUBREDDITS)[number];

interface TickerRow {
  rank: number;
  ticker: string;
  countPast24h: number;
  totalCount: number | null;
  lastUpdated: string | null;
  name?: string | null;
}

interface FetchResult {
  subreddit: string;
  tickers: TickerRow[];
  lastUpdated: string | null;
  error?: string;
}

function parseCSV(text: string): { rows: TickerRow[]; lastUpdated: string | null } {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return { rows: [], lastUpdated: null };

  const rows: TickerRow[] = [];
  let lastUpdated: string | null = null;

  for (let i = 1; i < lines.length && i <= 15; i++) {
    const parts = lines[i].split(",");
    const ticker = (parts[0] || "").trim();
    const countPast24h = parseInt(parts[1] || "0", 10) || 0;
    const totalCount = parts[2] ? parseInt(parts[2], 10) || null : null;
    const updated = parts[3]?.trim() || null;

    if (i === 1 && updated) {
      lastUpdated = updated;
    }

    if (ticker) {
      rows.push({
        rank: i,
        ticker,
        countPast24h,
        totalCount,
        lastUpdated: updated,
      });
    }
  }

  return { rows, lastUpdated };
}

async function fetchSubreddit(subreddit: string): Promise<FetchResult> {
  try {
    const url = `https://yolostocks.live/downloads/${subreddit}.csv`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/csv,*/*",
      },
    });

    if (!res.ok) {
      return { subreddit, tickers: [], lastUpdated: null, error: `HTTP ${res.status}` };
    }

    const text = await res.text();
    const { rows, lastUpdated } = parseCSV(text);
    const enrichedRows = await enrichTickersWithNames(rows);
    return { subreddit, tickers: enrichedRows, lastUpdated };
  } catch (err) {
    return {
      subreddit,
      tickers: [],
      lastUpdated: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const subParam = searchParams.get("subreddit");

  if (subParam) {
    const sub = subParam.toLowerCase();
    if (!SUBREDDITS.includes(sub as Subreddit)) {
      return NextResponse.json({ error: "Invalid subreddit" }, { status: 400 });
    }
    const result = await fetchSubreddit(sub);
    return NextResponse.json(result);
  }

  // Fetch all subreddits
  const results = await Promise.all(SUBREDDITS.map((s) => fetchSubreddit(s)));
  return NextResponse.json({ subreddits: results });
}
