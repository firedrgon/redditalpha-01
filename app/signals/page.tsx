"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { signIn, useSession } from "next-auth/react";

type Signal = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
type SignalType = "buy" | "sell" | "neutral";

const SIGNAL_LABELS: Record<Signal, string> = {
  strong_sell: "强烈卖出",
  sell: "卖出",
  neutral: "中立",
  buy: "买入",
  strong_buy: "强烈买入",
};

const SIGNAL_COLORS: Record<Signal, string> = {
  strong_sell: "text-red-600",
  sell: "text-red-400",
  neutral: "text-zinc-400",
  buy: "text-green-400",
  strong_buy: "text-green-600",
};

// 5 档强度刻度：强卖红 → 中性灰 → 强买绿（激活段点亮）
const SIGNAL_ORDER: Signal[] = [
  "strong_sell",
  "sell",
  "neutral",
  "buy",
  "strong_buy",
];
const SIGNAL_SEG_BG = [
  "bg-red-600",
  "bg-red-400",
  "bg-zinc-500",
  "bg-green-400",
  "bg-green-600",
];

const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  buy: "建仓",
  sell: "平仓",
  neutral: "今日已检查",
};

const SIGNAL_TYPE_COLORS: Record<SignalType, string> = {
  buy: "bg-green-500/15 text-green-400 border-green-500/30",
  sell: "bg-red-500/15 text-red-400 border-red-500/30",
  neutral: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

interface SignalAlert {
  id: string;
  ticker: string;
  tickerName?: string | null;
  signalType: SignalType;
  overallSignal: Signal;
  oscillators: Signal;
  movingAverages: Signal;
  price?: number | null;
  note?: string | null;
  createdAt: string;
}

interface RunResultItem {
  processed: boolean;
  skipped: boolean;
  phase?: string;
  error?: string;
  overall?: Signal;
}

interface RunResponse {
  success?: boolean;
  runId?: string;
  total: number;
  processed: number;
  skipped: number;
  errorCount: number;
  errors?: { ticker: string; error: string; phase?: string }[];
  results?: RunResultItem[];
  message?: string;
  error?: string;
  retryAfterSec?: number;
}

interface SignalsResponse {
  signals: SignalAlert[];
  total: number;
  hasMore: boolean;
  error?: string;
}

function SignalStrengthRow({
  label,
  signal,
}: {
  label: string;
  signal: Signal;
}) {
  const active = SIGNAL_ORDER.indexOf(signal);
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500">{label}</span>
        <span className={`text-[10px] font-medium ${SIGNAL_COLORS[signal]}`}>
          {SIGNAL_LABELS[signal]}
        </span>
      </div>
      <div className="mt-1 flex gap-0.5">
        {SIGNAL_ORDER.map((s, i) => (
          <span
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i === active ? SIGNAL_SEG_BG[i] : "bg-zinc-800"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function SignalAlertCard({
  alert,
  onDelete,
}: {
  alert: SignalAlert;
  onDelete: (id: string) => void;
}) {
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));

    if (hours < 1) return "刚刚";
    if (hours < 24) return `${hours}小时前`;
    if (hours < 48) return "昨天";

    return date.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const tradingViewUrl = `https://cn.tradingview.com/symbols/${encodeURIComponent(alert.ticker)}/`;

  const accent =
    alert.signalType === "buy"
      ? "border-l-green-500/60"
      : alert.signalType === "sell"
        ? "border-l-red-500/60"
        : "border-l-zinc-600/60";

  return (
    <div
      className={`group/card relative overflow-hidden rounded-xl border border-zinc-800 border-l-2 bg-zinc-900/60 p-4 transition-all hover:border-zinc-700 hover:bg-zinc-900/80 ${accent}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={tradingViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-lg font-bold text-white transition-colors hover:text-orange-400"
            >
              {alert.ticker}
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
            {alert.tickerName && (
              <span className="text-xs text-zinc-400 truncate">{alert.tickerName}</span>
            )}
            <span
              className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${SIGNAL_TYPE_COLORS[alert.signalType]}`}
            >
              {SIGNAL_TYPE_LABELS[alert.signalType]}
            </span>
          </div>
          <div className="mt-1.5 text-xs text-zinc-500">{formatDate(alert.createdAt)}</div>
        </div>
        <button
          type="button"
          onClick={() => onDelete(alert.id)}
          className="shrink-0 rounded-md p-1.5 text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-red-400 group-hover/card:opacity-100"
          title="删除"
        >
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
              d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
            />
          </svg>
        </button>
      </div>

      <div className="mt-3 space-y-2 rounded-lg bg-zinc-950/40 p-3">
        <SignalStrengthRow label="综合" signal={alert.overallSignal} />
        <SignalStrengthRow label="振荡指标" signal={alert.oscillators} />
        <SignalStrengthRow label="移动均线" signal={alert.movingAverages} />
      </div>

      {alert.note && (
        <div className="mt-2 text-[10px] leading-relaxed text-zinc-500">{alert.note}</div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-28 rounded-xl border border-zinc-800 border-l-2 border-l-zinc-600/60 bg-zinc-900/40 p-4 animate-pulse"
        />
      ))}
    </div>
  );
}

export default function SignalsPage() {
  const { data: session, status } = useSession();
  const [signals, setSignals] = useState<SignalAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  // 手动触发状态
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [cooldownSec, setCooldownSec] = useState(0);

  // Cooldown 倒计时
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setTimeout(() => setCooldownSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  const fetchSignals = useCallback(async (fetchOffset = 0) => {
    if (!session?.user) return;

    try {
      const url = `/api/signals?offset=${fetchOffset}&limit=20`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json: SignalsResponse = await res.json();

      if (fetchOffset === 0) {
        setSignals(json.signals);
      } else {
        setSignals((prev) => [...prev, ...json.signals]);
      }
      setHasMore(json.hasMore);
      setOffset(fetchOffset + json.signals.length);
    } catch (err) {
      console.error("[signals] 获取信号失败:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [session?.user]);

  useEffect(() => {
    if (session?.user) {
      fetchSignals(0);
    }
  }, [session?.user, fetchSignals]);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/signals?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setSignals((prev) => prev.filter((s) => s.id !== id));
      }
    } catch (err) {
      console.error("[signals] 删除信号失败:", err);
    }
  };

  const handleLoadMore = () => {
    if (!hasMore || loading) return;
    fetchSignals(offset);
  };

  const handleManualRun = async () => {
    if (running || cooldownSec > 0) return;
    setRunning(true);
    setRunError(null);
    setRunMessage(null);
    try {
      const res = await fetch("/api/signals/run", { method: "POST" });
      const data: RunResponse = await res.json();

      if (res.status === 429 && data.retryAfterSec) {
        setCooldownSec(data.retryAfterSec);
        setRunError(data.error ?? "操作太频繁");
        return;
      }

      if (!res.ok) {
        setRunError(data.error ?? `HTTP ${res.status}`);
        return;
      }

      const parts: string[] = [];
      parts.push(`处理 ${data.total} 只`);
      parts.push(`成功 ${data.processed}`);
      if (data.errorCount > 0) parts.push(`失败 ${data.errorCount}`);
      if (data.skipped > 0) parts.push(`跳过 ${data.skipped}`);
      setRunMessage(parts.join("，"));

      // 60 秒 cooldown
      setCooldownSec(60);

      // 刷新列表
      await fetchSignals(0);
    } catch (err) {
      console.error("[signals] 手动触发失败:", err);
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const buyCount = signals.filter((s) => s.signalType === "buy").length;
  const sellCount = signals.filter((s) => s.signalType === "sell").length;

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-zinc-400">加载中...</div>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-white mb-2">请登录查看信号提醒</h2>
          <button
            type="button"
            onClick={() => signIn()}
            className="rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-2 text-sm font-medium text-orange-400 transition-all hover:bg-orange-500/20"
          >
            登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link
            href="/"
            className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
          >
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
                d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
              />
            </svg>
            返回
          </Link>
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
                    d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
                  />
                </svg>
              </span>
              信号提醒
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              基于 TradingView 技术分析信号，只在状态反转时提醒建仓/平仓
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleManualRun}
          disabled={running || cooldownSec > 0}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-400 transition-all hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? (
            <>
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 animate-spin"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4v4m0 0a8 8 0 100 8 8 8 0 000-8z"
                />
              </svg>
              获取中…
            </>
          ) : cooldownSec > 0 ? (
            `等待 ${cooldownSec}s`
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
              立即获取
            </>
          )}
        </button>
      </div>

      {runMessage && (
        <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
          {runMessage}
        </div>
      )}
      {runError && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {runError}
        </div>
      )}

      <div className="mb-6 grid grid-cols-3 gap-3">
        <div className="relative overflow-hidden rounded-xl border border-green-500/30 bg-green-500/5 p-3">
          <div className="absolute -right-3 -top-3 h-12 w-12 rounded-full bg-green-500/10 blur-xl" />
          <div className="flex items-center gap-1.5 text-xs text-green-400/70">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
            </svg>
            建仓
          </div>
          <div className="mt-1 text-2xl font-bold text-green-400">{buyCount}</div>
        </div>
        <div className="relative overflow-hidden rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <div className="absolute -right-3 -top-3 h-12 w-12 rounded-full bg-red-500/10 blur-xl" />
          <div className="flex items-center gap-1.5 text-xs text-red-400/70">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6L9 12.75l4.306-4.307a11.95 11.95 0 015.814 5.519l2.74 1.22m0 0l-5.94 2.28m5.94-2.28l-2.28-5.941" />
            </svg>
            平仓
          </div>
          <div className="mt-1 text-2xl font-bold text-red-400">{sellCount}</div>
        </div>
        <div className="relative overflow-hidden rounded-xl border border-zinc-500/30 bg-zinc-500/5 p-3">
          <div className="absolute -right-3 -top-3 h-12 w-12 rounded-full bg-zinc-500/10 blur-xl" />
          <div className="flex items-center gap-1.5 text-xs text-zinc-400/70">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12M8.25 17.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            总记录
          </div>
          <div className="mt-1 text-2xl font-bold text-zinc-300">{signals.length}</div>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : signals.length === 0 ? (
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
                d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
              />
            </svg>
          </div>
          <div className="text-zinc-400">暂无建仓/平仓信号</div>
          <p className="mt-2 text-xs text-zinc-600">
            系统只在状态反转时提醒。
            <br />
            重点关注的股票出现买入信号时空仓会建仓，出现卖出信号时持仓会平仓。
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {signals.map((alert) => (
              <SignalAlertCard key={alert.id} alert={alert} onDelete={handleDelete} />
            ))}
          </div>

          {hasMore && (
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loading}
                className="rounded-lg border border-zinc-700 px-6 py-2 text-sm text-zinc-400 transition-all hover:border-orange-500/50 hover:text-orange-400 disabled:opacity-50"
              >
                {loading ? "加载中..." : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
