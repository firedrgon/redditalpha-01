"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { signIn, useSession } from "next-auth/react";
import SiteHeader from "@/app/components/SiteHeader";

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

/**
 * 已知定时任务的元信息（与 vercel.json 中的 schedule 对应）。
 * schedule 为 vercel.json 里的 UTC 表达式；beijing 为换算后的北京时间说明。
 */
const JOB_DEFS: Record<
  string,
  { label: string; desc: string; schedule: string; beijing: string }
> = {
  signals: {
    label: "信号扫描",
    desc: "扫描收藏股票的买卖信号（TradingView），写入提醒与站内通知",
    schedule: "0 14 * * 1-5（UTC）",
    beijing: "工作日 22:00",
  },
  "refresh-llm-models": {
    label: "刷新 LLM 模型",
    desc: "刷新各 LLM 供应商可用模型列表",
    schedule: "0 19 * * *（UTC）",
    beijing: "每天 03:00",
  },
};

/** 把 jobName（可能带 :xxx 后缀）映射到基础任务元信息 */
function jobMeta(name: string) {
  const base = name.split(":")[0];
  return JOB_DEFS[base] ?? null;
}

/** 是否是「认证失败」记录（外部未授权请求被 401 拒绝，非定时任务逻辑错误） */
function isAuthFail(name: string): boolean {
  return name.endsWith(":auth-fail");
}

