"use client";

import { useState, useEffect, useCallback } from "react";
import { signIn, useSession } from "next-auth/react";

type CronRunStatus = "running" | "success" | "error";

interface CronRunErrorItem {
  ticker: string;
  error: string;
  phase?: string;
}

interface CronRunRow {
  id: string;
  jobName: string;
  startedAt: number;
  endedAt: number | null;
  status: CronRunStatus;
  total: number;
  processed: number;
  skipped: number;
  errorCount: number;
  errors: CronRunErrorItem[] | null;
  errorMessage: string | null;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusBadge(status: CronRunStatus) {
  const map: Record<CronRunStatus, string> = {
    running: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    success: "bg-green-500/15 text-green-400 border-green-500/30",
    error: "bg-red-500/15 text-red-400 border-red-500/30",
  };
  const label: Record<CronRunStatus, string> = {
    running: "运行中",
    success: "成功",
    error: "失败",
  };
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-medium ${map[status]}`}>
      {label[status]}
    </span>
  );
}

export default function AdminCronPage() {
  const { data: session, status } = useSession();
  const [runs, setRuns] = useState<CronRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/cron-runs?limit=50", {
        cache: "no-store",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = await res.json();
      setRuns(j.runs ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session?.user && (session.user as { isAdmin?: boolean }).isAdmin) {
      load();
    }
  }, [session, load]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-zinc-400">
        加载中…
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-white">请登录</h2>
          <button
            onClick={() => signIn()}
            className="mt-4 rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-2 text-sm font-medium text-orange-400 hover:bg-orange-500/20"
          >
            登录
          </button>
        </div>
      </div>
    );
  }

  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center text-zinc-400">
          <h2 className="text-xl font-bold text-white">无权限</h2>
          <p className="mt-2 text-sm">仅管理员可访问此页面</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">定时任务监控</h1>
          <p className="mt-1 text-sm text-zinc-500">
            查看所有 cron 任务的执行历史、成功率与错误明细
          </p>
        </div>
        <button
          onClick={() => {
            if (cooldown > 0) return;
            setCooldown(15);
            setLoading(true);
            load();
          }}
          disabled={cooldown > 0}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400 disabled:opacity-50"
        >
          {cooldown > 0 ? `刷新 ${cooldown}s` : "刷新"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-zinc-500">
          暂无执行记录
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => {
            const duration =
              r.endedAt != null
                ? `${Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000))}s`
                : "—";
            const hasErrors = r.errorCount > 0 || !!r.errorMessage;
            return (
              <div
                key={r.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
              >
                <button
                  type="button"
                  onClick={() => hasErrors ? setExpanded(expanded === r.id ? null : r.id) : undefined}
                  className="flex w-full flex-wrap items-center gap-3 text-left"
                >
                  <span className="font-mono text-sm font-semibold text-zinc-200">
                    {r.jobName}
                  </span>
                  {statusBadge(r.status)}
                  <span className="text-xs text-zinc-500">{fmtTime(r.startedAt)}</span>
                  <span className="text-xs text-zinc-600">· 耗时 {duration}</span>
                  <span className="ml-auto flex gap-3 text-xs">
                    <span className="text-zinc-400">总计 {r.total}</span>
                    <span className="text-green-400">处理 {r.processed}</span>
                    <span className="text-zinc-500">跳过 {r.skipped}</span>
                    <span className={r.errorCount > 0 ? "text-red-400" : "text-zinc-600"}>
                      错误 {r.errorCount}
                    </span>
                  </span>
                </button>
                {hasErrors && expanded === r.id && (
                  <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs">
                    {r.errorMessage && (
                      <div className="mb-2 text-red-400">⚠ {r.errorMessage}</div>
                    )}
                    {r.errors && r.errors.length > 0 && (
                      <ul className="space-y-1">
                        {r.errors.map((e, i) => (
                          <li key={i} className="text-zinc-400">
                            <span className="font-mono text-zinc-300">{e.ticker}</span>
                            {e.phase && (
                              <span className="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">
                                {e.phase}
                              </span>
                            )}
                            <span className="ml-2 text-zinc-500">{e.error}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
