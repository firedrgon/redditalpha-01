"use client";

import { useState, useEffect, useCallback } from "react";

const SUBREDDITS = [
  { id: "wallstreetbets", label: "WSB", full: "r/WallStreetBets" },
  { id: "stocks", label: "Stocks", full: "r/stocks" },
  { id: "cryptocurrency", label: "Crypto", full: "r/CryptoCurrency" },
  { id: "investing", label: "Investing", full: "r/investing" },
  { id: "pennystocks", label: "Penny", full: "r/pennystocks" },
  { id: "options", label: "Options", full: "r/options" },
  { id: "stockmarket", label: "Market", full: "r/StockMarket" },
  { id: "shortsqueeze", label: "Squeeze", full: "r/Shortsqueeze" },
];

interface Ticker {
  rank: number;
  ticker: string;
  countPast24h: number;
  totalCount: number | null;
  lastUpdated: string | null;
  name?: string | null;
}

interface SubredditData {
  subreddit: string;
  tickers: Ticker[];
  lastUpdated: string | null;
  error?: string;
}

function RankBadge({ rank }: { rank: number }) {
  const colors =
    rank === 1
      ? "bg-yellow-400 text-yellow-900"
      : rank === 2
        ? "bg-gray-300 text-gray-800"
        : rank === 3
          ? "bg-amber-600 text-white"
          : "bg-zinc-700 text-zinc-300";
  return (
    <span
      className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${colors}`}
    >
      {rank}
    </span>
  );
}

function TickerCard({ ticker, maxCount, subreddit }: { ticker: Ticker; maxCount: number; subreddit: string }) {
  const pct = maxCount > 0 ? (ticker.countPast24h / maxCount) * 100 : 0;
  const redditUrl = `https://www.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(ticker.ticker)}&sort=relevance&t=week`;
  return (
    <a
      href={redditUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left transition-all hover:border-orange-500/50 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-orange-500/40"
    >
      <RankBadge rank={ticker.rank} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-white tracking-wide">
              {ticker.ticker}
            </span>
            {ticker.name && (
              <span className="text-xs text-zinc-400">
                {ticker.name}
              </span>
            )}
          </div>
          <span className="text-sm font-mono text-orange-400 font-semibold">
            {ticker.countPast24h.toLocaleString()}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-orange-500 to-yellow-400 transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
          <span>提及次数 (24h)</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100 text-orange-400/70">
            在 Reddit 查看 →
          </span>
        </div>
      </div>
    </a>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 15 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 animate-pulse"
        >
          <div className="w-7 h-7 rounded-full bg-zinc-700" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 rounded bg-zinc-700" />
            <div className="h-1.5 w-full rounded bg-zinc-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [activeSub, setActiveSub] = useState("wallstreetbets");
  const [data, setData] = useState<Record<string, SubredditData>>({});
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(60);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(
    async (subreddit: string) => {
      try {
        const res = await fetch(`/api/tickers?subreddit=${subreddit}`);
        const json: SubredditData = await res.json();
        setData((prev) => ({ ...prev, [subreddit]: json }));
        setLastRefresh(new Date());
        setCountdown(60);
      } catch (err) {
        console.error("Failed to fetch:", err);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch("/api/tickers");
      const json = await res.json();
      if (json.subreddits) {
        const newData: Record<string, SubredditData> = {};
        for (const sub of json.subreddits) {
          newData[sub.subreddit] = sub;
        }
        setData(newData);
        setLastRefresh(new Date());
        setCountdown(60);
      }
    } catch (err) {
      console.error("Failed to fetch all:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchAll();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const currentData = data[activeSub];
  const tickers = currentData?.tickers || [];
  const maxCount = tickers.length > 0 ? tickers[0].countPast24h : 1;
  const subLabel = SUBREDDITS.find((s) => s.id === activeSub)?.full || activeSub;

  const buildShareText = () => {
    if (tickers.length === 0) return `Reddit Alpha · ${subLabel}`;
    const lines = tickers.map((t) => `${t.rank}. $${t.ticker} ${t.countPast24h.toLocaleString()}`);
    const now = new Date();
    const timeStr = now.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return [
      `以下是${subLabel}中过去24小时被提及最多的股票/加密货币排名`,
      ...lines,
      "",
      `数据时间: ${timeStr}`
    ].join("\n");
  };

  const handleShare = () => {
    const text = buildShareText();
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <header className="sticky top-0 z-50 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-red-600">
                <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">Reddit Alpha</h1>
                <p className="text-xs text-zinc-500">Real-time Reddit Stock Tracker</p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <button
                onClick={handleShare}
                disabled={tickers.length === 0}
                className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-black/40 hover:bg-black hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                title="分享到 X"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                分享到 X
              </button>
              <div className="hidden sm:flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    loading ? "bg-yellow-400 animate-pulse" : "bg-green-400"
                  }`}
                />
                <span className="text-zinc-400">
                  {loading ? "加载中..." : `${countdown}s 后刷新`}
                </span>
              </div>
              {lastRefresh && (
                <span className="hidden md:inline text-zinc-600 text-xs">
                  上次更新: {lastRefresh.toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      <nav className="border-b border-zinc-800 bg-zinc-950">
        <div className="mx-auto max-w-6xl px-4">
          <div className="flex gap-1 overflow-x-auto py-3 scrollbar-hide">
            {SUBREDDITS.map((sub) => (
              <button
                key={sub.id}
                onClick={() => {
                  setActiveSub(sub.id);
                  if (!data[sub.id]) {
                    setLoading(true);
                    fetchData(sub.id);
                  }
                }}
                className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                  activeSub === sub.id
                    ? "bg-orange-500/20 text-orange-400 border border-orange-500/40"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 border border-transparent"
                }`}
              >
                {sub.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">
              {SUBREDDITS.find((s) => s.id === activeSub)?.full}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              Top 15 Tickers · 过去24小时提及次数
            </p>
          </div>
          {currentData?.lastUpdated && (
            <div className="text-right">
              <div className="text-xs text-zinc-500">数据更新于</div>
              <div className="text-sm text-zinc-400 font-mono">
                {currentData.lastUpdated}
              </div>
            </div>
          )}
        </div>

        {currentData?.error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            数据加载错误: {currentData.error}
          </div>
        )}

        {loading && tickers.length === 0 ? (
          <LoadingSkeleton />
        ) : tickers.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tickers.map((ticker) => (
              <TickerCard
                key={ticker.ticker}
                ticker={ticker}
                maxCount={maxCount}
                subreddit={activeSub}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
            <svg className="h-16 w-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>暂无数据</p>
          </div>
        )}

        <div className="mt-8 border-t border-zinc-800 pt-6 text-center text-xs text-zinc-600">
          数据来源:{" "}
          <a
            href="https://yolostocks.live/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-orange-500/70 hover:text-orange-400 transition-colors"
          >
            yolostocks.live
          </a>
          {" "}· 每60秒自动刷新
        </div>
      </main>
    </div>
  );
}
