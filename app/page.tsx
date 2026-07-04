"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

const SUBREDDITS = [
  { id: "wallstreetbets", label: "WSB", full: "r/WallStreetBets" },
  { id: "stocks", label: "Stocks", full: "r/stocks" },
  { id: "cryptocurrency", label: "Crypto", full: "r/CryptoCurrency" },
  { id: "investing", label: "Investing", full: "r/investing" },
  { id: "pennystocks", label: "Penny", full: "r/pennystocks" },
  { id: "options", label: "Options", full: "r/options" },
  { id: "stockmarket", label: "Market", full: "r/StockMarket" },
  { id: "shortsqueeze", label: "Squeeze", full: "r/Shortsqueeze" },
];

// 刷新间隔：10 分钟
const REFRESH_INTERVAL = 10 * 60; // 秒

interface Ticker {
  rank: number;
  ticker: string;
  countPast24h: number;
  totalCount: number | null;
  lastUpdated: string | null;
  name?: string | null;
}

interface SubredditData {
  subreddit: string;
  tickers: Ticker[];
  lastUpdated: string | null;
  error?: string;
}

// ============================================================
// 收藏类型 & 本地存储工具
// ============================================================
interface FavoriteItem {
  ticker: string;
  name?: string | null;
  addedAt: number;
}

const FAVORITES_STORAGE_KEY = "reddit-alpha:favorites";

function loadFavorites(): FavoriteItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.ticker === "string" &&
        typeof item.addedAt === "number"
    );
  } catch {
    return [];
  }
}

function saveFavorites(items: FavoriteItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.error("Failed to save favorites:", err);
  }
}

// ============================================================
// 分析相关类型
// ============================================================
type Verdict = "pass" | "fail" | "unknown";

interface MetricResult {
  key: string;
  title: string;
  description: string;
  value: string;
  numericValue: number | null;
  threshold: string;
  verdict: Verdict;
  reasoning: string;
}

interface StockAnalysis {
  ticker: string;
  name?: string | null;
  metrics: MetricResult[];
  overallVerdict: Verdict;
  overallSummary: string;
  llmNarrative?: string;
  llmProvider?: string;
  llmError?: string;
  fetchedAt: string;
  cached?: boolean;
  dataSource?: string;
  warnings?: string[];
  strategyIdsUsed?: string[];
}

// ============================================================
// LLM Provider 类型
// ============================================================
interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  model: string;
  protocol: string;
  free: boolean;
  needsKey: boolean;
  signupUrl: string;
  docsUrl?: string;
  freeQuota: string;
  apiKeyMasked: string;
  hasKey: boolean;
  keySource: "env" | "local" | "none";
  envVarName: string;
  enabled: boolean;
  working: boolean | null;
  lastTested: number | null;
  lastError?: string | null;
}

interface ProvidersResponse {
  providers: ProviderInfo[];
  activeProvider: string | null;
  updatedAt: number;
}

// ============================================================
// 策略相关类型
// ============================================================
type MetricField =
  | "revenueGrowthYoY"
  | "quarterlyRevenueGrowth"
  | "trailingPE"
  | "forwardPE"
  | "pegRatio"
  | "returnOnEquity5yAvg"
  | "roe"
  | "quickRatio"
  | "currentRatio"
  | "grossMargin"
  | "profitMargin"
  | "peVsIndustry";

type Operator = ">=" | ">" | "<=" | "<" | "==" | "!=";
type ValueFormat = "percent" | "number" | "ratio";

interface StrategyCategory {
  id: string;
  name: string;
  description?: string;
  order: number;
  isDefault: boolean;
  color?: string;
}

interface Strategy {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  metricField: MetricField;
  operator: Operator;
  threshold: number;
  format: ValueFormat;
  enabled: boolean;
  isDefault: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
}

interface MetricFieldInfo {
  value: MetricField;
  label: string;
  format: ValueFormat;
  description: string;
}

interface StrategiesResponse {
  categories: StrategyCategory[];
  strategies: Strategy[];
  updatedAt: number;
  meta: {
    metricFields: MetricFieldInfo[];
    operators: Array<{ value: Operator; label: string }>;
    formats: Array<{ value: ValueFormat; label: string }>;
  };
}

// ============================================================
// 通用 UI 组件
// ============================================================
function RankBadge({ rank }: { rank: number }) {
  const colors =
    rank === 1
      ? "bg-yellow-400 text-yellow-900"
      : rank === 2
        ? "bg-gray-300 text-gray-800"
        : rank === 3
          ? "bg-amber-600 text-white"
          : "bg-zinc-700 text-zinc-300";
  return (
    <span
      className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${colors}`}
    >
      {rank}
    </span>
  );
}

function StarIcon({ filled, className = "" }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
      />
    </svg>
  );
}

function GearIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a6.759 6.759 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.241.437-.613.43-.992a6.759 6.759 0 010-.255c.007-.378-.138-.75-.43-.991l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.073-.05.146-.094.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const cfg = {
    pass: { label: "通过", cls: "bg-green-500/15 text-green-400 border-green-500/30" },
    fail: { label: "未通过", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
    unknown: { label: "数据缺失", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  }[verdict];
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function TickerCard({
  ticker,
  maxCount,
  subreddit,
  isFavorite,
  onToggleFavorite,
}: {
  ticker: Ticker;
  maxCount: number;
  subreddit: string;
  isFavorite: boolean;
  onToggleFavorite: (ticker: Ticker) => void;
}) {
  const pct = maxCount > 0 ? (ticker.countPast24h / maxCount) * 100 : 0;
  const redditUrl = `https://www.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(ticker.ticker)}&sort=relevance&t=week`;
  return (
    <div className="group relative flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left transition-all hover:border-orange-500/50 hover:bg-zinc-900">
      <RankBadge rank={ticker.rank} />
      <a
        href={redditUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 min-w-0 focus:outline-none"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-white tracking-wide">
              {ticker.ticker}
            </span>
            {ticker.name && (
              <span className="text-xs text-zinc-400">{ticker.name}</span>
            )}
          </div>
          <span className="text-sm font-mono text-orange-400 font-semibold">
            {ticker.countPast24h.toLocaleString()}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-orange-500 to-yellow-400 transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
          <span>提及次数 (24h)</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100 text-orange-400/70">
            在 Reddit 查看 →
          </span>
        </div>
      </a>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleFavorite(ticker);
        }}
        className={`absolute top-2 right-2 rounded-md p-1 transition-all ${
          isFavorite
            ? "text-yellow-400 hover:text-yellow-300"
            : "text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-300"
        }`}
        title={isFavorite ? "移除收藏" : "加入收藏"}
        aria-label={isFavorite ? "移除收藏" : "加入收藏"}
      >
        <StarIcon filled={isFavorite} className="h-4 w-4" />
      </button>
    </div>
  );
}

