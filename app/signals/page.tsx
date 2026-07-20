"use client";

import { useState, useEffect, useCallback } from "react";
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

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={tradingViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lg font-bold text-white hover:text-orange-400 transition-colors"
            >
              {alert.ticker}
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
          <div className="mt-2 text-xs text-zinc-500">{formatDate(alert.createdAt)}</div>
        </div>
        <button
          type="button"
          onClick={() => onDelete(alert.id)}
          className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400 transition-colors"
          title="删除"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          { label: "综合", signal: alert.overallSignal },
          { label: "振荡指标", signal: alert.oscillators },
          { label: "移动均线", signal: alert.movingAverages },
        ].map(({ label, signal }) => (
          <div key={label} className="flex flex-col items-center gap-1 rounded-md bg-zinc-800/50 p-2">
            <span className="text-[10px] text-zinc-500">{label}</span>
            <span className={`text-xs font-medium ${SIGNAL_COLORS[signal]}`}>
              ● {SIGNAL_LABELS[signal]}
            </span>
          </div>
        ))}
      </div>

      {alert.note && (
        <div className="mt-2 text-[10px] text-zinc-500">{alert.note}</div>
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
          className="h-24 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 animate-pulse"
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
        <div>
          <h1 className="text-2xl font-bold text-white">信号提醒</h1>
          <p className="mt-1 text-sm text-zinc-400">
            基于 TradingView 技术分析信号，只在状态反转时提醒建仓/平仓
          </p>
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

      <div className="mb-6 flex gap-3">
        <div className="flex-1 rounded-lg border border-green-500/30 bg-green-500/5 p-3">
          <div className="text-xs text-green-400/70">建仓</div>
          <div className="mt-1 text-2xl font-bold text-green-400">{buyCount}</div>
        </div>
        <div className="flex-1 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <div className="text-xs text-red-400/70">平仓</div>
          <div className="mt-1 text-2xl font-bold text-red-400">{sellCount}</div>
        </div>
        <div className="flex-1 rounded-lg border border-zinc-500/30 bg-zinc-500/5 p-3">
          <div className="text-xs text-zinc-400/70">总记录</div>
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
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center">
          <div className="text-zinc-500">暂无建仓/平仓信号</div>
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
