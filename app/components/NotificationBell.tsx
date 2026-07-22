"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface NotificationItem {
  id: string;
  type: string;
  ticker: string;
  tickerName: string | null;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
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

export default function NotificationBell() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const authed = status === "authenticated" && !!session?.user;

  const load = useCallback(async () => {
    if (!authed) return;
    try {
      const res = await fetch("/api/notifications?limit=12");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.notifications ?? []);
      setUnread(data.unreadCount ?? 0);
    } catch {
      /* 忽略瞬时错误 */
    }
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    load();
    const t = setInterval(load, 60_000); // 轮询未读
    return () => clearInterval(t);
  }, [authed, load]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const markRead = useCallback(
    async (id: string) => {
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      setUnread((u) => Math.max(0, u - 1));
      try {
        const res = await fetch("/api/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (res.ok) {
          const d = await res.json();
          if (typeof d.unreadCount === "number") setUnread(d.unreadCount);
        }
      } catch {
        /* ignore */
      }
    },
    []
  );

  const markAll = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read-all" }),
      });
    } catch {
      /* ignore */
    }
  }, []);

  const onItemClick = (n: NotificationItem) => {
    if (!n.read) void markRead(n.id);
    setOpen(false);
    router.push(n.link || "/notifications");
  };

  if (!authed) return null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void load();
        }}
        className="relative flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-orange-500/40 hover:text-orange-400"
        title="通知中心"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        <span className="hidden sm:inline">通知</span>
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
            <span className="text-sm font-semibold text-zinc-200">通知</span>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button onClick={markAll} className="text-[11px] text-orange-400 hover:underline">
                  全部已读
                </button>
              )}
              <a href="/notifications" onClick={() => setOpen(false)} className="text-[11px] text-zinc-400 hover:underline">
                查看全部
              </a>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">加载中…</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-zinc-600">
                暂无通知。产生建仓/平仓信号时会在此提醒。
              </div>
            ) : (
              items.map((n) => {
                const isBuy = n.type === "signal_buy";
                const accent = isBuy ? "border-l-red-500" : "border-l-green-500";
                return (
                  <button
                    key={n.id}
                    onClick={() => onItemClick(n)}
                    className={`block w-full border-b border-l-2 border-zinc-800 px-3 py-2 text-left transition-colors hover:bg-zinc-900 ${accent} ${
                      n.read ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-100">{n.title}</span>
                      <span className="text-[10px] text-zinc-500">{timeAgo(n.createdAt)}</span>
                    </div>
                    {n.body && <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-400">{n.body}</p>}
                    {!n.read && <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-orange-400" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
