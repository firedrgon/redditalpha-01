"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession, signIn } from "next-auth/react";

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

/** 由热榜股票推导收藏系统用的 ticker（600519.SH） */
function tickerOf(stock: HotStock): string {
  const board = stock.board ? stock.board.toUpperCase() : "";
  return board ? `${stock.code}.${board}` : stock.code;
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

function HotStockCard({
  stock,
  isFavorited,
  favBusy,
  onToggleFavorite,
}: {
  stock: HotStock;
  isFavorited: boolean;
  favBusy: boolean;
  onToggleFavorite: () => void;
}) {
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

interface HotStocksPanelProps {
  /** 布局：grid（首页多列）| list（/hot 单列）。默认 grid */
  variant?: "grid" | "list";
  /** 复用宿主页已有的收藏系统（首页）；不传则组件自带 next-auth 自包含收藏 */
  isFavorite?: (ticker: string) => boolean;
  toggleFavorite?: (ticker: string, name?: string | null) => void;
}

/**
 * A 股热榜面板（自包含：自行 fetch /api/hot-stocks）。
 * - 首页使用时传入 isFavorite / toggleFavorite，收藏状态与首页「收藏」标签实时同步。
 * - /hot 等独立页不传时，组件用 next-auth 自行判定登录并调用 /api/favorites。
 */
export default function HotStocksPanel({
  variant = "grid",
  isFavorite,
  toggleFavorite,
}: HotStocksPanelProps) {
  const { status } = useSession();
  const [stocks, setStocks] = useState<HotStock[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 自包含模式（未传入宿主收藏回调）下的本地收藏集合
  const [localFav, setLocalFav] = useState<Set<string>>(new Set());
  const [favBusy, setFavBusy] = useState<Set<string>>(new Set());

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

  // 自包含模式：登录后拉取已收藏集合
  useEffect(() => {
    if (toggleFavorite || status !== "authenticated") return;
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
  }, [toggleFavorite, status]);

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

  const favStateOf = useCallback(
    (stock: HotStock): boolean => {
      const tk = tickerOf(stock).toUpperCase();
      return isFavorite ? isFavorite(tk) : localFav.has(tk);
    },
    [isFavorite, localFav]
  );

  const handleToggleFavorite = useCallback(
    async (stock: HotStock) => {
      const tk = tickerOf(stock);
      const upper = tk.toUpperCase();
      // 宿主模式：直接委托首页收藏系统（含登录校验 / 乐观更新 / 计数同步）
      if (toggleFavorite) {
        toggleFavorite(tk, stock.name);
        return;
      }
      // 自包含模式
      if (status !== "authenticated") {
        signIn();
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
            body: JSON.stringify({ ticker: tk, name: stock.name }),
          });
        } else {
          await fetch(`/api/favorites?ticker=${encodeURIComponent(tk)}`, {
            method: "DELETE",
          });
        }
      } catch (err) {
        console.error("[hot] 收藏操作失败:", err);
        // 回滚
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
    [toggleFavorite, status, localFav]
  );

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
        <div
          className={
            variant === "list"
              ? "grid gap-3"
              : "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          }
        >
          {stocks.map((stock) => (
            <HotStockCard
              key={stock.id}
              stock={stock}
              isFavorited={favStateOf(stock)}
              favBusy={favBusy.has(tickerOf(stock).toUpperCase())}
              onToggleFavorite={() => handleToggleFavorite(stock)}
            />
          ))}
        </div>
      )}

      <p className="mt-6 text-center text-[11px] text-zinc-600">
        数据来源：同花顺（10jqka）人气榜 · 仅供参考，不构成投资建议
      </p>
    </>
  );
}
