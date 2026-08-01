"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const LAST_SEEN_KEY = "redditalpha:signalLastSeen";

interface MiniSignal {
  id: string;
  ticker: string;
  tickerName: string | null;
  title: string;
  createdAt: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function GlobalSignalBell() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<MiniSignal[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  const markSeen = useCallback(() => {
    localStorage.setItem(LAST_SEEN_KEY, Date.now().toString());
    setCount(0);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/signals?limit=30", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const signals: MiniSignal[] = (data.signals ?? []).slice(0, 6);
      setRecent(signals);
      const lastSeen = Number(localStorage.getItem(LAST_SEEN_KEY) || 0);
      const unread = (data.signals ?? []).filter(
        (s: MiniSignal) => new Date(s.createdAt).getTime() > lastSeen
      ).length;
      setCount(unread);
    } catch {
      /* 忽略瞬时错误 */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const goSignals = () => {
    markSeen();
    setOpen(false);
    router.push("/signals");
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="信号提醒"
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors hover:border-orange-500/40 hover:text-orange-400"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>
        {count > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-semibold text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-zinc-800 bg-zinc-900 p-2 shadow-2xl">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-sm font-medium text-zinc-200">最新信号</span>
            <button
              type="button"
              onClick={goSignals}
              className="text-xs font-medium text-orange-400 hover:underline"
            >
              查看全部
            </button>
          </div>
          <div className="max-h-72 overflow-auto">
            {recent.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-zinc-500">暂无信号提醒</p>
            ) : (
              recent.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={goSignals}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-zinc-800"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">
                      {s.ticker}
                      {s.tickerName ? ` · ${s.tickerName}` : ""}
                    </span>
                    <span className="shrink-0 text-[10px] text-zinc-500">
                      {timeAgo(s.createdAt)}
                    </span>
                  </div>
                  <span className="truncate text-xs text-zinc-400">{s.title}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
