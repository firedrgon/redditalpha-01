"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";

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

interface Prefs {
  email: string | null;
  emailNotify: boolean;
  webpushNotify: boolean;
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

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

export default function NotificationsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [savingPref, setSavingPref] = useState(false);
  const [pushStatus, setPushStatus] = useState<string>("");

  const load = useCallback(async () => {
    if (!session?.user) return;
    setLoading(true);
    try {
      const [nRes, pRes] = await Promise.all([
        fetch("/api/notifications?limit=50", { cache: "no-store" }),
        fetch("/api/notifications/prefs", { cache: "no-store" }),
      ]);
      if (nRes.ok) {
        const d = await nRes.json();
        setItems(d.notifications ?? []);
        setUnread(d.unreadCount ?? 0);
      }
      if (pRes.ok) {
        setPrefs(await pRes.json());
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [session?.user]);

  useEffect(() => {
    if (status === "authenticated") void load();
  }, [status, load]);

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

  const openItem = (n: NotificationItem) => {
    if (!n.read) void markRead(n.id);
    router.push(n.link || "/notifications");
  };

  // ── 邮件偏好 ──
  const toggleEmail = async (val: boolean) => {
    if (!prefs) return;
    setPrefs({ ...prefs, emailNotify: val });
    setSavingPref(true);
    try {
      await fetch("/api/notifications/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailNotify: val }),
      });
    } finally {
      setSavingPref(false);
    }
  };

  // ── Web Push 订阅 ──
  const subscribePush = async (): Promise<boolean> => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushStatus("当前浏览器不支持 Web Push");
      return false;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus("未授权通知权限");
      return false;
    }
    const keyRes = await fetch("/api/notifications/push");
    const { publicKey } = await keyRes.json();
    if (!publicKey) {
      setPushStatus("服务端未配置 VAPID 密钥（无法启用 Web Push）");
      return false;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const save = await fetch("/api/notifications/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    if (!save.ok) {
      setPushStatus("订阅保存失败");
      return false;
    }
    return true;
  };

  const unsubscribePush = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/notifications/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      }
    } catch {
      /* ignore */
    }
  };

  const toggleWebPush = async (val: boolean) => {
    if (!prefs) return;
    setSavingPref(true);
    try {
      if (val) {
        const ok = await subscribePush();
        if (!ok) {
          setSavingPref(false);
          return;
        }
      } else {
        await unsubscribePush();
      }
      const res = await fetch("/api/notifications/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webpushNotify: val }),
      });
      if (res.ok) {
        setPrefs({ ...prefs, webpushNotify: val });
        setPushStatus(val ? "已开启 Web Push" : "已关闭 Web Push");
      }
    } finally {
      setSavingPref(false);
    }
  };

  // ── 未登录 ──
  if (status !== "authenticated") {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto max-w-screen-xl flex-1 px-4 py-16 text-center">
        <h1 className="text-2xl font-bold">通知中心</h1>
        <p className="mt-3 text-sm text-zinc-400">登录后可查看建仓/平仓信号提醒与推送设置。</p>
        <button
          onClick={() => void signIn("credentials")}
          className="mt-6 rounded-lg border border-orange-500/40 bg-orange-500/20 px-4 py-2 text-sm font-medium text-orange-300"
        >
          登录 / 注册
        </button>
      </main>
      </>
    );
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-screen-xl flex-1 px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">通知中心</h1>
          <p className="text-xs text-zinc-500">建仓 / 平仓信号提醒</p>
        </div>
        {unread > 0 && (
          <button
            onClick={markAll}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-orange-400 hover:border-orange-500/40"
          >
            全部标为已读（{unread}）
          </button>
        )}
      </div>

      {/* 通知列表 */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
        {loading ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-500">加载中…</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-zinc-600">
            暂无通知。当收藏产生建仓 / 平仓信号时，会在此提醒你。
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {items.map((n) => {
              const isBuy = n.type === "signal_buy";
              const accent = isBuy ? "border-l-red-500" : "border-l-green-500";
              return (
                <li
                  key={n.id}
                  onClick={() => openItem(n)}
                  className={`flex cursor-pointer items-start gap-3 border-l-2 px-4 py-3 transition-colors hover:bg-zinc-900 ${accent} ${
                    n.read ? "opacity-55" : ""
                  }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-zinc-100">{n.title}</span>
                      <span className="text-[11px] text-zinc-500">{timeAgo(n.createdAt)}</span>
                    </div>
                    {n.body && <p className="mt-1 text-xs text-zinc-400">{n.body}</p>}
                  </div>
                  {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-orange-400" />}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 通知设置 */}
      <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h2 className="mb-4 text-sm font-semibold text-zinc-200">通知设置</h2>
        <div className="space-y-4">
          {/* 邮件 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-zinc-200">邮件提醒</div>
              <div className="text-xs text-zinc-500">
                {prefs?.email ? `发送至 ${prefs.email}` : "未绑定邮箱，无法使用邮件提醒"}
              </div>
            </div>
            <button
              disabled={savingPref || !prefs?.email}
              onClick={() => toggleEmail(!prefs!.emailNotify)}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                prefs?.emailNotify ? "bg-orange-500" : "bg-zinc-700"
              } ${!prefs?.email ? "cursor-not-allowed opacity-40" : ""}`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  prefs?.emailNotify ? "left-5" : "left-0.5"
                }`}
              />
            </button>
          </div>

          {/* Web Push */}
          <div className="flex items-center justify-between border-t border-zinc-800 pt-4">
            <div>
              <div className="text-sm text-zinc-200">浏览器推送 (Web Push)</div>
              <div className="text-xs text-zinc-500">
                关闭页面也能收到系统级通知。需服务端配置 VAPID 密钥。
              </div>
              {pushStatus && <div className="mt-1 text-[11px] text-orange-400">{pushStatus}</div>}
            </div>
            <button
              disabled={savingPref}
              onClick={() => toggleWebPush(!prefs!.webpushNotify)}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                prefs?.webpushNotify ? "bg-orange-500" : "bg-zinc-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  prefs?.webpushNotify ? "left-5" : "left-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      </section>
    </main>
    </>
  );
}
