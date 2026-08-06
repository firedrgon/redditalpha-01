"use client";

import { useState, useEffect, useCallback } from "react";

interface RedditStock {
  rank: number;
  ticker: string;
  name: string;
  nameCn: string | null;
  mentions: number;
  mentions24hAgo: number | null;
  upvotes: number;
  rank24hAgo: number | null;
  signalOverall: string | null;
  signalOscillators: string | null;
  signalMovingAvg: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
}

interface RedditHotResponse {
  date: string;
  count: number;
  stocks: RedditStock[];
  error?: string;
}

/** 提及数格式化：1053 → 1.1k, 5005 → 5k */
function formatCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

/** 排名变化：↑3 / ↓2 / — */
function rankChange(rank: number, rank24hAgo: number | null): { text: string; cls: string } {
  if (rank24hAgo == null) return { text: "新", cls: "text-sky-400" };
  const diff = rank24hAgo - rank; // 排名上升 = 数字变小 = 正数
  if (diff > 0) return { text: `↑${diff}`, cls: "text-red-400" };
  if (diff < 0) return { text: `↓${-diff}`, cls: "text-green-400" };
  return { text: "—", cls: "text-zinc-500" };
}

/** 提及数变化百分比 */
function mentionChangePct(mentions: number, mentions24hAgo: number | null): string | null {
  if (mentions24hAgo == null || mentions24hAgo === 0) return null;
  const pct = Math.round(((mentions - mentions24hAgo) / mentions24hAgo) * 100);
  if (pct === 0) return null;
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/** 技术信号中文文案（与 TradingView 5 级一致） */
const SIGNAL_TEXT: Record<string, string> = {
  strong_buy: "强烈买入",
  buy: "买入",
  neutral: "中立",
  sell: "卖出",
  strong_sell: "强烈卖出",
};

/** 综合信号配色：买入类红、卖出类绿、中立灰（与全站约定一致） */
function signalClass(s: string | null): string {
  switch (s) {
    case "strong_buy":
      return "bg-red-500/20 text-red-300 border-red-500/40";
    case "buy":
      return "bg-red-500/10 text-red-400 border-red-500/30";
    case "sell":
      return "bg-green-500/10 text-green-400 border-green-500/30";
    case "strong_sell":
      return "bg-green-500/20 text-green-300 border-green-500/40";
    default:
      return "bg-zinc-700/40 text-zinc-400 border-zinc-700";
  }
}

/** 涨跌幅配色：涨红跌绿（与全站约定一致） */
function changeColor(pct: number | null): string {
  if (pct == null) return "text-zinc-400";
  if (pct > 0) return "text-red-400";
  if (pct < 0) return "text-green-400";
  return "text-zinc-400";
}

/** 价格格式化：美股 2 位小数 */
function formatPrice(p: number | null): string {
  if (p == null) return "-";
  return p.toFixed(2);
}

function StarIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
      />
    </svg>
  );
}