/** 绝对时间：YYYY-MM-DD HH:mm:ss（按浏览器本地时区） */
function fmtAbs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间：X 秒/分钟/小时/天前 */
function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 耗时：保留 1 位小数秒 */
function fmtDuration(ms: number | null): string {
  if (ms == null) return "进行中…";
  const sec = ms / 1000;
  if (sec < 1) return `${Math.round(ms)}ms`;
  return `${sec.toFixed(1)}s`;
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
    <span
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${map[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
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
  // 用于"X 分钟前"相对时间刷新
  const [now, setNow] = useState<number>(() => Date.now());

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

  // 相对时间每 30s 刷新一次
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // 每个基础任务的"上次运行"摘要
  // 注意：认证失败（:auth-fail）是安全事件，不算作任务逻辑失败，单独计数
  const jobSummary = useMemo(() => {
    const map = new Map<
      string,
      {
        last: CronRunRow | null;
        count: number;
        errors: number;
        authFails: number;
      }
    >();
    for (const r of runs) {
      const base = r.jobName.split(":")[0];
      const cur = map.get(base) ?? {
        last: null,
        count: 0,
        errors: 0,
        authFails: 0,
      };
      cur.count += 1;
      if (isAuthFail(r.jobName)) {
        cur.authFails += 1;
      } else if (r.errorCount > 0) {
        cur.errors += 1;
      }
      if (!cur.last || r.startedAt > cur.last.startedAt) cur.last = r;
      map.set(base, cur);
    }
    return map;
  }, [runs]);

  // 按基础任务分组的运行历史（组内按开始时间倒序）
  const grouped = useMemo(() => {
    const groups = new Map<string, CronRunRow[]>();
    for (const r of runs) {
      const base = r.jobName.split(":")[0];
      const arr = groups.get(base) ?? [];
      arr.push(r);
      groups.set(base, arr);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => b.startedAt - a.startedAt);
    }
    // 固定顺序：已知任务在前，未知任务在后
    return Array.from(groups.entries()).sort((a, b) => {
      const ia = Object.keys(JOB_DEFS).indexOf(a[0]);
      const ib = Object.keys(JOB_DEFS).indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [runs]);

  // 全局统计（认证失败为安全噪声，单独计，不计入成功率分母）
  const totals = useMemo(() => {
    let errors = 0;
    let authFails = 0;
    for (const r of runs) {
      if (isAuthFail(r.jobName)) authFails += 1;
      else if (r.errorCount > 0 || r.status === "error") errors += 1;
    }
    const realRuns = runs.length - authFails;
    const success = realRuns - errors;
    const rate = realRuns > 0 ? Math.round((success / realRuns) * 100) : 100;
    return { runs: runs.length, errors, authFails, rate };
  }, [runs]);

  const health: "ok" | "error" =
    totals.errors > 0 ? "error" : "ok";

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
    <>
      <SiteHeader />
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* ── 顶部：健康概览 ── */}
        <div className="relative mb-6 overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900 to-orange-500/5 p-5">
          <div
            className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-orange-500/10 blur-3xl"
            aria-hidden
          />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-500/15 text-orange-400">
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <circle cx="12" cy="12" r="9" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">定时任务监控</h1>
              <p className="text-xs text-zinc-500">
                执行历史 · 成功率 · 错误明细（按浏览器本地时区）
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                health === "ok"
                  ? "border-green-500/30 bg-green-500/10 text-green-400"
                  : "border-red-500/30 bg-red-500/10 text-red-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  health === "ok" ? "bg-green-400" : "animate-pulse bg-red-400"
                }`}
              />
              {health === "ok" ? "运行正常" : "存在失败任务"}
            </span>
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
        </div>

        {/* 统计条 */}
        <div className="relative mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "总运行", value: String(totals.runs), tone: "text-zinc-100" },
            {
              label: "成功率",
              value: `${totals.rate}%`,
              tone: totals.rate >= 90 ? "text-green-400" : "text-amber-400",
            },
            {
              label: "失败",
              value: String(totals.errors),
              tone: totals.errors > 0 ? "text-red-400" : "text-zinc-400",
            },
            {
              label: "认证失败",
              value: String(totals.authFails),
              tone: totals.authFails > 0 ? "text-amber-400" : "text-zinc-400",
            },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"
            >
              <div className="text-[11px] text-zinc-500">{s.label}</div>
              <div className={`mt-1 text-2xl font-bold tabular-nums ${s.tone}`}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── 任务概览卡片 ── */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Object.entries(JOB_DEFS).map(([key, def]) => {
          const sum = jobSummary.get(key);
          const last = sum?.last ?? null;
          const iconCls =
            key === "signals"
              ? "bg-orange-500/15 text-orange-400"
              : "bg-sky-500/15 text-sky-400";
          const gradCls =
            key === "signals" ? "from-orange-500/15" : "from-sky-500/15";
          const icon =
            key === "signals" ? (
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
                  d="M3 17l5-5 4 4 8-8"
                />
              </svg>
            ) : (
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
                  d="M4 7h16M4 12h16M4 17h10"
                />
              </svg>
            );
          return (
            <div
              key={key}
              className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-all hover:border-zinc-700 hover:bg-zinc-900"
            >
              <div
                className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${gradCls} to-transparent opacity-60`}
                aria-hidden
              />
              <div className="relative">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg ${iconCls}`}
                    >
                      {icon}
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-zinc-100">
                        {def.label}
                      </h3>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                        {def.desc}
                      </p>
                    </div>
                  </div>
                  {last ? statusBadge(last.status) : null}
                </div>

                <div className="mt-4 space-y-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-zinc-600">计划</span>
                    <span className="text-zinc-300">{def.beijing}</span>
                    <span className="text-zinc-600">· {def.schedule}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-zinc-600">上次运行</span>
                    {last ? (
                      <>
                        <span className="font-mono text-zinc-300">
                          {fmtAbs(last.startedAt)}
                        </span>
                        <span className="text-zinc-500">
                          （{timeAgo(last.startedAt, now)}）
                        </span>
                      </>
                    ) : (
                      <span className="text-zinc-500">从未运行</span>
                    )}
                  </div>
                  {last && (
                    <div className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-zinc-600">耗时</span>
                      <span className="text-zinc-300">
                        {fmtDuration(
                          last.endedAt != null
                            ? last.endedAt - last.startedAt
                            : null
                        )}
                      </span>
                      {last.errorCount > 0 && (
                        <span className="text-red-400">
                          · {last.errorCount} 个错误
                        </span>
                      )}
                    </div>
                  )}
                  {sum && (
                    <div className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-zinc-600">近 50 次</span>
                      <span className="text-zinc-400">
                        共 {sum.count} 次
                        {sum.errors > 0 && (
                          <span className="text-red-400">
                            {" "}
                            · {sum.errors} 次失败
                          </span>
                        )}
                        {sum.authFails > 0 && (
                          <span className="text-amber-400">
                            {" "}
                            · {sum.authFails} 次认证失败
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 执行历史列表 ── */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-400">
          <span className="h-3.5 w-1 rounded-full bg-orange-500/70" />
          执行历史
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-normal text-zinc-400">
            {runs.length} 条
          </span>
        </h2>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-[88px] animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40"
            />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-10 text-center text-zinc-500">
          <svg
            viewBox="0 0 24 24"
            className="mx-auto mb-2 h-8 w-8 text-zinc-700"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          暂无执行记录
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([base, arr]) => {
            const meta = JOB_DEFS[base];
            const accent = base === "signals" ? "bg-orange-500" : "bg-sky-500";
            return (
              <div key={base}>
                <div className="mb-2.5 flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-sm ${accent}`} />
                  <span className="text-xs font-semibold text-zinc-200">
                    {meta ? meta.label : base}
                  </span>
                  <span className="font-mono text-[10px] text-zinc-600">
                    {base}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    · {arr.length} 条
                  </span>
                </div>
                <div className="space-y-2.5">
                  {arr.map((r) => {
                    const isAuth = isAuthFail(r.jobName);
                    const hasErrors =
                      (!isAuth && (r.errorCount > 0 || !!r.errorMessage)) ||
                      isAuth;
                    const duration =
                      r.endedAt != null ? r.endedAt - r.startedAt : null;
                    const barColor = isAuth
                      ? "border-l-amber-500/70"
                      : r.status === "error"
                      ? "border-l-red-500/70"
                      : r.status === "running"
                      ? "border-l-blue-500/70"
                      : "border-l-green-500/70";
                    const dotColor = isAuth
                      ? "bg-amber-400"
                      : r.status === "error"
                      ? "bg-red-400"
                      : r.status === "running"
                      ? "bg-blue-400"
                      : "bg-green-400";
                    return (
                      <div
                        key={r.id}
                        className={`relative overflow-hidden rounded-xl border border-l-2 bg-zinc-900/60 p-3 transition-colors hover:bg-zinc-900 ${barColor} ${
                          isAuth ? "border-amber-500/20" : "border-zinc-800"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            hasErrors
                              ? setExpanded(expanded === r.id ? null : r.id)
                              : undefined
                          }
                          className={`flex w-full flex-col gap-2 text-left ${
                            hasErrors ? "cursor-pointer" : "cursor-default"
                          }`}
                        >
                          {/* 第一行：状态 + 时间 */}
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor} ${
                                r.status === "running" ? "animate-pulse" : ""
                              }`}
                            />
                            {isAuth ? (
                              <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                                <span aria-hidden>🔒</span> 认证失败
                              </span>
                            ) : (
                              statusBadge(r.status)
                            )}
                            <span className="font-mono text-sm font-semibold text-zinc-100">
                              {fmtAbs(r.startedAt)}
                            </span>
                            <span className="text-xs text-zinc-500">
                              {timeAgo(r.startedAt, now)}
                            </span>
                          </div>
                          {/* 第二行：结束 + 耗时 */}
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-3.5 text-xs text-zinc-400">
                            <span>
                              <span className="text-zinc-600">结束 </span>
                              {r.endedAt != null ? fmtAbs(r.endedAt) : "—"}
                            </span>
                            <span>
                              <span className="text-zinc-600">耗时 </span>
                              <span className="text-zinc-200">
                                {fmtDuration(duration)}
                              </span>
                            </span>
                          </div>
                          {/* 第三行：计数 */}
                          <div className="flex flex-wrap items-center gap-3 pl-3.5 text-xs">
                            <span className="text-zinc-400">
                              总计 <span className="text-zinc-200">{r.total}</span>
                            </span>
                            <span className="text-green-400">
                              处理 <span>{r.processed}</span>
                            </span>
                            <span className="text-zinc-500">
                              跳过 <span>{r.skipped}</span>
                            </span>
                            <span
                              className={
                                r.errorCount > 0
                                  ? "text-red-400"
                                  : "text-zinc-600"
                              }
                            >
                              错误 <span>{r.errorCount}</span>
                            </span>
                            {hasErrors && (
                              <span className="text-[10px] text-zinc-600">
                                点击展开 ▾
                              </span>
                            )}
                          </div>
                        </button>
                        {hasErrors && expanded === r.id && (
                          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 pl-5 text-xs">
                            {isAuth ? (
                              <div className="text-amber-400">
                                🔒 <b>这是安全事件，不是定时任务逻辑错误。</b>
                                <br />
                                有人/程序在未携带正确 <code>Authorization</code>{" "}
                                头的情况下请求了 cron 端点（外部调用、手动测试或扫描器），
                                已被拒绝。Vercel 调度器调用时会自动带上正确的头，
                                所以真正的定时任务不受影响。
                                <br />
                                <span className="text-zinc-500">
                                  原始诊断：{r.errorMessage}
                                </span>
                              </div>
                            ) : (
                              r.errorMessage && (
                                <div className="mb-2 text-red-400">
                                  ⚠ {r.errorMessage}
                                </div>
                              )
                            )}
                            {r.errors && r.errors.length > 0 && (
                              <ul className="space-y-1">
                                {r.errors.map((e, i) => (
                                  <li key={i} className="text-zinc-400">
                                    <span className="font-mono text-zinc-300">
                                      {e.ticker}
                                    </span>
                                    {e.phase && (
                                      <span className="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">
                                        {e.phase}
                                      </span>
                                    )}
                                    <span className="ml-2 text-zinc-500">
                                      {e.error}
                                    </span>
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
              </div>
            );
          })}
        </div>
      )}
    </div>
    </>
  );
}
