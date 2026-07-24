"use client";

import { useState, useEffect, useCallback } from "react";

interface HotStock {
  id: string;
  date: string;
  rank: number;
  code: string;
  name: string;
  heat: number | null;
  changePct: number | null;
  board: string | null;
  conceptTags: string | null;
  popularityTag: string | null;
}

interface HotStocksResponse {
  date: string;
  count: number;
  stocks: HotStock[];
  error?: string;
}

/** 热度值格式化：354998 → 35.5万 */
function formatHeat(n: number | null): string {
  if (n == null) return "-";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(Math.round(n));
}

/** 涨跌幅配色：涨红跌绿（A股惯例） */
function changeColor(pct: number | null): string {
  if (pct == null) return "text-zinc-400";
  if (pct > 0) return "text-red-400";
  if (pct < 0) return "text-green-400";
  return "text-zinc-400";
}

function tradingViewUrl(board: string | null, code: string): string {
  const prefix = board === "SH" ? "SSE" : board === "SZ" ? "SZSE" : "SSE";
  return `https://cn.tradingview.com/symbols/${prefix}-${code}/`;
}

function HotStockCard({ stock }: { stock: HotStock }) {
  const tags = stock.conceptTags
    ? stock.conceptTags.split(",").filter(Boolean)
    : [];

  return (
    <div className="group/card relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-all hover:border-zinc-700 hover:bg-zinc-900/80">
      <div className="flex items-center gap-3">
        {/* 排名 */}
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-bold ${
            stock.rank <= 3
              ? "bg-orange-500/15 text-orange-400"
              : "bg-zinc-800/60 text-zinc-400"
          }`}
        >
          {stock.rank}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={tradingViewUrl(stock.board, stock.code)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-lg font-bold text-white transition-colors hover:text-orange-400"
            >
              {stock.name}
              <svg
                viewBox="0 0 24 24"
                className="h-3 w-3 text-zinc-600 transition-colors group-hover/card:text-orange-400/70"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.5 6H5v13h13v-8.5M15 3h6v6M21 3l-9 9"
                />
              </svg>
            </a>
            <span className="font-mono text-xs text-zinc-500">{stock.code}</span>
            {stock.popularityTag && (
              <span className="inline-flex items-center rounded border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[10px] font-medium text-orange-400">
                {stock.popularityTag}
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400"
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className={`text-base font-bold ${changeColor(stock.changePct)}`}>
            {stock.changePct == null
              ? "-"
              : `${stock.changePct > 0 ? "+" : ""}${stock.changePct.toFixed(2)}%`}
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            热度 {formatHeat(stock.heat)}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          className="h-[72px] rounded-xl border border-zinc-800 bg-zinc-900/40 animate-pulse"
        />
      ))}
    </div>
  );
}

/**
 * 首页内嵌的 A 股热榜面板（自包含：自行 fetch /api/hot-stocks）。
 * 由首页 nav 的「热榜」标签切换显示。
 */
export default function HotStocksPanel() {
  const [stocks, setStocks] = useState<HotStock[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hot-stocks?limit=50", { cache: "no-store" });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json: HotStocksResponse = await res.json();
      setStocks(json.stocks);
      setDate(json.date);
    } catch (err) {
      console.error("[hot] 获取热榜失败:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch("/api/hot-stocks", { method: "POST" });
      await load();
    } catch (err) {
      console.error("[hot] 刷新失败:", err);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/15 text-orange-400">
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.362 5.214A8.25 8.25 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z"
                />
              </svg>
            </span>
            A股热榜
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            同花顺人气榜 · 按访问/关注/社区热度排行
            {date && <span className="ml-1 text-zinc-500">（{date}）</span>}
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-400 transition-all hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? (
            <>
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 animate-spin"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v4m0 0a8 8 0 100 8 8 8 0 000-8z" />
              </svg>
              刷新中…
            </>
          ) : (
            <>
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              刷新
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : stocks.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-10 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-500">
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.362 5.214A8.25 8.25 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z"
              />
            </svg>
          </div>
          <div className="text-zinc-400">暂无热榜数据</div>
          <p className="mt-2 text-xs text-zinc-600">
            点击右上角「刷新」立即从同花顺抓取一次。
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stocks.map((stock) => (
            <HotStockCard key={stock.id} stock={stock} />
          ))}
        </div>
      )}

      <p className="mt-6 text-center text-[11px] text-zinc-600">
        数据来源：同花顺（10jqka）人气榜 · 仅供参考，不构成投资建议
      </p>
    </>
  );
}