function RedditStockCard({
  stock,
  isFavorited,
  favBusy,
  onToggleFavorite,
}: {
  stock: RedditStock;
  isFavorited: boolean;
  favBusy: boolean;
  onToggleFavorite: () => void;
}) {
  const rc = rankChange(stock.rank, stock.rank24hAgo);
  const mc = mentionChangePct(stock.mentions, stock.mentions24hAgo);
  const redditUrl = `https://www.reddit.com/search?q=${encodeURIComponent(stock.ticker)}&sort=relevance&t=week`;

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
              href={redditUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-lg font-bold text-white transition-colors hover:text-orange-400"
            >
              {stock.ticker}
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
            <span className={`text-xs font-medium ${rc.cls}`}>{rc.text}</span>
          </div>

          <div className="mt-0.5 truncate text-sm text-zinc-300" title={stock.nameCn ?? stock.name}>
            {stock.nameCn ?? stock.name}
          </div>
          {stock.nameCn && (
            <div className="truncate text-[11px] text-zinc-500" title={stock.name}>
              {stock.name}
            </div>
          )}

          {/* 提及数变化 + 技术信号 */}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {mc && (
              <span
                className={`text-[10px] font-medium ${
                  mc.startsWith("+") ? "text-red-400" : "text-green-400"
                }`}
              >
                {mc} 提及
              </span>
            )}
            {stock.signalOverall && (
              <span
                className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${signalClass(stock.signalOverall)}`}
                title={`综合:${SIGNAL_TEXT[stock.signalOverall] ?? stock.signalOverall} · 振荡:${SIGNAL_TEXT[stock.signalOscillators ?? ""] ?? stock.signalOscillators ?? "-"} · 均线:${SIGNAL_TEXT[stock.signalMovingAvg ?? ""] ?? stock.signalMovingAvg ?? "-"}`}
              >
                {SIGNAL_TEXT[stock.signalOverall] ?? stock.signalOverall}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* 收藏 */}
          <button
            type="button"
            onClick={onToggleFavorite}
            disabled={favBusy}
            title={isFavorited ? "取消收藏" : "加入收藏"}
            aria-label={isFavorited ? "取消收藏" : "加入收藏"}
            className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-all ${
              isFavorited
                ? "border-yellow-500/40 bg-yellow-500/15 text-yellow-400"
                : "border-zinc-700 text-zinc-500 hover:border-yellow-500/30 hover:text-yellow-400"
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <StarIcon filled={isFavorited} className="h-4 w-4" />
          </button>

          <div className="text-right">
            <div className={`text-base font-bold ${changeColor(stock.changePercent)}`}>
              {stock.changePercent == null
                ? "-"
                : `${stock.changePercent > 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%`}
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-500">
              ${formatPrice(stock.price)}
            </div>
            <div className="mt-1 text-[11px] font-medium text-orange-400">
              {formatCount(stock.mentions)}
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-500">
              ↑{formatCount(stock.upvotes)}
            </div>
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

interface RedditHotPanelProps {
  isFavorite?: (ticker: string) => boolean;
  toggleFavorite?: (ticker: string, name?: string | null) => void;
}

/**
 * Reddit 热榜面板（ApeWisdom 数据源，all-stocks Top 100）。
 * 自包含：自行 fetch /api/reddit-hot。
 * 首页使用时传入 isFavorite / toggleFavorite，收藏状态与首页同步。
 */
export default function RedditHotPanel({
  isFavorite,
  toggleFavorite,
}: RedditHotPanelProps) {
  const [stocks, setStocks] = useState<RedditStock[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 自包含模式下的本地收藏集合
  const [localFav, setLocalFav] = useState<Set<string>>(new Set());
  const [favBusy, setFavBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/reddit-hot?limit=100", { cache: "no-store" });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json: RedditHotResponse = await res.json();
      setStocks(json.stocks);
      setDate(json.date);
    } catch (err) {
      console.error("[reddit-hot] 获取失败:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 自包含模式：拉取已收藏集合
  useEffect(() => {
    if (toggleFavorite) return;
    let cancelled = false;
    fetch("/api/favorites", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json?.favorites) return;
        const set = new Set<string>(
          (json.favorites as { ticker: string }[]).map((f) =>
            f.ticker.toUpperCase()
          )
        );
        setLocalFav(set);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [toggleFavorite]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch("/api/reddit-hot", { method: "POST" });
      await load();
    } catch (err) {
      console.error("[reddit-hot] 刷新失败:", err);
    } finally {
      setRefreshing(false);
    }
  };

  const favStateOf = useCallback(
    (stock: RedditStock): boolean => {
      const tk = stock.ticker.toUpperCase();
      return isFavorite ? isFavorite(tk) : localFav.has(tk);
    },
    [isFavorite, localFav]
  );

  const handleToggleFavorite = useCallback(
    async (stock: RedditStock) => {
      const tk = stock.ticker;
      const upper = tk.toUpperCase();
      const displayName = stock.nameCn ?? stock.name;
      if (toggleFavorite) {
        toggleFavorite(tk, displayName);
        return;
      }
      const willAdd = !localFav.has(upper);
      setLocalFav((prev) => {
        const next = new Set(prev);
        if (willAdd) next.add(upper);
        else next.delete(upper);
        return next;
      });
      setFavBusy((prev) => new Set(prev).add(upper));
      try {
        if (willAdd) {
          await fetch("/api/favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticker: tk, name: displayName }),
          });
        } else {
          await fetch(`/api/favorites?ticker=${encodeURIComponent(tk)}`, {
            method: "DELETE",
          });
        }
      } catch (err) {
        console.error("[reddit-hot] 收藏操作失败:", err);
        setLocalFav((prev) => {
          const next = new Set(prev);
          if (willAdd) next.delete(upper);
          else next.add(upper);
          return next;
        });
      } finally {
        setFavBusy((prev) => {
          const next = new Set(prev);
          next.delete(upper);
          return next;
        });
      }
    },
    [toggleFavorite, localFav]
  );

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/15 text-orange-400">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                <path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.498.388-.38.922-.619 1.513-.619a2.15 2.15 0 012.146 2.147 2.15 2.15 0 01-1.313 1.978c.04.249.062.504.062.765 0 2.936-3.426 5.32-7.653 5.32s-7.653-2.384-7.653-5.32c0-.262.022-.516.062-.765A2.15 2.15 0 014.21 12.4a2.15 2.15 0 012.147-2.147c.591 0 1.125.239 1.513.619 1.205-.876 2.879-1.438 4.724-1.498l.897-4.205a.5.5 0 01.567-.388l2.913.614c.388-.5.986-.825 1.659-.825zM9.425 14.515a1.25 1.25 0 102.5 0 1.25 1.25 0 00-2.5 0zm5.15 0a1.25 1.25 0 102.5 0 1.25 1.25 0 00-2.5 0zm-2.563 2.94a.5.5 0 00-.375.169.5.5 0 00.04.706c.42.388 1.078.619 1.823.619.745 0 1.403-.231 1.823-.619a.5.5 0 00.04-.706.5.5 0 00-.706-.04c-.249.224-.675.365-1.157.365s-.908-.141-1.157-.365a.5.5 0 00-.331-.169z" />
              </svg>
            </span>
            Reddit热榜
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            Reddit 社区提及热度 Top 100 · 按 mentions 排序
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
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0z" />
            </svg>
          </div>
          <div className="text-zinc-400">暂无 Reddit 热榜数据</div>
          <p className="mt-2 text-xs text-zinc-600">
            点击右上角「刷新」立即从 ApeWisdom 抓取一次。
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stocks.map((stock) => (
            <RedditStockCard
              key={stock.ticker}
              stock={stock}
              isFavorited={favStateOf(stock)}
              favBusy={favBusy.has(stock.ticker.toUpperCase())}
              onToggleFavorite={() => handleToggleFavorite(stock)}
            />
          ))}
        </div>
      )}

      <p className="mt-6 text-center text-[11px] text-zinc-600">
        数据来源：ApeWisdom（apewisdom.io）· Reddit all-stocks Top 100 · 仅供参考，不构成投资建议
      </p>
    </>
  );
}