function FavoriteCard({
  item,
  onRemove,
  onAnalyze,
}: {
  item: FavoriteItem;
  onRemove: (ticker: string) => void;
  onAnalyze: (item: FavoriteItem) => void;
}) {
  const redditUrl = `https://www.reddit.com/search?q=${encodeURIComponent(item.ticker)}&sort=relevance&t=week`;
  return (
    <div className="group relative flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left transition-all hover:border-orange-500/50 hover:bg-zinc-900">
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold bg-zinc-800 text-yellow-400">
        <StarIcon filled className="h-4 w-4" />
      </span>
      <a
        href={redditUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 min-w-0 focus:outline-none"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold text-white tracking-wide">
            {item.ticker}
          </span>
          {item.name && (
            <span className="text-xs text-zinc-400">{item.name}</span>
          )}
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          收藏于 {new Date(item.addedAt).toLocaleString("zh-CN")}
        </div>
      </a>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onAnalyze(item)}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
          title="调用大模型分析（5项指标）"
        >
          分析
        </button>
        <button
          type="button"
          onClick={() => onRemove(item.ticker)}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-all hover:border-red-500/50 hover:text-red-400"
          title="移除收藏"
        >
          移除
        </button>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 15 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 animate-pulse"
        >
          <div className="w-7 h-7 rounded-full bg-zinc-700" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 rounded bg-zinc-700" />
            <div className="h-1.5 w-full rounded bg-zinc-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// ============================================================
// 分析弹窗
// ============================================================
function AnalysisModal({
  item,
  onClose,
}: {
  item: FavoriteItem;
  onClose: () => void;
}) {
  const [analysis, setAnalysis] = useState<StockAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forceCount, setForceCount] = useState(0); // 变化时触发重新分析

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    setAnalysis(null);
    (async () => {
      try {
        const force = forceCount > 0;
        const url = `/api/analyze?ticker=${encodeURIComponent(item.ticker)}${force ? "&force=true" : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }
        const json: StockAnalysis = await res.json();
        if (!cancelled) setAnalysis(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.ticker, forceCount]);

  const handleReanalyze = () => {
    setForceCount((n) => n + 1);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="关闭"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="mb-4">
          <div className="flex items-start justify-between gap-3 pr-8">
            <h3 className="text-xl font-bold">
              {item.ticker}
              {item.name && (
                <span className="ml-2 text-sm text-zinc-400">{item.name}</span>
              )}
            </h3>
            {analysis && !loading && (
              <button
                type="button"
                onClick={handleReanalyze}
                disabled={loading}
                className="shrink-0 rounded-lg border border-orange-500/40 bg-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 transition-all hover:bg-orange-500/30 disabled:opacity-40"
                title="重新拉取财务数据并调用大模型分析"
              >
                <span className="flex items-center gap-1">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  重新分析
                </span>
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            基于当前启用的策略分析
            {analysis && !loading && (
              <span className="ml-2 text-zinc-600">
                （共 {analysis.metrics.length} 项指标）
              </span>
            )}
            {analysis?.cached && (
              <span className="ml-2 inline-flex items-center rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-300">
                来自缓存
              </span>
            )}
          </p>
        </div>

        {loading && (
          <div className="space-y-3 py-8">
            <div className="text-center text-sm text-zinc-400">
              正在拉取财务数据并调用大模型...
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 rounded-lg bg-zinc-800/60 animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            分析失败：{error}
          </div>
        )}

        {analysis && !loading && (
          <div className="space-y-4">
            {/* 总判定 */}
            <div className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800/40 p-3">
              <VerdictBadge verdict={analysis.overallVerdict} />
              <div className="text-sm text-zinc-300">
                {analysis.overallSummary}
              </div>
            </div>

            {/* 5 项指标 */}
            <div className="space-y-2">
              {analysis.metrics.map((m) => (
                <div
                  key={m.key}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-zinc-100">
                          {m.title}
                        </span>
                        <VerdictBadge verdict={m.verdict} />
                      </div>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {m.description}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-mono text-orange-400">
                        {m.value}
                      </div>
                      <div className="text-[10px] text-zinc-600">
                        阈值 {m.threshold}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-zinc-400">{m.reasoning}</p>
                </div>
              ))}
            </div>

            {/* LLM 叙述 */}
            {analysis.llmNarrative && (
              <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-orange-400" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                  </svg>
                  <span className="text-xs font-medium text-orange-400">
                    大模型点评
                  </span>
                  {analysis.llmProvider && (
                    <span className="text-[10px] text-zinc-500">
                      · {analysis.llmProvider}
                    </span>
                  )}
                </div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
                  {analysis.llmNarrative}
                </div>
              </div>
            )}

            {/* 数据来源 & 警告：解释为何部分指标显示"未能获取该指标数据" */}
            {analysis.warnings && analysis.warnings.length > 0 && (
              <div className="rounded-lg border border-zinc-700/60 bg-zinc-800/30 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.852l.041-.02M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                  </svg>
                  <span className="text-xs font-medium text-zinc-300">
                    数据来源与警告
                  </span>
                  {analysis.dataSource && (
                    <span className="text-[10px] text-zinc-500">
                      · {analysis.dataSource}
                    </span>
                  )}
                </div>
                <ul className="ml-4 list-disc space-y-0.5 text-[11px] leading-relaxed text-zinc-400">
                  {analysis.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.llmError && (
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
                <div className="text-xs font-medium text-yellow-400">
                  大模型调用失败
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  {analysis.llmError}
                </div>
                <div className="mt-1 text-[11px] text-zinc-600">
                  请在右上角 ⚙ 设置中配置 LLM API Key（如 Groq 免费层）。
                </div>
              </div>
            )}

            <div className="text-right text-[10px] text-zinc-600">
              {analysis.cached ? "缓存时间" : "数据时间"}：{new Date(analysis.fetchedAt).toLocaleString("zh-CN")}
              {analysis.cached && " · 点击右上「重新分析」可刷新数据"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 设置弹窗（LLM 提供商 + 财务数据源）
// ============================================================
type SettingsTab = "llm" | "finance";

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("llm");

  // LLM 相关状态
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [llmLoading, setLlmLoading] = useState(true);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);

  // 财务数据源相关状态
  const [fmpKeyMasked, setFmpKeyMasked] = useState("");
  const [hasFmpKey, setHasFmpKey] = useState(false);
  const [avKeyMasked, setAvKeyMasked] = useState("");
  const [hasAvKey, setHasAvKey] = useState(false);
  const [financeLoading, setFinanceLoading] = useState(true);
  const [fmpKeyInput, setFmpKeyInput] = useState("");
  const [avKeyInput, setAvKeyInput] = useState("");
  const [financeError, setFinanceError] = useState<string | null>(null);
  const [savingFmp, setSavingFmp] = useState(false);
  const [savingAv, setSavingAv] = useState(false);

  const reloadLLM = useCallback(async () => {
    setLlmLoading(true);
    try {
      const res = await fetch("/api/llm-providers");
      const json: ProvidersResponse = await res.json();
      setProviders(json.providers);
      setActiveProvider(json.activeProvider);
      setLlmError(null);
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err));
    } finally {
      setLlmLoading(false);
    }
  }, []);

  const reloadFinance = useCallback(async () => {
    setFinanceLoading(true);
    try {
      const res = await fetch("/api/finance-config");
      const json = await res.json();
      setFmpKeyMasked(json.fmpApiKeyMasked || "");
      setHasFmpKey(!!json.hasFmpKey);
      setAvKeyMasked(json.avApiKeyMasked || "");
      setHasAvKey(!!json.hasAvKey);
      setFinanceError(null);
    } catch (err) {
      setFinanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinanceLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reloadLLM();
    reloadFinance();
  }, [reloadLLM, reloadFinance]);

  const updateProvider = async (
    providerId: string,
    action: "setKey" | "setEnabled" | "setActive",
    payload: { apiKey?: string; enabled?: boolean }
  ) => {
    try {
      const res = await fetch("/api/llm-providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, providerId, ...payload }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }
      await reloadLLM();
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveKey = async (providerId: string) => {
    const key = (keyInputs[providerId] || "").trim();
    if (!key) return;
    await updateProvider(providerId, "setKey", { apiKey: key });
    setKeyInputs((prev) => ({ ...prev, [providerId]: "" }));
  };

  const handleTestOne = async (providerId: string) => {
    setTesting(providerId);
    setLlmError(null);
    try {
      const res = await fetch("/api/llm-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }
      await reloadLLM();
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(null);
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    setLlmError(null);
    try {
      const res = await fetch("/api/llm-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }
      await reloadLLM();
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingAll(false);
    }
  };

  const handleSaveFmpKey = async () => {
    const key = fmpKeyInput.trim();
    if (!key) return;
    setSavingFmp(true);
    setFinanceError(null);
    try {
      const res = await fetch("/api/finance-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fmpApiKey: key }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }
      setFmpKeyInput("");
      await reloadFinance();
    } catch (err) {
      setFinanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingFmp(false);
    }
  };

  const handleSaveAvKey = async () => {
    const key = avKeyInput.trim();
    if (!key) return;
    setSavingAv(true);
    setFinanceError(null);
    try {
      const res = await fetch("/api/finance-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avApiKey: key }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }
      setAvKeyInput("");
      await reloadFinance();
    } catch (err) {
      setFinanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAv(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="关闭"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <GearIcon className="h-5 w-5 text-orange-400" />
            设置
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            管理 LLM 提供商和财务数据源的 API Key。Key 保存在本地，不会上传。
          </p>
        </div>

        <div className="mb-4 flex gap-1 border-b border-zinc-800">
          {[
            { id: "llm" as const, label: "LLM 提供商" },
            { id: "finance" as const, label: "财务数据源" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.id
                  ? "text-orange-400 border-orange-400"
                  : "text-zinc-400 border-transparent hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "llm" && (
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleTestAll}
                disabled={testingAll || llmLoading}
                className="rounded-lg border border-orange-500/40 bg-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 transition-all hover:bg-orange-500/30 disabled:opacity-40"
              >
                {testingAll ? "测试中..." : "测试所有已启用提供商"}
              </button>
              <span className="text-xs text-zinc-500">
                服务端每 6 小时自动检查一次（结果写回本地）
              </span>
            </div>

            {llmError && (
              <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                {llmError}
              </div>
            )}

            {llmLoading ? (
              <div className="py-8 text-center text-sm text-zinc-500">加载中...</div>
            ) : (
              <div className="space-y-3">
                {providers.map((p) => {
                  const isActive = activeProvider === p.id;
                  const working = p.working;
              return (
                <div
                  key={p.id}
                  className={`rounded-lg border p-4 transition-all ${
                    isActive
                      ? "border-orange-500/50 bg-orange-500/5"
                      : "border-zinc-800 bg-zinc-900/60"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-zinc-100">{p.name}</span>
                        {p.free && (
                          <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                            免费
                          </span>
                        )}
                        {p.needsKey ? (
                          <span className="text-[10px] text-zinc-600">需要 Key</span>
                        ) : (
                          <span className="text-[10px] text-zinc-600">无需 Key</span>
                        )}
                        {isActive && (
                          <span className="rounded border border-orange-500/40 bg-orange-500/15 px-1.5 py-0.5 text-[10px] text-orange-400">
                            活跃
                          </span>
                        )}
                        {working === true && (
                          <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                            可用
                          </span>
                        )}
                        {working === false && (
                          <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                            不可用
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-zinc-400">{p.description}</p>
                      <div className="mt-1 text-[11px] text-zinc-500">
                        模型：<span className="font-mono text-zinc-400">{p.model}</span>
                        {" · "}
                        免费额度：{p.freeQuota}
                      </div>
                      {p.hasKey && (
                        <div className="mt-1 text-[11px] text-zinc-600">
                          {p.keySource === "env" ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="rounded border border-blue-500/30 bg-blue-500/10 px-1.5 text-blue-400">
                                环境变量
                              </span>
                              <span className="font-mono">{p.envVarName}</span>
                              <span>·</span>
                              <span>{p.apiKeyMasked}</span>
                            </span>
                          ) : (
                            <>已配置 Key：{p.apiKeyMasked}</>
                          )}
                        </div>
                      )}
                      {!p.hasKey && p.needsKey && (
                        <div className="mt-1 text-[11px] text-zinc-600">
                        环境变量名：
                        <span className="font-mono text-zinc-500">{p.envVarName}</span>
                      </div>
                      )}
                      {p.lastError && (
                        <div className="mt-1 text-[11px] text-red-400/80">
                          错误：{p.lastError}
                        </div>
                      )}
                      <div className="mt-1">
                        <a
                          href={p.signupUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-orange-400/80 hover:text-orange-300"
                        >
                          注册 / 获取 API Key →
                        </a>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <label className="flex items-center gap-1 text-[11px] text-zinc-400">
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={(e) =>
                            updateProvider(p.id, "setEnabled", {
                              enabled: e.target.checked,
                            })
                          }
                        />
                        启用
                      </label>
                      <button
                        type="button"
                        onClick={() => updateProvider(p.id, "setActive", {})}
                        disabled={!p.enabled}
                        className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-orange-500/50 hover:text-orange-400 disabled:opacity-30"
                      >
                        设为活跃
                      </button>
                    </div>
                  </div>

                  {p.needsKey && p.keySource === "env" && (
                    <div className="mt-3 rounded border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-[11px] text-blue-300/80">
                      Key 由环境变量 <span className="font-mono">{p.envVarName}</span> 提供，无法在此处修改。
                    </div>
                  )}

                  {p.needsKey && p.keySource !== "env" && (
                    <div className="mt-3 flex gap-2">
                      <input
                        type="password"
                        value={keyInputs[p.id] || ""}
                        onChange={(e) =>
                          setKeyInputs((prev) => ({
                            ...prev,
                            [p.id]: e.target.value,
                          }))
                        }
                        placeholder="输入 API Key"
                        className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveKey(p.id)}
                        disabled={!keyInputs[p.id]}
                        className="rounded border border-orange-500/40 bg-orange-500/20 px-3 py-1 text-xs text-orange-400 hover:bg-orange-500/30 disabled:opacity-30"
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestOne(p.id)}
                        disabled={testing === p.id || !p.enabled || (!p.hasKey && !keyInputs[p.id])}
                        className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-orange-500/50 hover:text-orange-400 disabled:opacity-30"
                      >
                        {testing === p.id ? "测试中..." : "测试"}
                      </button>
                    </div>
                  )}

                  {!p.needsKey && (
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleTestOne(p.id)}
                        disabled={testing === p.id || !p.enabled}
                        className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-orange-500/50 hover:text-orange-400 disabled:opacity-30"
                      >
                        {testing === p.id ? "测试中..." : "测试"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

          <div className="mt-6 border-t border-zinc-800 pt-4 text-[11px] text-zinc-600">
            推荐配置：Groq（速度最快，免费层慷慨）→ 备选 Google Gemini（稳定）→ OpenRouter（多模型可选）
          </div>
        </div>
        )}

        {activeTab === "finance" && (
          <div className="space-y-4">
            {financeLoading ? (
              <div className="py-8 text-center text-sm text-zinc-500">加载中...</div>
            ) : (
              <>
            {financeError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                {financeError}
              </div>
            )}

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100">
                      Financial Modeling Prep (FMP)
                    </span>
                    <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                      免费
                    </span>
                    <span className="text-[10px] text-zinc-600">需要 Key</span>
                    {hasFmpKey && (
                      <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                        已配置
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    提供美股完整财务数据（PE、PEG、ROE、营收增长、速动比率等），免费 tier 每天 250 次请求。配置后将作为首选数据源，Yahoo Finance 自动降级。
                  </p>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    免费额度：每天 250 次请求
                  </div>
                  {hasFmpKey && fmpKeyMasked && (
                    <div className="mt-1 text-[11px] text-zinc-600">
                      已配置 Key：{fmpKeyMasked}
                    </div>
                  )}
                  <div className="mt-1">
                    <a
                      href="https://site.financialmodelingprep.com/developer/docs/pricing"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-orange-400/80 hover:text-orange-300"
                    >
                      注册 / 获取 API Key →
                    </a>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                <input
                  type="password"
                  value={fmpKeyInput}
                  onChange={(e) => setFmpKeyInput(e.target.value)}
                  placeholder="输入 FMP API Key"
                  className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveFmpKey}
                  disabled={!fmpKeyInput.trim() || savingFmp}
                  className="rounded border border-orange-500/40 bg-orange-500/20 px-3 py-1 text-xs text-orange-400 hover:bg-orange-500/30 disabled:opacity-30"
                >
                  {savingFmp ? "保存中..." : "保存"}
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100">
                      Alpha Vantage
                    </span>
                    <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                      免费
                    </span>
                    <span className="text-[10px] text-zinc-600">需要 Key</span>
                    {hasAvKey && (
                      <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                        已配置
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    FMP 的补充数据源，部分 FMP Premium 股票在 Alpha Vantage 中可免费访问。免费 tier 每天 25 次请求。
                  </p>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    免费额度：每天 25 次请求
                  </div>
                  {hasAvKey && avKeyMasked && (
                    <div className="mt-1 text-[11px] text-zinc-600">
                      已配置 Key：{avKeyMasked}
                    </div>
                  )}
                  <div className="mt-1">
                    <a
                      href="https://www.alphavantage.co/support/#api-key"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-orange-400/80 hover:text-orange-300"
                    >
                      注册 / 获取 API Key →
                    </a>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                <input
                  type="password"
                  value={avKeyInput}
                  onChange={(e) => setAvKeyInput(e.target.value)}
                  placeholder="输入 Alpha Vantage API Key"
                  className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveAvKey}
                  disabled={!avKeyInput.trim() || savingAv}
                  className="rounded border border-orange-500/40 bg-orange-500/20 px-3 py-1 text-xs text-orange-400 hover:bg-orange-500/30 disabled:opacity-30"
                >
                  {savingAv ? "保存中..." : "保存"}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3 text-[11px] text-zinc-500">
              <div className="font-medium text-zinc-400 mb-1">数据源优先级</div>
              <ol className="ml-4 list-decimal space-y-0.5">
                <li>FMP（Financial Modeling Prep）— 数据最完整</li>
                <li>Alpha Vantage — FMP Premium 股票的补充</li>
                <li>Yahoo Finance quoteSummary（带 crumb 认证）</li>
                <li>Yahoo Finance v7/quote（字段较少）</li>
              </ol>
            </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 策略管理弹窗（按分类组织）
// ============================================================
function StrategiesModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<StrategiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());

  // 策略编辑/新增表单
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formCategoryId, setFormCategoryId] = useState("");
  const [formField, setFormField] = useState<MetricField>("revenueGrowthYoY");
  const [formOperator, setFormOperator] = useState<Operator>(">=");
  const [formThreshold, setFormThreshold] = useState("0.1");
  const [formFormat, setFormFormat] = useState<ValueFormat>("percent");
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // 分类编辑
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [catFormName, setCatFormName] = useState("");
  const [catFormDesc, setCatFormDesc] = useState("");
  const [showAddCatForm, setShowAddCatForm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/strategies", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: StrategiesResponse = await res.json();
        if (cancelled) return;
        setData(json);
        setExpandedCats(new Set(json.categories.map((c) => c.id)));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 字段变化时同步 format
  useEffect(() => {
    if (!data) return;
    const info = data.meta.metricFields.find((f) => f.value === formField);
    if (info) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormFormat(info.format);
    }
  }, [formField, data]);

  const categories = data?.categories ?? [];
  const strategies = data?.strategies ?? [];
  const enabledCount = strategies.filter((s) => s.enabled).length;

  const strategiesByCat = (catId: string) =>
    strategies
      .filter((s) => s.categoryId === catId)
      .sort((a, b) => a.order - b.order);

  const toggleCat = (catId: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const fieldLabel = (f: MetricField) =>
    data?.meta.metricFields.find((x) => x.value === f)?.label ?? f;
  function fmt(n: number, fmt2: ValueFormat) {
    return fmt2 === "percent" ? `${(n * 100).toFixed(2)}%` : n.toFixed(2);
  }

  const catColorClasses = (color?: string) => {
    const map: Record<string, { text: string; border: string; bg: string }> = {
      green: { text: "text-green-400", border: "border-green-500/30", bg: "bg-green-500/10" },
      orange: { text: "text-orange-400", border: "border-orange-500/30", bg: "bg-orange-500/10" },
      purple: { text: "text-purple-400", border: "border-purple-500/30", bg: "bg-purple-500/10" },
      blue: { text: "text-blue-400", border: "border-blue-500/30", bg: "bg-blue-500/10" },
      pink: { text: "text-pink-400", border: "border-pink-500/30", bg: "bg-pink-500/10" },
      yellow: { text: "text-yellow-400", border: "border-yellow-500/30", bg: "bg-yellow-500/10" },
    };
    return map[color ?? "orange"] ?? map.orange;
  };

  // ---- 策略操作 ----
  const handleToggleStrategy = async (s: Strategy) => {
    try {
      const res = await fetch("/api/strategies", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, enabled: !s.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: StrategiesResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startEditStrategy = (s: Strategy) => {
    setEditingId(s.id);
    setEditingCatId(null);
    setShowAddForm(false);
    setFormName(s.name);
    setFormDesc(s.description);
    setFormCategoryId(s.categoryId);
    setFormField(s.metricField);
    setFormOperator(s.operator);
    setFormThreshold(String(s.threshold));
    setFormFormat(s.format);
  };

  const startAddStrategy = (catId?: string) => {
    setEditingId(null);
    setEditingCatId(null);
    setShowAddForm(true);
    setFormName("");
    setFormDesc("");
    setFormCategoryId(catId || categories[0]?.id || "");
    setFormField("revenueGrowthYoY");
    setFormOperator(">=");
    setFormThreshold("0.1");
    setFormFormat("percent");
  };

  const cancelStrategyForm = () => {
    setEditingId(null);
    setShowAddForm(false);
  };

  const handleSaveStrategy = async () => {
    if (!formName.trim()) {
      setError("名称不能为空");
      return;
    }
    if (!formCategoryId) {
      setError("请选择分类");
      return;
    }
    const thresholdNum = parseFloat(formThreshold);
    if (!Number.isFinite(thresholdNum)) {
      setError("阈值必须是数字");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        const res = await fetch("/api/strategies", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editingId,
            name: formName.trim(),
            description: formDesc.trim(),
            categoryId: formCategoryId,
            metricField: formField,
            operator: formOperator,
            threshold: thresholdNum,
            format: formFormat,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const json: StrategiesResponse = await res.json();
        setData(json);
      } else {
        const res = await fetch("/api/strategies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formName.trim(),
            description: formDesc.trim(),
            categoryId: formCategoryId,
            metricField: formField,
            operator: formOperator,
            threshold: thresholdNum,
            format: formFormat,
            enabled: true,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const json: StrategiesResponse = await res.json();
        setData(json);
        // 展开目标分类
        setExpandedCats((prev) => new Set(prev).add(formCategoryId));
      }
      setEditingId(null);
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStrategy = async (s: Strategy) => {
    if (!confirm(`确定删除策略「${s.name}」？`)) return;
    try {
      const res = await fetch(`/api/strategies?id=${encodeURIComponent(s.id)}&resource=strategy`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json: StrategiesResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- 分类操作 ----
  const startEditCategory = (cat: StrategyCategory) => {
    setEditingCatId(cat.id);
    setEditingId(null);
    setShowAddForm(false);
    setShowAddCatForm(false);
    setCatFormName(cat.name);
    setCatFormDesc(cat.description ?? "");
  };

  const startAddCategory = () => {
    setEditingCatId(null);
    setEditingId(null);
    setShowAddCatForm(true);
    setCatFormName("");
    setCatFormDesc("");
  };

  const cancelCategoryForm = () => {
    setEditingCatId(null);
    setShowAddCatForm(false);
  };

  const handleSaveCategory = async () => {
    if (!catFormName.trim()) {
      setError("分类名称不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingCatId) {
        const res = await fetch("/api/strategies", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resource: "category",
            id: editingCatId,
            name: catFormName.trim(),
            description: catFormDesc.trim(),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const json: StrategiesResponse = await res.json();
        setData(json);
      } else {
        const res = await fetch("/api/strategies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resource: "category",
            name: catFormName.trim(),
            description: catFormDesc.trim(),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const json: StrategiesResponse = await res.json();
        setData(json);
      }
      setEditingCatId(null);
      setShowAddCatForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCategory = async (cat: StrategyCategory) => {
    if (!confirm(`确定删除分类「${cat.name}」？该分类下的策略将被移到第一个分类。`)) return;
    try {
      const res = await fetch(`/api/strategies?id=${encodeURIComponent(cat.id)}&resource=category`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json: StrategiesResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleCategory = async (cat: StrategyCategory, enabled: boolean) => {
    try {
      const res = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: enabled ? "enableCategory" : "disableCategory",
          categoryId: cat.id,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: StrategiesResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleBatchToggle = async (enable: boolean) => {
    try {
      const res = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: enable ? "enableAll" : "disableAll",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: StrategiesResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReset = async () => {
    if (!confirm("确定重置为默认策略和分类？所有自定义内容将被删除。")) return;
    try {
      const res = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: StrategiesResponse = await res.json();
      setData(json);
      setExpandedCats(new Set(json.categories.map((c) => c.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="关闭"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="mb-4">
          <h3 className="text-xl font-bold">分析策略管理</h3>
          <p className="mt-1 text-xs text-zinc-500">
            按分类组织策略，可新增/编辑/删除分类和策略。分析时仅启用的策略参与判定。
          </p>
          <div className="mt-2 text-xs text-zinc-400">
            共 {categories.length} 个分类 · {strategies.length} 项策略 · 已启用 {enabledCount} 项
          </div>
        </div>

        {loading && (
          <div className="py-8 text-center text-sm text-zinc-400">加载中...</div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            {/* 顶部操作栏 */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => startAddStrategy()}
                className="rounded-lg border border-orange-500/40 bg-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 hover:bg-orange-500/30"
              >
                + 新增策略
              </button>
              <button
                type="button"
                onClick={startAddCategory}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-blue-500/40 hover:text-blue-400"
              >
                + 新增分类
              </button>
              <button
                type="button"
                onClick={() => handleBatchToggle(true)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-green-500/40 hover:text-green-400"
              >
                全部启用
              </button>
              <button
                type="button"
                onClick={() => handleBatchToggle(false)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-red-500/40 hover:text-red-400"
              >
                全部禁用
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-yellow-500/40 hover:text-yellow-400"
              >
                重置为默认
              </button>
            </div>

            {/* 新增分类表单 */}
            {showAddCatForm && (
              <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
                <div className="mb-2 text-xs font-medium text-blue-400">新增分类</div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={catFormName}
                    onChange={(e) => setCatFormName(e.target.value)}
                    placeholder="分类名称 (如 偿债能力)"
                    className="w-48 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-blue-500/60 focus:outline-none"
                  />
                  <input
                    type="text"
                    value={catFormDesc}
                    onChange={(e) => setCatFormDesc(e.target.value)}
                    placeholder="描述 (可空)"
                    className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-blue-500/60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={cancelCategoryForm}
                    disabled={saving}
                    className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCategory}
                    disabled={saving || !catFormName.trim()}
                    className="rounded border border-blue-500/40 bg-blue-500/20 px-3 py-1 text-xs text-blue-400 hover:bg-blue-500/30 disabled:opacity-40"
                  >
                    {saving ? "保存中..." : "新增"}
                  </button>
                </div>
              </div>
            )}

            {/* 全局新增策略表单 */}
            {showAddForm && !editingId && (
              <div className="mb-4 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
                <div className="mb-2 text-xs font-medium text-orange-400">新增策略</div>
                <StrategyForm
                  formName={formName}
                  formDesc={formDesc}
                  formCategoryId={formCategoryId}
                  formField={formField}
                  formOperator={formOperator}
                  formThreshold={formThreshold}
                  formFormat={formFormat}
                  categories={categories}
                  metricFields={data.meta.metricFields}
                  operators={data.meta.operators}
                  formats={data.meta.formats}
                  showCategory={true}
                  onName={setFormName}
                  onDesc={setFormDesc}
                  onCategory={setFormCategoryId}
                  onField={setFormField}
                  onOperator={setFormOperator}
                  onThreshold={setFormThreshold}
                  onFormat={setFormFormat}
                  onSave={handleSaveStrategy}
                  onCancel={cancelStrategyForm}
                  saving={saving}
                  submitLabel="新增"
                />
              </div>
            )}

            {/* 分类列表 */}
            <div className="space-y-3">
              {categories.map((cat) => {
                const catStrats = strategiesByCat(cat.id);
                const catEnabledCount = catStrats.filter((s) => s.enabled).length;
                const isExpanded = expandedCats.has(cat.id);
                const colors = catColorClasses(cat.color);
                const isCatEditing = editingCatId === cat.id;

                return (
                  <div
                    key={cat.id}
                    className={`rounded-lg border ${colors.border} bg-zinc-900/40 overflow-hidden`}
                  >
                    {/* 分类标题栏 */}
                    {!isCatEditing ? (
                      <div
                        className={`flex items-center gap-2 px-3 py-2 cursor-pointer select-none ${colors.bg}`}
                        onClick={() => toggleCat(cat.id)}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className={`h-4 w-4 ${colors.text} transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                        <span className={`text-sm font-bold ${colors.text}`}>
                          {cat.name}
                        </span>
                        {cat.isDefault && (
                          <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">
                            内置分类
                          </span>
                        )}
                        <span className="text-[11px] text-zinc-500">
                          {catStrats.length} 项 · 启用 {catEnabledCount} 项
                        </span>
                        {cat.description && (
                          <span className="text-[11px] text-zinc-500 hidden sm:inline">
                            · {cat.description}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleToggleCategory(cat, true); }}
                            className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-green-500/40 hover:text-green-400"
                            title="启用该分类下所有策略"
                          >
                            全启用
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleToggleCategory(cat, false); }}
                            className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-red-500/40 hover:text-red-400"
                            title="禁用该分类下所有策略"
                          >
                            全禁用
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startAddStrategy(cat.id); }}
                            className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-orange-500/40 hover:text-orange-400"
                          >
                            + 策略
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startEditCategory(cat); }}
                            className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-blue-500/40 hover:text-blue-400"
                          >
                            编辑
                          </button>
                          {!cat.isDefault && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleDeleteCategory(cat); }}
                              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-red-500/40 hover:text-red-400"
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className={`px-3 py-2 ${colors.bg}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            value={catFormName}
                            onChange={(e) => setCatFormName(e.target.value)}
                            className="w-40 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white focus:border-blue-500/60 focus:outline-none"
                          />
                          <input
                            type="text"
                            value={catFormDesc}
                            onChange={(e) => setCatFormDesc(e.target.value)}
                            placeholder="描述"
                            className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-blue-500/60 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={cancelCategoryForm}
                            disabled={saving}
                            className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={handleSaveCategory}
                            disabled={saving || !catFormName.trim()}
                            className="rounded border border-blue-500/40 bg-blue-500/20 px-2 py-0.5 text-[10px] text-blue-400 hover:bg-blue-500/30 disabled:opacity-40"
                          >
                            {saving ? "保存中..." : "保存"}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 分类下的策略列表 */}
                    {isExpanded && catStrats.length > 0 && (
                      <div className="divide-y divide-zinc-800 border-t border-zinc-800">
                        {catStrats.map((s) => {
                          const isEditing = editingId === s.id;
                          return (
                            <div
                              key={s.id}
                              className={`px-3 py-2 ${
                                s.enabled ? "bg-transparent" : "opacity-60"
                              }`}
                            >
                              {!isEditing ? (
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium text-zinc-100">
                                        {s.name}
                                      </span>
                                      {s.isDefault && (
                                        <span className="rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-500">
                                          内置
                                        </span>
                                      )}
                                      {!s.enabled && (
                                        <span className="rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-500">
                                          已禁用
                                        </span>
                                      )}
                                    </div>
                                    <p className="mt-0.5 text-[11px] text-zinc-500">
                                      {s.description || "（无说明）"}
                                    </p>
                                    <div className="mt-0.5 text-[11px] text-zinc-400">
                                      {fieldLabel(s.metricField)}
                                      <span className="mx-1 text-zinc-700">·</span>
                                      <span className="font-mono text-orange-400">
                                        {s.operator} {fmt(s.threshold, s.format)}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <label className="flex items-center gap-1 text-[11px] text-zinc-400">
                                      <input
                                        type="checkbox"
                                        checked={s.enabled}
                                        onChange={() => handleToggleStrategy(s)}
                                      />
                                      启用
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() => startEditStrategy(s)}
                                      className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-orange-500/40 hover:text-orange-400"
                                    >
                                      编辑
                                    </button>
                                    {!s.isDefault && (
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteStrategy(s)}
                                        className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-red-500/40 hover:text-red-400"
                                      >
                                        删除
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <StrategyForm
                                  formName={formName}
                                  formDesc={formDesc}
                                  formCategoryId={formCategoryId}
                                  formField={formField}
                                  formOperator={formOperator}
                                  formThreshold={formThreshold}
                                  formFormat={formFormat}
                                  categories={categories}
                                  metricFields={data.meta.metricFields}
                                  operators={data.meta.operators}
                                  formats={data.meta.formats}
                                  showCategory={true}
                                  onName={setFormName}
                                  onDesc={setFormDesc}
                                  onCategory={setFormCategoryId}
                                  onField={setFormField}
                                  onOperator={setFormOperator}
                                  onThreshold={setFormThreshold}
                                  onFormat={setFormFormat}
                                  onSave={handleSaveStrategy}
                                  onCancel={cancelStrategyForm}
                                  saving={saving}
                                  submitLabel="保存修改"
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {isExpanded && catStrats.length === 0 && (
                      <div className="border-t border-zinc-800 px-3 py-3 text-center text-[11px] text-zinc-600">
                        该分类下暂无策略，点击右上角「+ 策略」添加
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 策略编辑表单（支持选择分类）
function StrategyForm({
  formName,
  formDesc,
  formCategoryId,
  formField,
  formOperator,
  formThreshold,
  formFormat,
  categories,
  metricFields,
  operators,
  formats,
  showCategory,
  onName,
  onDesc,
  onCategory,
  onField,
  onOperator,
  onThreshold,
  onFormat,
  onSave,
  onCancel,
  saving,
  submitLabel,
}: {
  formName: string;
  formDesc: string;
  formCategoryId: string;
  formField: MetricField;
  formOperator: Operator;
  formThreshold: string;
  formFormat: ValueFormat;
  categories: StrategyCategory[];
  metricFields: MetricFieldInfo[];
  operators: Array<{ value: Operator; label: string }>;
  formats: Array<{ value: ValueFormat; label: string }>;
  showCategory?: boolean;
  onName: (v: string) => void;
  onDesc: (v: string) => void;
  onCategory: (v: string) => void;
  onField: (v: MetricField) => void;
  onOperator: (v: Operator) => void;
  onThreshold: (v: string) => void;
  onFormat: (v: ValueFormat) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={formName}
          onChange={(e) => onName(e.target.value)}
          placeholder="策略名称 (如 毛利率 > 30%)"
          className="flex-1 min-w-[200px] rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
        />
        <input
          type="text"
          value={formThreshold}
          onChange={(e) => onThreshold(e.target.value)}
          placeholder="阈值 (如 0.3)"
          className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
        />
      </div>
      <input
        type="text"
        value={formDesc}
        onChange={(e) => onDesc(e.target.value)}
        placeholder="说明 (可空)"
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
      />
      <div className="flex flex-wrap gap-2">
        {showCategory && (
          <select
            value={formCategoryId}
            onChange={(e) => onCategory(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white focus:border-orange-500/60 focus:outline-none"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                分类：{c.name}
              </option>
            ))}
          </select>
        )}
        <select
          value={formField}
          onChange={(e) => onField(e.target.value as MetricField)}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white focus:border-orange-500/60 focus:outline-none"
        >
          {metricFields.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={formOperator}
          onChange={(e) => onOperator(e.target.value as Operator)}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white focus:border-orange-500/60 focus:outline-none"
        >
          {operators.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={formFormat}
          onChange={(e) => onFormat(e.target.value as ValueFormat)}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white focus:border-orange-500/60 focus:outline-none"
          title="格式仅影响展示，会自动随字段同步"
        >
          {formats.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !formName.trim()}
            className="rounded border border-orange-500/40 bg-orange-500/20 px-3 py-1 text-xs text-orange-400 hover:bg-orange-500/30 disabled:opacity-40"
          >
            {saving ? "保存中..." : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [activeSub, setActiveSub] = useState("wallstreetbets");
  const [view, setView] = useState<"subreddit" | "favorites">("subreddit");
  const [data, setData] = useState<Record<string, SubredditData>>({});
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // 收藏状态（localStorage 持久化）
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [manualTicker, setManualTicker] = useState("");
  const [manualName, setManualName] = useState("");
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validateHint, setValidateHint] = useState<string | null>(null);

  // 分析弹窗
  const [analyzingItem, setAnalyzingItem] = useState<FavoriteItem | null>(null);

  // 设置弹窗（LLM 提供商 + 财务数据源）
  const [showSettings, setShowSettings] = useState(false);
  // 策略管理弹窗
  const [showStrategies, setShowStrategies] = useState(false);

  // 初始化：从 localStorage 读取收藏
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFavorites(loadFavorites());
  }, []);

  // 收藏变化时写回 localStorage
  useEffect(() => {
    saveFavorites(favorites);
  }, [favorites]);

  const favoriteTickers = useMemo(
    () => new Set(favorites.map((f) => f.ticker.toUpperCase())),
    [favorites]
  );

  const isFavorite = useCallback(
    (ticker: string) => favoriteTickers.has(ticker.toUpperCase()),
    [favoriteTickers]
  );

  const addFavorite = useCallback(
    (ticker: string, name?: string | null) => {
      const upper = ticker.trim().toUpperCase();
      if (!upper) return;
      setFavorites((prev) => {
        if (prev.some((f) => f.ticker.toUpperCase() === upper)) return prev;
        return [
          ...prev,
          { ticker: upper, name: name ?? null, addedAt: Date.now() },
        ];
      });
    },
    []
  );

  const removeFavorite = useCallback((ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    setFavorites((prev) =>
      prev.filter((f) => f.ticker.toUpperCase() !== upper)
    );
  }, []);

  const toggleFavorite = useCallback(
    (ticker: string, name?: string | null) => {
      const upper = ticker.trim().toUpperCase();
      if (!upper) return;
      setFavorites((prev) => {
        const exists = prev.some((f) => f.ticker.toUpperCase() === upper);
        if (exists) {
          return prev.filter((f) => f.ticker.toUpperCase() !== upper);
        }
        return [
          ...prev,
          { ticker: upper, name: name ?? null, addedAt: Date.now() },
        ];
      });
    },
    []
  );

  const handleToggleFromCard = useCallback(
    (t: Ticker) => {
      toggleFavorite(t.ticker, t.name);
    },
    [toggleFavorite]
  );

  const handleAnalyze = useCallback((item: FavoriteItem) => {
    setAnalyzingItem(item);
  }, []);

  // 手动添加：实时校验
  useEffect(() => {
    const sym = manualTicker.trim().toUpperCase();
    if (!sym) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValidateError(null);
      setValidateHint(null);
      return;
    }
    setValidating(true);
    setValidateError(null);
    setValidateHint(null);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/validate-ticker?ticker=${encodeURIComponent(sym)}`,
          { signal: controller.signal }
        );
        const json = await res.json();
        if (json.valid) {
          setValidateHint(
            `✓ 有效${json.name ? ` · ${json.name}` : ""}${json.quoteType ? ` · ${json.quoteType}` : ""}`
          );
          if (json.name && !manualName) {
            setManualName(json.name);
          }
        } else {
          setValidateError(json.error || "未找到该股票代码");
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setValidateError("校验请求失败");
      } finally {
        setValidating(false);
      }
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [manualTicker, manualName]);

  const handleManualAdd = useCallback(() => {
    const sym = manualTicker.trim().toUpperCase();
    if (!sym) return;
    addFavorite(sym, manualName.trim() || null);
    setManualTicker("");
    setManualName("");
    setValidateError(null);
    setValidateHint(null);
  }, [manualTicker, manualName, addFavorite]);

  const fetchData = useCallback(async (subreddit: string) => {
    try {
      const res = await fetch(`/api/tickers?subreddit=${subreddit}`);
      const json: SubredditData = await res.json();
      setData((prev) => ({ ...prev, [subreddit]: json }));
      setLastRefresh(new Date());
      setCountdown(REFRESH_INTERVAL);
    } catch (err) {
      console.error("Failed to fetch:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch("/api/tickers");
      const json = await res.json();
      if (json.subreddits) {
        const newData: Record<string, SubredditData> = {};
        for (const sub of json.subreddits) {
          newData[sub.subreddit] = sub;
        }
        setData(newData);
        setLastRefresh(new Date());
        setCountdown(REFRESH_INTERVAL);
      }
    } catch (err) {
      console.error("Failed to fetch all:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 挂载时拉取一次数据；loading 初始已为 true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchAll();
          return REFRESH_INTERVAL;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const currentData = data[activeSub];
  const tickers = currentData?.tickers || [];
  const maxCount = tickers.length > 0 ? tickers[0].countPast24h : 1;
  const subLabel = SUBREDDITS.find((s) => s.id === activeSub)?.full || activeSub;

  const buildShareText = () => {
    if (tickers.length === 0) return `Reddit Alpha · ${subLabel}`;
    const lines = tickers.map((t) => `${t.rank}. $${t.ticker} ${t.countPast24h.toLocaleString()}`);
    const now = new Date();
    const timeStr = now.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return [
      `以下是${subLabel}中过去24小时被提及最多的股票/加密货币排名`,
      ...lines,
      "",
      `数据时间: ${timeStr}`
    ].join("\n");
  };

  const handleShare = () => {
    const text = buildShareText();
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <header className="sticky top-0 z-50 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-red-600">
                <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">Reddit Alpha</h1>
                <p className="text-xs text-zinc-500">Real-time Reddit Stock Tracker</p>
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              {view === "subreddit" && (
                <button
                  onClick={handleShare}
                  disabled={tickers.length === 0}
                  className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-black/40 hover:bg-black hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  title="分享到 X"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  分享到 X
                </button>
              )}
              <button
                onClick={() => setShowStrategies(true)}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-orange-500/40 hover:text-orange-400"
                title="分析策略管理"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
                <span className="hidden sm:inline">策略</span>
              </button>
              <button
                onClick={() => setShowSettings(true)}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-orange-500/40 hover:text-orange-400"
                title="设置（LLM / 财务数据源）"
              >
                <GearIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">设置</span>
              </button>
              <div className="hidden sm:flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    loading ? "bg-yellow-400 animate-pulse" : "bg-green-400"
                  }`}
                />
                <span className="text-zinc-400">
                  {loading ? "加载中..." : `${formatCountdown(countdown)} 后刷新`}
                </span>
              </div>
              {lastRefresh && (
                <span className="hidden md:inline text-zinc-600 text-xs">
                  上次更新: {lastRefresh.toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      <nav className="border-b border-zinc-800 bg-zinc-950">
        <div className="mx-auto max-w-6xl px-4">
          <div className="flex gap-1 overflow-x-auto py-3 scrollbar-hide">
            {/* 收藏 Tab 放在最前面 */}
            <button
              onClick={() => setView("favorites")}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all flex items-center gap-1.5 ${
                view === "favorites"
                  ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/40"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 border border-transparent"
              }`}
            >
              <StarIcon filled={view === "favorites"} className="h-3.5 w-3.5" />
              收藏
              {favorites.length > 0 && (
                <span className="ml-0.5 rounded-full bg-zinc-800 px-1.5 text-[10px] font-mono text-zinc-300">
                  {favorites.length}
                </span>
              )}
            </button>
            <div className="mx-1 self-center text-zinc-700">|</div>
            {SUBREDDITS.map((sub) => (
              <button
                key={sub.id}
                onClick={() => {
                  setActiveSub(sub.id);
                  setView("subreddit");
                  if (!data[sub.id]) {
                    setLoading(true);
                    fetchData(sub.id);
                  }
                }}
                className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                  view === "subreddit" && activeSub === sub.id
                    ? "bg-orange-500/20 text-orange-400 border border-orange-500/40"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 border border-transparent"
                }`}
              >
                {sub.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {view === "subreddit" ? (
          <>
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">
                  {SUBREDDITS.find((s) => s.id === activeSub)?.full}
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Top 15 Tickers · 过去24小时提及次数
                </p>
              </div>
              {currentData?.lastUpdated && (
                <div className="text-right">
                  <div className="text-xs text-zinc-500">数据更新于</div>
                  <div className="text-sm text-zinc-400 font-mono">
                    {currentData.lastUpdated}
                  </div>
                </div>
              )}
            </div>

            {currentData?.error && (
              <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                数据加载错误: {currentData.error}
              </div>
            )}

            {loading && tickers.length === 0 ? (
              <LoadingSkeleton />
            ) : tickers.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {tickers.map((ticker) => (
                  <TickerCard
                    key={ticker.ticker}
                    ticker={ticker}
                    maxCount={maxCount}
                    subreddit={activeSub}
                    isFavorite={isFavorite(ticker.ticker)}
                    onToggleFavorite={handleToggleFromCard}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
                <svg className="h-16 w-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p>暂无数据</p>
              </div>
            )}

            <div className="mt-8 border-t border-zinc-800 pt-6 text-center text-xs text-zinc-600">
              数据来源:{" "}
              <a
                href="https://yolostocks.live/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-orange-500/70 hover:text-orange-400 transition-colors"
              >
                yolostocks.live
              </a>
              {" "}· 每10分钟自动刷新
            </div>
          </>
        ) : (
          <>
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <StarIcon filled className="h-6 w-6 text-yellow-400" />
                  我的收藏
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  已收藏 {favorites.length} 个标的 · 数据保存在本地
                </p>
              </div>
            </div>

            {/* 手动添加收藏（带校验） */}
            <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-300">
                  手动添加收藏
                </span>
                <span className="text-[11px] text-zinc-600">
                  输入后会自动通过 Yahoo Finance 校验
                </span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="flex-1">
                  <input
                    type="text"
                    value={manualTicker}
                    onChange={(e) => setManualTicker(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !validating && !validateError) {
                        handleManualAdd();
                      }
                    }}
                    placeholder="股票/代币代码 (如 AAPL)"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
                  />
                </div>
                <input
                  type="text"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !validating && !validateError) {
                      handleManualAdd();
                    }
                  }}
                  placeholder="名称 (可选, 如 苹果)"
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
                />
                <button
                  type="button"
                  onClick={handleManualAdd}
                  disabled={!manualTicker.trim() || validating || !!validateError}
                  className="rounded-lg border border-orange-500/40 bg-orange-500/20 px-4 py-2 text-sm font-medium text-orange-400 transition-all hover:bg-orange-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  添加
                </button>
              </div>
              <div className="mt-2 h-4 text-[11px]">
                {validating && (
                  <span className="text-zinc-500">校验中...</span>
                )}
                {!validating && validateHint && (
                  <span className="text-green-400">{validateHint}</span>
                )}
                {!validating && validateError && (
                  <span className="text-red-400">✗ {validateError}</span>
                )}
              </div>
            </div>

            {favorites.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {favorites.map((item) => (
                  <FavoriteCard
                    key={item.ticker}
                    item={item}
                    onRemove={removeFavorite}
                    onAnalyze={handleAnalyze}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
                <StarIcon filled={false} className="h-16 w-16 mb-4" />
                <p>暂无收藏</p>
                <p className="mt-1 text-xs text-zinc-700">
                  在热度列表点击星标，或在此手动添加
                </p>
              </div>
            )}

            <div className="mt-8 border-t border-zinc-800 pt-6 text-center text-xs text-zinc-600">
              收藏数据：浏览器 localStorage · 策略 / 分析缓存 / LLM Key：服务端本地文件
            </div>
          </>
        )}
      </main>

      {analyzingItem && (
        <AnalysisModal
          item={analyzingItem}
          onClose={() => setAnalyzingItem(null)}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
      {showStrategies && (
        <StrategiesModal onClose={() => setShowStrategies(false)} />
      )}
    </div>
  );
}
