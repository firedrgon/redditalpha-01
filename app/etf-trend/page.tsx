"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";

interface EtfTrendItem {
  code: string;
  name: string;
  prefixedCode: string;
  board: "SH" | "SZ" | null;
  t0: boolean;
  tag: string;
  category: "pullback" | "newPool";
}

interface EtfTrendResult {
  pullback: EtfTrendItem[];
  newPool: EtfTrendItem[];
  total: number;
  /** 数据日期 YYYY-MM-DD */
  date: string;
  fetchedAt: string;
  error?: string;
}

type TabKey = "pullback" | "newPool";

const TABS: { key: TabKey; label: string; desc: string }[] = [
  { key: "pullback", label: "趋势回踩", desc: "回踩主升趋势线的 ETF" },
  { key: "newPool", label: "新入池", desc: "新进入主升浪池的 ETF" },
];

function eastmoneyEtfUrl(board: string | null, code: string): string {
  const prefix = board === "SH" ? "sh" : board === "SZ" ? "sz" : "sh";
  return `https://quote.eastmoney.com/${prefix}${code}.html`;
}

function EtfCard({ item }: { item: EtfTrendItem }) {
  return (
    <div className="group/card relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-all hover:border-zinc-700 hover:bg-zinc-900/80">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={eastmoneyEtfUrl(item.board, item.code)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-base font-bold text-white transition-colors hover:text-orange-400"
            >
              {item.name}
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
            <span className="font-mono text-xs text-zinc-500">{item.code}</span>
            {item.board && (
              <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {item.board}
              </span>
            )}
            {item.t0 && (
              <span className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-400">
                T+0
              </span>
            )}
            <span className="inline-flex items-center rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">
              {item.tag}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-16 rounded-xl border border-zinc-800 bg-zinc-900/40 animate-pulse"
        />
      ))}
    </div>
  );
}

export default function EtfTrendPage() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("pullback");
  const [data, setData] = useState<EtfTrendResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/etf-trend", { cache: "no-store" });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json: EtfTrendResult = await res.json();
      setData(json);
    } catch (err) {
      console.error("[etf-trend] 获取失败:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 读取 URL ?tab（client-only，避免 useSearchParams 的 Suspense 要求）
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("tab");
    setTab(t === "newPool" ? "newPool" : "pullback");
  }, []);

  const switchTab = (next: TabKey) => {
    setTab(next);
    router.replace(`/etf-trend?tab=${next}`, { scroll: false });
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      // POST：抓取并落库（与盘前 cron 行为一致）
      const postRes = await fetch("/api/etf-trend", { method: "POST" });
      if (!postRes.ok) {
        const errText = await postRes.text().catch(() => "");
        throw new Error(`刷新失败 HTTP ${postRes.status}: ${errText.slice(0, 200)}`);
      }
      // 刷新后重新读取已去重数据
      await load();
    } catch (err) {
      console.error("[etf-trend] 刷新失败:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const list = tab === "pullback" ? data?.pullback ?? [] : data?.newPool ?? [];
  const fetchedTime = data?.fetchedAt
    ? new Date(data.fetchedAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      <SiteHeader />
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
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
                    d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"
                  />
                </svg>
              </span>
              ETF 主升浪
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              同花顺 ETF 主升浪池 · 按趋势信号分类 · 同类仅展示一只
              {data?.date && (
                <span className="ml-1 text-zinc-500">（{data.date}）</span>
              )}
              {fetchedTime && (
                <span className="ml-1 text-zinc-500">更新于 {fetchedTime}</span>
              )}
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

        {/* 标签切换 */}
        <div className="mb-5 flex gap-2">
          {TABS.map((t) => {
            const count =
              t.key === "pullback"
                ? data?.pullback.length ?? 0
                : data?.newPool.length ?? 0;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => switchTab(t.key)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                  active
                    ? "border-orange-500/50 bg-orange-500/10 text-orange-400"
                    : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100"
                }`}
              >
                {t.label}
                {!loading && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      active
                        ? "bg-orange-500/20 text-orange-300"
                        : "bg-zinc-800 text-zinc-500"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <p className="mb-4 text-xs text-zinc-500">
          {TABS.find((t) => t.key === tab)?.desc}
        </p>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {loading ? (
          <LoadingSkeleton />
        ) : list.length === 0 ? (
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
                  d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"
                />
              </svg>
            </div>
            <div className="text-zinc-400">暂无{TABS.find((t) => t.key === tab)?.label}数据</div>
            <p className="mt-2 text-xs text-zinc-600">
              主升浪池共 {data?.total ?? 0} 只 ETF，当前分类无匹配信号。
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((item) => (
              <EtfCard key={`${item.category}-${item.code}`} item={item} />
            ))}
          </div>
        )}

        <p className="mt-6 text-center text-[11px] text-zinc-600">
          数据来源：同花顺（10jqka）ETF 主升浪池 · 仅供参考，不构成投资建议
        </p>
      </div>
    </>
  );
}
