"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

interface MiniNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  ticker: string | null;
  read: boolean;
  createdAt: number;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

export default function UserBell() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MiniNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.notifications ?? []);
      setUnread(data.unreadCount ?? 0);
    } catch {
      /* 忽略网络错误 */
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [status, load]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function markAll() {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      /* ignore */
    }
    setUnread(0);
    setItems((it) => it.map((i) => ({ ...i, read: true })));
  }

  async function openItem(n: MiniNotification) {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      });
    } catch {
      /* ignore */
    }
    setUnread((u) => Math.max(0, u - 1));
    setItems((it) => it.map((i) => (i.id === n.id ? { ...i, read: true } : i)));
    setOpen(false);
    if (n.url) router.push(n.url);
  }

  // 仅在已登录时渲染（未登录由 AuthMenu 回退到全局铃铛）
  if (status !== "authenticated") return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-zinc-300 transition hover:bg-zinc-800 hover:text-white"
        aria-label="通知"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
            <span className="text-sm font-semibold text-zinc-100">我的通知</span>
            {unread > 0 && (
              <button
                onClick={markAll}
                className="text-xs text-orange-400 hover:text-orange-300"
              >
                全部标记为已读
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">
                暂无通知
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openItem(n)}
                  className={`flex w-full flex-col gap-1 border-b border-zinc-800/60 px-4 py-3 text-left transition hover:bg-zinc-800/60 ${
                    n.read ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {!n.read && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500" />
                    )}
                    <span className="text-sm font-medium text-zinc-100">
                      {n.title}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
                      {timeAgo(n.createdAt)}
                    </span>
                  </div>
                  {n.body && (
                    <span className="line-clamp-2 text-xs text-zinc-400">
                      {n.body}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
