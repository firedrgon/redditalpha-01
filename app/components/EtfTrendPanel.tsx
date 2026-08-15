"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { EtfEvaluation } from "@/lib/etf-evaluate";

interface EtfTrendItem {
  code: string;
  name: string;
  prefixedCode: string;
  board: "SH" | "SZ" | null;
  t0: boolean;
  tag: string;
  category: "pullback" | "newPool";
  dedupKey: string;
}

interface EtfTrendResult {
  pullback: EtfTrendItem[];
  newPool: EtfTrendItem[];
  total: number;
  date: string;
  fetchedAt: string;
  error?: string;
}

export type EtfTab = "pullback" | "newPool";

const TABS: { key: EtfTab; label: string; desc: string }[] = [
  { key: "pullback", label: "趋势回踩", desc: "回踩主升趋势线的 ETF · 同类仅展示一只" },
  { key: "newPool", label: "新入池", desc: "新进入主升浪池的 ETF · 同类仅展示一只" },
];

function eastmoneyEtfUrl(board: string | null, code: string): string {
  const prefix = board === "SH" ? "sh" : board === "SZ" ? "sz" : "sh";
  return `https://quote.eastmoney.com/${prefix}${code}.html`;
}

/** 评级徽章：A 绿 / B 蓝 / C 琥珀 / D 红 / ? 灰 */
function GradeBadge({ ev }: { ev: EtfEvaluation }) {
  const style: Record<string, string> = {
    A: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    B: "border-sky-500/40 bg-sky-500/15 text-sky-300",
    C: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    D: "border-red-500/40 bg-red-500/15 text-red-300",
    "?": "border-zinc-600/40 bg-zinc-700/20 text-zinc-400",
  };
  const cls = style[ev.grade] ?? style["?"];
  const tip = `${ev.summary}\n风险提示：${ev.warnings.length ? ev.warnings.join("；") : "无"}`;
  return (
    <span
      title={tip}
      className={`inline-flex cursor-help items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold ${cls}`}
    >
      评级 {ev.grade}
      <span className="font-mono">{ev.totalScore != null ? ev.totalScore.toFixed(0) : "—"}</span>
    </span>
  );
}

/** 单项进度条（分数越高越好）：>=70 绿 / >=50 琥珀 / 否则红 */
function ScoreBar({ label, score }: { label: string; score: number | null }) {
  const pct = score != null ? score : 0;
  const color =
    score == null
      ? "bg-zinc-700"
      : score >= 70
      ? "bg-emerald-500"
      : score >= 50
      ? "bg-amber-500"
      : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-[10px] text-zinc-500">
      <span className="w-6 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full rounded ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-6 shrink-0 text-right font-mono text-zinc-400">
        {score != null ? score.toFixed(0) : "—"}
      </span>
    </div>
  );
}

function EtfCard({
  item,
  evaluation,
  valuationProxy,
}: {
  item: EtfTrendItem;
  evaluation?: EtfEvaluation;
  valuationProxy?: boolean;
}) {
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
                aria-hidden="true"
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
            {evaluation ? (
              <GradeBadge ev={evaluation} />
            ) : (
              <span className="inline-flex items-center rounded border border-zinc-700/60 bg-zinc-800/30 px-1.5 py-0.5 text-[10px] text-zinc-600">
                评估中…
              </span>
            )}
          </div>
        </div>
      </div>

      {evaluation && (
        <div className="mt-3 space-y-1">
          <ScoreBar label="估值" score={evaluation.valuation.score} />
          <ScoreBar label="质量" score={evaluation.quality.score} />
          {valuationProxy && (
            <p className="pt-0.5 text-[10px] text-amber-400/80">
              估值分位为估算（该指数无历史数据，仅供参考）
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          className="h-16 rounded-xl border border-zinc-800 bg-zinc-900/40 animate-pulse"
        />
      ))}
    </div>
  );
}

interface Props {
  tab: EtfTab;
  onTabChange: (t: EtfTab) => void;
}

export default function EtfTrendPanel({ tab, onTabChange }: Props) {
  const [data, setData] = useState<EtfTrendResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /** 综合评估（code → 评估），best-effort，失败不阻塞主列表 */
  const [evals, setEvals] = useState<Record<string, EtfEvaluation> | null>(null);
  /** 通过估值筛选的 code 集合（未筛选时 = 全部） */
  const [passing, setPassing] = useState<Set<string> | null>(null);
  /** code → 估值分位是否代理估算（true=无真实历史，谨慎参考） */
  const [proxyMap, setProxyMap] = useState<Record<string, boolean>>({});
  /** 筛选元信息：被「分位缺失/代理估算」排除的计数（用于透明提示） */
  const [evalMeta, setEvalMeta] = useState<{
    filteredOutUnknown: number;
    filteredOutEstimated: number;
    returned: number;
    total: number;
  } | null>(null);

  // —— 估值筛选状态 ——
  const [vfGrade, setVfGrade] = useState(""); // 估值评级门槛：A/B/C/D/""(不限)
  const [vfPe, setVfPe] = useState(0); // PE 分位上限(0~100，0=不限)
  const [vfPb, setVfPb] = useState(0); // PB 分位上限(0~100，0=不限)
  const filterActive = vfGrade !== "" || vfPe > 0 || vfPb > 0;

  const loadEvals = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("top", "500");
      if (vfGrade) params.set("minValuationGrade", vfGrade);
      if (vfPe > 0) params.set("maxPePercentile", String(vfPe));
      if (vfPb > 0) params.set("maxPbPercentile", String(vfPb));
      const res = await fetch(`/api/etf-trend/evaluate?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = await res.json();
      const map: Record<string, EtfEvaluation> = {};
      const pass = new Set<string>();
      const proxy: Record<string, boolean> = {};
      for (const it of json.items ?? []) {
        if (it?.code && it.evaluation) {
          map[it.code] = it.evaluation;
          pass.add(it.code);
          proxy[it.code] = it.fundData?.valuation?.proxy ?? false;
        }
      }
      setEvals(map);
      setPassing(pass);
      setProxyMap(proxy);
      setEvalMeta({
        filteredOutUnknown: json.filteredOutUnknown ?? 0,
        filteredOutEstimated: json.filteredOutEstimated ?? 0,
        returned: json.returned ?? 0,
        total: json.total ?? 0,
      });
    } catch {
      /* 评估接口异常时静默降级：卡片仅不显示评级 */
    }
  }, [vfGrade, vfPe, vfPb]);

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

  // 估值筛选变化 / 首屏 → 重新拉评估（带筛选参数）
  useEffect(() => {
    loadEvals();
  }, [loadEvals]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const postRes = await fetch("/api/etf-trend", { method: "POST" });
      if (!postRes.ok) {
        const errText = await postRes.text().catch(() => "");
        throw new Error(`刷新失败 HTTP ${postRes.status}: ${errText.slice(0, 200)}`);
      }
      await load();
      await loadEvals();
    } catch (err) {
      console.error("[etf-trend] 刷新失败:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const clearFilters = () => {
    setVfGrade("");
    setVfPe(0);
    setVfPb(0);
  };

  const list = tab === "pullback" ? data?.pullback ?? [] : data?.newPool ?? [];
  const evalMap = useMemo(() => evals ?? {}, [evals]);
  // 应用估值筛选：仅显示通过筛选的 ETF
  const visibleList = useMemo(() => {
    if (!passing) return list;
    return list.filter((it) => passing.has(it.code));
  }, [list, passing]);
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
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/15 text-orange-400">
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
                  d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"
                />
              </svg>
            </span>
            ETF 主升浪
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            同花顺 ETF 主升浪池 · 按趋势信号分类 · 同类仅展示一只
            {data?.date && <span className="ml-1 text-zinc-600">（{data.date}）</span>}
            {fetchedTime && <span className="ml-1 text-zinc-600">更新于 {fetchedTime}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-xs font-medium text-orange-400 transition-all hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? (
            <>
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 animate-spin"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
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
                aria-hidden="true"
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
      <div className="mb-4 flex gap-2">
        {TABS.map((t) => {
          const count =
            t.key === "pullback" ? data?.pullback.length ?? 0 : data?.newPool.length ?? 0;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onTabChange(t.key)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all ${
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

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
        <span>综合评级：</span>
        <span className="inline-flex items-center rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-bold text-emerald-300">
          A 优
        </span>
        <span className="inline-flex items-center rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 font-bold text-sky-300">
          B 良
        </span>
        <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-bold text-amber-300">
          C 中
        </span>
        <span className="inline-flex items-center rounded border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 font-bold text-red-300">
          D 弱
        </span>
        <span className="text-zinc-600">估值+质量综合（东方财富数据）</span>
      </div>

      {/* 估值筛选 */}
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[10px] text-zinc-500">估值分位：</span>
        {[
          { label: "不限", v: 0 },
          { label: "低估≤30%", v: 30 },
          { label: "合理≤60%", v: 60 },
          { label: "≤80%", v: 80 },
        ].map((c) => {
          const active = vfPe === c.v;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => setVfPe(c.v)}
              className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-all ${
                active
                  ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                  : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              {c.label}
            </button>
          );
        })}

        <span className="ml-1 text-[10px] text-zinc-500">估值评级：</span>
        {[
          { label: "不限", v: "" },
          { label: "估值A", v: "A" },
          { label: "估值B+", v: "B" },
          { label: "估值C+", v: "C" },
        ].map((c) => {
          const active = vfGrade === c.v;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => setVfGrade(c.v)}
              className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-all ${
                active
                  ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                  : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              {c.label}
            </button>
          );
        })}

        {filterActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[10px] text-zinc-400 transition-all hover:text-zinc-200"
          >
            清除筛选
          </button>
        )}
        {/* PB 分位筛选（与 PE 对称） */}
        <span className="ml-2 text-[10px] text-zinc-500">PB 分位：</span>
        {[
          { label: "不限", v: 0 },
          { label: "≤30%", v: 30 },
          { label: "≤60%", v: 60 },
          { label: "≤80%", v: 80 },
        ].map((c) => {
          const active = vfPb === c.v;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => setVfPb(c.v)}
              className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-all ${
                active
                  ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                  : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              {c.label}
            </button>
          );
        })}

        {filterActive && (
          <span className="text-[10px] text-orange-400/80">
            筛选后 {visibleList.length} / {list.length} 只
          </span>
        )}
        {filterActive && evalMeta && (evalMeta.filteredOutUnknown > 0 || evalMeta.filteredOutEstimated > 0) && (
          <span className="text-[10px] text-amber-400/80">
            {evalMeta.filteredOutUnknown > 0 && ` ${evalMeta.filteredOutUnknown} 只分位缺失`}
            {evalMeta.filteredOutEstimated > 0 && ` ${evalMeta.filteredOutEstimated} 只分位为估算`}
            ，未纳入筛选
          </span>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
          <svg className="h-16 w-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>暂无{TABS.find((t) => t.key === tab)?.label}数据</p>
          <p className="mt-2 text-xs text-zinc-700">
            主升浪池共 {data?.total ?? 0} 只 ETF，当前分类无匹配信号
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleList.map((item) => (
            <EtfCard
              key={`${item.category}-${item.code}`}
              item={item}
              evaluation={evalMap[item.code]}
              valuationProxy={proxyMap[item.code]}
            />
          ))}
        </div>
      )}

      <div className="mt-8 border-t border-zinc-800 pt-6 text-center text-xs text-zinc-600">
        趋势池来源: 同花顺（10jqka）· 估值/质量评级来源: 东方财富（覆盖指数用每日 PE/PB 历史算真实分位，未覆盖指数标注「估算」，仅供参考，不构成投资建议）
      </div>
    </>
  );
}
