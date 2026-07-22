"use client";

import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { signIn, signOut, useSession } from "next-auth/react";

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

// 外部跳转链接生成（A 股用 .SH/.SZ 后缀，美股用 -US）
const isCNTicker = (t: string) => /^\d{6}\.(SH|SZ)$/.test(t);
// A 股代码提取（600276.SH → 600276）
const cnCode = (ticker: string) =>
  isCNTicker(ticker) ? ticker.slice(0, 6) : "";

// 富途：A 股 https://www.futunn.com/stock/600276.SH ，美股 .../AAPL-US
const futuUrl = (ticker: string) =>
  isCNTicker(ticker)
    ? `https://www.futunn.com/stock/${ticker}`
    : `https://www.futunn.com/stock/${ticker}-US`;
// 百度股市通：仅 A 股
const baiduStockUrl = (ticker: string) => {
  if (!isCNTicker(ticker)) return "";
  const code = cnCode(ticker);
  return code ? `https://gushitong.baidu.com/stock/ab-${code}` : "";
};
// 同花顺财务诊断：仅 A 股
const thsDiagnosisUrl = (ticker: string) => {
  if (!isCNTicker(ticker)) return "";
  const m = ticker.match(/^(\d{6})\.(SH|SZ)$/);
  if (!m) return "";
  const marketid = m[2] === "SH" ? 17 : 33;
  return `https://eq.10jqka.com.cn/webpage/financial-diagnosis/index.html?code=${m[1]}&marketid=${marketid}#/`;
};

const tradingViewUrl = (ticker: string) =>
  `https://cn.tradingview.com/symbols/${encodeURIComponent(ticker)}/`;

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
// 收藏类型
// ============================================================
interface FavoriteItem {
  ticker: string;
  name?: string | null;
  addedAt: number;
  pinned?: boolean;
  starred?: boolean;
}

/** 将后端 /api/favorites 返回的原始对象映射为前端 FavoriteItem */
function mapFavoriteFromApi(f: {
  ticker: string;
  name?: string | null;
  createdAt: number;
  pinned?: boolean;
  starred?: boolean;
}): FavoriteItem {
  return {
    ticker: f.ticker,
    name: f.name ?? null,
    addedAt: f.createdAt,
    pinned: !!f.pinned,
    starred: !!f.starred,
  };
}

/**
 * 客户端排序：重点关注 > 置顶 > 添加时间倒序
 * 与 lib/db/favorites.ts 中 sortFavorites 保持一致，
 * 用于乐观更新（togglePin/toggleStar/remove）后立即重排。
 */
function sortFavoritesClient(list: FavoriteItem[]): FavoriteItem[] {
  return [...list].sort((a, b) => {
    if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.addedAt - a.addedAt;
  });
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
  dataSource?: string;
  warnings?: string[];
  strategyIdsUsed?: string[];
  currentPrice?: number | null;
  targetMeanPrice?: number | null;
  targetHighPrice?: number | null;
  targetLowPrice?: number | null;
  targetMedianPrice?: number | null;
  targetUpside?: number | null;
  numberOfAnalysts?: number | null;
  recommendationMean?: number | null;
  news?: Array<{
    title: string;
    source?: string;
    date?: string;
    summary?: string;
    url?: string;
  }>;
  industryRank?: {
    pePercentile: number | null;
    roePercentile: number | null;
    revenueGrowthPercentile: number | null;
    peerCount: number;
  } | null;
  industry?: string | null;
  sector?: string | null;
  technicalSignals?: TechnicalSignals | null;
}

// TradingView 技术信号
type Signal = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

interface TechnicalSignals {
  oscillators: Signal;
  movingAverages: Signal;
  overall: Signal;
}

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

// 后端 TechnicalSignalSnapshot 行（与 /api/technical-snapshots 返回的字段一致）
interface TechnicalSnapshotRow {
  ticker: string;
  tickerName: string | null;
  oscillators: Signal;
  movingAverages: Signal;
  overall: Signal;
  /** A 股筹码状态描述（来自同花顺 chip_situation.desc），美股为 null */
  chipSituation: string | null;
  price: number | null;
  fetchedAt: number;
  updatedAt: number;
}

/** 轻量行情（来自 /api/quote，美股 Yahoo / A股 东方财富） */
interface Quote {
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  name?: string | null;
  market: "US" | "CN" | "HK" | "UNKNOWN";
  ok: boolean;
}

// 24h 之内的 snapshot 视为「新鲜」不需要重新拉取
const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

// 行情展示：中国习惯 涨=红 跌=绿
function quoteColorClass(q: Quote | undefined): string {
  if (!q || q.changePercent == null) return "text-zinc-400";
  return q.changePercent >= 0 ? "text-red-400" : "text-green-400";
}
function formatQuotePrice(q: Quote | undefined): string {
  if (!q || q.price == null) return "—";
  const sym = q.currency === "CNY" ? "¥" : "$";
  return `${sym}${q.price.toFixed(2)}`;
}
function formatQuoteChange(q: Quote | undefined): string {
  if (!q || q.changePercent == null) return "";
  const sign = q.changePercent >= 0 ? "+" : "";
  return `${sign}${q.changePercent.toFixed(2)}%`;
}
/** 行情迷你展示（价格 + 涨跌幅），无数据时返回 null */
function QuoteMini({ q }: { q?: Quote }) {
  if (!q || !q.ok || q.price == null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="font-mono text-zinc-200">{formatQuotePrice(q)}</span>
      <span className={`font-mono ${quoteColorClass(q)}`}>
        {formatQuoteChange(q)}
      </span>
    </span>
  );
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
  quote,
}: {
  ticker: Ticker;
  maxCount: number;
  subreddit: string;
  isFavorite: boolean;
  onToggleFavorite: (ticker: Ticker) => void;
  quote?: Quote;
}) {
  const pct = maxCount > 0 ? (ticker.countPast24h / maxCount) * 100 : 0;
  const t = ticker.ticker;
  const redditUrl = `https://www.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(t)}&sort=relevance&t=week`;
  return (
    <div className="group relative flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left transition-all hover:border-orange-500/50 hover:bg-zinc-900">
      <RankBadge rank={ticker.rank} />
      <div className="flex-1 min-w-0 pr-8">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-white tracking-wide">
              {ticker.ticker}
            </span>
            {ticker.name && (
              <span className="text-xs text-zinc-400">{ticker.name}</span>
            )}
            <QuoteMini q={quote} />
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
          <div className="flex items-center gap-2 opacity-60 transition-opacity group-hover:opacity-100">
            <a
              href={redditUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-orange-400/70 hover:text-orange-400"
            >
              Reddit
            </a>
            <span className="text-zinc-700">·</span>
            <a
              href={futuUrl(t)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-orange-400/70 hover:text-orange-400"
            >
              富途
            </a>
            <span className="text-zinc-700">·</span>
            <a
              href={tradingViewUrl(t)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-orange-400/70 hover:text-orange-400"
            >
              TradingView
            </a>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleFavorite(ticker);
        }}
        className={`absolute top-2 right-2 rounded-md p-1.5 transition-all ${
          isFavorite
            ? "text-yellow-400 hover:text-yellow-300"
            : "text-zinc-500 opacity-60 hover:text-yellow-400 hover:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        }`}
        title={isFavorite ? "移除收藏" : "加入收藏"}
        aria-label={isFavorite ? "移除收藏" : "加入收藏"}
      >
        <StarIcon filled={isFavorite} className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * 综合技术信号徽章
 * - 美股 / A 股：显示 TradingView 周线综合信号（hover 展开 振荡 / 均线 明细）
 * - A 股：额外显示同花顺筹码状态 chip（密集→红，分散→绿）
 * - 无 snapshot：显示「加载中」（同时触发懒刷新）
 */
function SignalBadge({
  snapshot,
  isUS,
}: {
  snapshot?: TechnicalSnapshotRow;
  isUS: boolean;
}) {
  // Hooks 必须无条件在最前调用，避免 rules-of-hooks 违规
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!snapshot) return;
    // 每 60s 刷新"X 分钟前"。初始值由 useState 提供，无需 effect 同步 setState
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [snapshot]);

  if (!snapshot) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-500 animate-pulse">
        加载信号…
      </span>
    );
  }

  const sig = snapshot.overall;
  const minutesAgo = Math.max(0, Math.floor((now - snapshot.fetchedAt) / 60000));
  const timeLabel =
    minutesAgo < 1
      ? "刚刚"
      : minutesAgo < 60
        ? `${minutesAgo} 分钟前`
        : minutesAgo < 60 * 24
          ? `${Math.floor(minutesAgo / 60)} 小时前`
          : `${Math.floor(minutesAgo / 60 / 24)} 天前`;

  const bgClass =
    sig === "strong_buy" || sig === "buy"
      ? "bg-green-500/10 text-green-400"
      : sig === "strong_sell" || sig === "sell"
        ? "bg-red-500/10 text-red-400"
        : "bg-zinc-500/15 text-zinc-400";

  // 技术信号徽章（美股 / A 股通用）
  const techBadge = (
    <span
      className={`group/sig relative inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${bgClass}`}
      title={SIGNAL_LABELS[sig]}
    >
      <span aria-hidden>●</span>
      <span>综合 {SIGNAL_LABELS[sig]}</span>
      {/* hover 展开详细 */}
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-52 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-[10px] text-zinc-300 shadow-xl group-hover/sig:block">
        <div className="flex items-center justify-between">
          <span className="text-zinc-500">综合</span>
          <span className={SIGNAL_COLORS[sig]}>{SIGNAL_LABELS[sig]}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-zinc-500">振荡</span>
          <span className={SIGNAL_COLORS[snapshot.oscillators]}>
            {SIGNAL_LABELS[snapshot.oscillators]}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-zinc-500">均线</span>
          <span className={SIGNAL_COLORS[snapshot.movingAverages]}>
            {SIGNAL_LABELS[snapshot.movingAverages]}
          </span>
        </div>
        <div className="mt-1.5 border-t border-zinc-800 pt-1 text-[9px] text-zinc-600">
          {timeLabel}更新 · TradingView 周线
        </div>
      </span>
    </span>
  );

  // A 股：额外显示同花顺筹码状态 chip
  if (!isUS) {
    const chip = snapshot.chipSituation;
    if (!chip) return techBadge; // 无筹码数据时只显示技术信号

    // 从纯文本提取关键词（后端已去 HTML 标签）
    // 格式示例："当前个股近120天的平均成本为54.45元…筹码状态高度密集…可继续关注。"
    const keywordMatch = chip.match(/筹码状态[，,\s]*([^\s，,。.]+)/);
    const keyword = keywordMatch?.[1]?.trim() || chip.trim().slice(0, 8);
    // 筹码密集 → 红（A股涨色），分散 → 绿（A股跌色）
    const isDense = /密集|集中|锁仓/.test(keyword);
    const isLoose = /分散|发散|松动/.test(keyword);
    const chipColorClass = isDense
      ? "bg-red-500/10 text-red-400"
      : isLoose
        ? "bg-green-500/10 text-green-400"
        : "bg-zinc-500/15 text-zinc-400";
    const chipDotColor = isDense ? "text-red-400" : isLoose ? "text-green-400" : "text-zinc-400";

    const chipBadge = (
      <span
        className={`group/chip relative inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${chipColorClass}`}
        title="筹码状态"
      >
        <span aria-hidden className={chipDotColor}>◆</span>
        <span>筹码 {keyword}</span>
        {/* hover 展开完整描述 */}
        <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-52 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-[10px] text-zinc-300 shadow-xl group-hover/chip:block">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">筹码状态</span>
            <span className={chipDotColor}>{keyword}</span>
          </div>
          <div className="mt-1 text-[9px] text-zinc-400 leading-relaxed">
            {chip}
          </div>
          <div className="mt-1.5 border-t border-zinc-800 pt-1 text-[9px] text-zinc-600">
            {timeLabel}更新 · 同花顺
          </div>
        </span>
      </span>
    );

    return (
      <>
        {techBadge}
        {chipBadge}
      </>
    );
  }

  return techBadge;
}

function FavoriteCard({
  item,
  onRemove,
  onAnalyze,
  onTogglePin,
  onToggleStar,
  signalSnapshot,
  onRequestRefreshSnapshot,
  quote,
}: {
  item: FavoriteItem;
  onRemove: (ticker: string) => void;
  onAnalyze: (item: FavoriteItem) => void;
  onTogglePin: (ticker: string, pinned: boolean) => void;
  onToggleStar: (ticker: string, starred: boolean) => void;
  signalSnapshot?: TechnicalSnapshotRow;
  onRequestRefreshSnapshot?: (ticker: string) => void;
  quote?: Quote;
}) {
  // A 股标题跳百度股市通，美股跳 Reddit 搜索
  const redditUrl = isCNTicker(item.ticker)
    ? baiduStockUrl(item.ticker)
    : `https://www.reddit.com/search?q=${encodeURIComponent(item.ticker)}&sort=relevance&t=week`;
  const isPinned = !!item.pinned;
  const isStarred = !!item.starred;
  const isUS = !isCNTicker(item.ticker);

  // A 股图解 URL：卡片挂载时自动获取
  const [visualUrl, setVisualUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isCNTicker(item.ticker)) return;
    let cancelled = false;
    fetch(`/api/ths-visual?ticker=${encodeURIComponent(item.ticker)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d.url) setVisualUrl(d.url);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item.ticker]);

  // 美股 + A 股：snapshot 缺失或 > 24h 时触发懒刷新
  // 美股刷新 TradingView 技术信号，A 股刷新同花顺筹码状态
  useEffect(() => {
    if (!onRequestRefreshSnapshot) return;
    const stale =
      !signalSnapshot || Date.now() - signalSnapshot.fetchedAt > SNAPSHOT_STALE_MS;
    if (stale) {
      onRequestRefreshSnapshot(item.ticker);
    }
  }, [signalSnapshot, onRequestRefreshSnapshot, item.ticker]);

  return (
    <div
      className={`group relative flex w-full flex-col gap-3 rounded-xl border p-4 text-left transition-all hover:bg-zinc-900 md:items-stretch ${
        isPinned
          ? "border-orange-500/60 bg-orange-500/5 shadow-[0_0_0_1px_rgba(249,115,22,0.15)]"
          : isStarred
          ? "border-yellow-500/40 bg-yellow-500/5"
          : "border-zinc-800 bg-zinc-900/60 hover:border-orange-500/50"
      }`}
    >
      {/* 上半部分：星标 + 股票信息 */}
      <div className="flex items-start gap-3 min-w-0">
        <button
          type="button"
          onClick={() => onToggleStar(item.ticker, !isStarred)}
          className={`inline-flex shrink-0 items-center justify-center w-9 h-9 rounded-full text-sm font-bold transition-all ${
            isStarred
              ? "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
              : "bg-zinc-800 text-zinc-500 hover:text-yellow-400"
          }`}
          title={isStarred ? "取消重点关注" : "设为重点关注"}
        >
          <StarIcon filled={isStarred} className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <a
            href={redditUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block focus:outline-none"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-bold text-white tracking-wide">
                {item.ticker}
              </span>
              {isCNTicker(item.ticker) && (
                <span className="inline-flex items-center rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                  A股
                </span>
              )}
              {isPinned && (
                <span className="inline-flex items-center rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">
                  置顶
                </span>
              )}
              {isStarred && (
                <span className="inline-flex items-center rounded bg-yellow-500/20 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                  重点关注
                </span>
              )}
              <SignalBadge snapshot={signalSnapshot} isUS={isUS} />
            </div>
              {item.name && (
                <div className="mt-0.5 text-sm text-zinc-400 truncate">{item.name}</div>
              )}
              {quote?.ok && quote.price != null && (
                <div className="mt-0.5">
                  <QuoteMini q={quote} />
                </div>
              )}
              <div className="mt-1 text-xs text-zinc-500">
                收藏于 {new Date(item.addedAt).toLocaleDateString("zh-CN")}
              </div>
          </a>
        </div>
      </div>

      {/* 下半部分：操作按钮 */}
      <div className="flex flex-wrap gap-1.5">
        {isCNTicker(item.ticker) ? (
          <>
            <a
              href={thsDiagnosisUrl(item.ticker)}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
              title="在同花顺查看财务诊断"
            >
              诊断
            </a>
            <a
              href={visualUrl || "#"}
              target={visualUrl ? "_blank" : undefined}
              rel={visualUrl ? "noopener noreferrer" : undefined}
              className={`shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs transition-all ${visualUrl ? "text-zinc-300 hover:border-orange-500/50 hover:text-orange-400" : "text-zinc-600 cursor-not-allowed"}`}
              title={visualUrl ? "在同花顺查看财务图解" : "加载中..."}
            >
              图解
            </a>
          </>
        ) : (
          <>
            <a
              href={futuUrl(item.ticker)}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
              title="在富途牛牛查看"
            >
              富途
            </a>
            <a
              href={tradingViewUrl(item.ticker)}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
              title="在 TradingView 查看"
            >
              TradingView
            </a>
          </>
        )}
        <button
          type="button"
          onClick={() => onTogglePin(item.ticker, !isPinned)}
          className={`shrink-0 rounded-md border px-3 py-1.5 text-xs transition-all ${
            isPinned
              ? "border-orange-500/50 text-orange-400 hover:bg-orange-500/10"
              : "border-zinc-700 text-zinc-400 hover:border-orange-500/50 hover:text-orange-400"
          }`}
          title={isPinned ? "取消置顶" : "置顶"}
        >
          {isPinned ? "取消置顶" : "置顶"}
        </button>
        <button
          type="button"
          onClick={() => onAnalyze(item)}
          className="shrink-0 rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-xs font-medium text-orange-400 transition-all hover:bg-orange-500/20"
          title="调用大模型分析（5项指标）"
        >
          分析
        </button>
        <button
          type="button"
          onClick={() => onRemove(item.ticker)}
          className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-all hover:border-red-500/50 hover:text-red-400"
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
  signalSnapshot,
  onSnapshotUpdated,
  onClose,
}: {
  item: FavoriteItem;
  /**
   * 父组件持有的最新 snapshot（与 Card 徽章同源）。
   * 优先用这个显示，避免 modal 和 Card 数据源不同导致不一致。
   */
  signalSnapshot?: TechnicalSnapshotRow;
  /** 强制刷新后，API 返回了 latestSnapshot，父组件可同步更新 Card */
  onSnapshotUpdated?: (snapshot: TechnicalSnapshotRow) => void;
  onClose: () => void;
}) {
  const [analysis, setAnalysis] = useState<StockAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "metrics" | "ai">("overview");
  const fetchCounterRef = useRef(0);
  const analysisRef = useRef<StockAnalysis | null>(null);

  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  const fetchAnalysis = useCallback(async (force = false) => {
    const myId = ++fetchCounterRef.current;
    const isRefresh = force && analysisRef.current != null;

    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
      setAnalysis(null);
    }
    setError(null);

    try {
      const url = `/api/analyze?ticker=${encodeURIComponent(item.ticker)}${force ? "&force=true" : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      // force=true 时响应里会带 latestSnapshot（与 Card 徽章同源），用于同步父组件
      const json: StockAnalysis & { latestSnapshot?: TechnicalSnapshotRow | null } = await res.json();
      if (myId === fetchCounterRef.current) {
        setAnalysis(json);
        if (force && json.latestSnapshot && onSnapshotUpdated) {
          onSnapshotUpdated(json.latestSnapshot);
        }
      }
    } catch (err) {
      if (myId === fetchCounterRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (myId === fetchCounterRef.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [item.ticker, onSnapshotUpdated]);

  useEffect(() => {
    fetchAnalysis(false);
  }, [item.ticker]);

  const handleReanalyze = () => {
    if (isRefreshing || loading) return;
    setActiveTab("ai");
    fetchAnalysis(true);
  };

  const handleShare = () => {
    if (!analysis) return;

    // 根据 Tab 生成不同分享文案
    let text = "";
    if (activeTab === "overview") {
      const lines: string[] = [`📊 $${item.ticker} 股票概览`];
      lines.push("");

      // 价格与目标价区间
      if (analysis.currentPrice != null) {
        lines.push(`当前价：$${analysis.currentPrice.toFixed(2)}`);
      }
      if (analysis.targetLowPrice != null && analysis.targetHighPrice != null) {
        lines.push(`目标价区间：$${analysis.targetLowPrice.toFixed(2)} - $${analysis.targetHighPrice.toFixed(2)}`);
      } else if (analysis.targetMeanPrice != null) {
        lines.push(`目标均价：$${analysis.targetMeanPrice.toFixed(2)}`);
      }
      if (analysis.targetUpside != null) {
        const pct = (analysis.targetUpside * 100).toFixed(1);
        lines.push(`上涨空间：${analysis.targetUpside >= 0 ? "+" : ""}${pct}%`);
      }

      // 综合技术信号（与 Card 同源 snapshot 优先）
      const sigOverall = signalSnapshot?.overall ?? analysis.technicalSignals?.overall;
      if (sigOverall) {
        lines.push(`综合技术信号：${SIGNAL_LABELS[sigOverall]}`);
      }

      // 末尾点评：综合上涨空间与技术信号给出一句结论（与 Card 同源 snapshot 优先）
      lines.push("");
      const upside = analysis.targetUpside;
      const sig = signalSnapshot?.overall ?? analysis.technicalSignals?.overall;
      let comment = "";
      if (upside != null && sig) {
        const bullish = upside > 0.1 && (sig === "buy" || sig === "strong_buy");
        const bearish = upside < -0.1 && (sig === "sell" || sig === "strong_sell");
        if (bullish) {
          comment = "分析师看多且技术信号偏多，短期偏强";
        } else if (bearish) {
          comment = "分析师看空且技术信号偏空，短期偏弱";
        } else if (upside > 0.1) {
          comment = "目标价有上行空间，但技术信号未共振，注意分歧";
        } else if (upside < -0.1) {
          comment = "目标价低于现价，技术信号偏弱，谨慎对待";
        } else {
          comment = "多空信号交织，建议观望等待方向";
        }
      } else if (upside != null) {
        comment = upside > 0.1 ? "目标价有上行空间" : upside < -0.1 ? "目标价低于现价" : "目标价与现价接近";
      } else if (sig) {
        comment = sig === "buy" || sig === "strong_buy" ? "技术信号偏多" : sig === "sell" || sig === "strong_sell" ? "技术信号偏空" : "技术信号中性";
      }
      if (comment) lines.push(`💡 ${comment}`);

      text = lines.join("\n");
    } else if (activeTab === "metrics") {
      const passCount = analysis.metrics.filter((m) => m.verdict === "pass").length;
      const failCount = analysis.metrics.filter((m) => m.verdict === "fail").length;
      const lines: string[] = [`📈 $${item.ticker} 财务指标详解`];
      lines.push("");

      // 列出每项指标的标题、数值和判定
      for (const m of analysis.metrics) {
        const mark = m.verdict === "pass" ? "✅" : m.verdict === "fail" ? "❌" : "—";
        lines.push(`${mark} ${m.title}：${m.value}`);
      }

      lines.push("");
      // 末尾点评
      let comment = "";
      if (analysis.metrics.length === 0) {
        comment = "暂无指标数据";
      } else if (failCount === 0) {
        comment = "各项指标全部通过，基本面稳健";
      } else if (passCount === 0) {
        comment = "各项指标均未通过，基本面偏弱";
      } else if (passCount > failCount) {
        comment = `${passCount} 项通过 ${failCount} 项未通过，基本面整体偏多`;
      } else {
        comment = `${passCount} 项通过 ${failCount} 项未通过，基本面存在分歧`;
      }
      lines.push(`💡 ${comment}`);

      text = lines.join("\n");
    } else {
      const lines: string[] = [`🤖 $${item.ticker} AI 分析点评`];
      if (analysis.llmProvider) {
        lines.push(`（${analysis.llmProvider}）`);
      }
      lines.push("");

      // 从 LLM 叙述中提取首段作为摘要
      if (analysis.llmNarrative) {
        // 去掉 Markdown 标记，取第一段非空文本
        const plain = analysis.llmNarrative
          .replace(/^#+\s*/gm, "")
          .replace(/[*_`>]/g, "")
          .trim();
        const firstPara = plain.split(/\n\n+/).find((p) => p.trim().length > 0);
        if (firstPara) {
          // X 推文限制，截断到 180 字符
          const summary = firstPara.length > 180 ? firstPara.slice(0, 177) + "..." : firstPara;
          lines.push(summary);
        }
      } else if (analysis.llmError) {
        lines.push("（AI 分析生成失败）");
      } else {
        lines.push("（暂无 AI 分析）");
      }

      text = lines.join("\n");
    }
    const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(xUrl, "_blank");
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
            {!loading && (
              <button
                type="button"
                onClick={handleReanalyze}
                disabled={isRefreshing}
                className="shrink-0 rounded-lg border border-orange-500/40 bg-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 transition-all hover:bg-orange-500/30 disabled:opacity-60 disabled:cursor-not-allowed"
                title={analysis?.llmNarrative ? "重新调用大模型生成 AI 分析（财务数据已自动刷新）" : "调用大模型生成 AI 分析"}
              >
                <span className="flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  {isRefreshing
                    ? "生成中..."
                    : analysis?.llmNarrative
                      ? "重新生成 AI 分析"
                      : "生成 AI 分析"}
                </span>
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            基于当前启用的策略分析
            {analysis && !loading && !isRefreshing && (
              <span className="ml-2 text-zinc-600">
                （共 {analysis.metrics.length} 项指标）
              </span>
            )}
            {isRefreshing && (
              <span className="ml-2 inline-flex items-center gap-1 text-orange-400">
                <svg viewBox="0 0 24 24" className="h-3 w-3 animate-spin" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                正在重新生成 AI 分析...
              </span>
            )}
            {!isRefreshing && analysis?.llmProvider && (
              <span className="ml-2 inline-flex items-center rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-300">
                🤖 {analysis.llmProvider}
              </span>
            )}
          </p>
        </div>

        {loading && (
          <div className="space-y-3 py-8">
            <div className="text-center text-sm text-zinc-400">
              正在加载分析数据...
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

        {!loading && !error && !analysis && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-6 text-center">
            <p className="text-sm text-zinc-400">
              暂无分析数据
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              点击右上角「生成 AI 分析」获取该股票的分析报告
            </p>
          </div>
        )}

        {analysis && !loading && (
          <div className="space-y-4">
            {/* Tab 导航 */}
            <div className="flex gap-1 border-b border-zinc-800">
              {([
                { key: "overview", label: "概览" },
                { key: "metrics", label: `指标详解${analysis.metrics.length ? ` (${analysis.metrics.length})` : ""}` },
                { key: "ai", label: "AI 点评" },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`relative px-3 py-2 text-xs font-medium transition-colors ${
                    activeTab === tab.key
                      ? "text-orange-400"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tab.label}
                  {tab.key === "ai" && analysis.llmError && (
                    <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-yellow-500" />
                  )}
                  {activeTab === tab.key && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-400" />
                  )}
                </button>
              ))}
            </div>

            {/* ==================== 概览 Tab ==================== */}
            {activeTab === "overview" && (
              <div className="space-y-4">
            {/* 总判定 */}
            <div className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800/40 p-3">
              <VerdictBadge verdict={analysis.overallVerdict} />
              <div className="text-sm text-zinc-300">
                {analysis.overallSummary}
              </div>
            </div>

            {/* 分析师目标价统计 */}
            {(analysis.targetMeanPrice != null || analysis.currentPrice != null || analysis.recommendationMean != null) && (
              <div className="rounded-xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/5 to-transparent p-4">
                {/* 标题行 */}
                <div className="mb-3 flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-cyan-400" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                  </svg>
                  <span className="text-xs font-medium text-cyan-400">分析师目标价</span>
                  {analysis.numberOfAnalysts != null && (
                    <span className="text-[10px] text-zinc-500">· {analysis.numberOfAnalysts} 位分析师</span>
                  )}
                </div>

                {/* 上涨空间 + 价格路径 */}
                {analysis.targetUpside != null && (
                  <div className="mb-3 flex items-center gap-3 rounded-lg bg-zinc-800/40 px-3 py-2">
                    <div>
                      <div className="text-[10px] text-zinc-500">上涨空间</div>
                      <div className={`text-2xl font-mono font-bold ${analysis.targetUpside >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {analysis.targetUpside >= 0 ? "+" : ""}{(analysis.targetUpside * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div className="ml-auto text-right text-xs">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-[10px] text-zinc-500">当前</span>
                        <span className="font-mono text-zinc-300">{analysis.currentPrice != null ? `$${analysis.currentPrice.toFixed(2)}` : "—"}</span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-end gap-1.5">
                        <span className="text-[10px] text-zinc-500">目标</span>
                        <span className="font-mono font-medium text-cyan-400">{analysis.targetMeanPrice != null ? `$${analysis.targetMeanPrice.toFixed(2)}` : "—"}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* 价格网格 */}
                <div className="grid grid-cols-4 gap-2">
                  <div className="rounded bg-zinc-800/40 p-2 text-center">
                    <div className="text-[10px] text-zinc-500">低位</div>
                    <div className="mt-0.5 text-xs font-mono font-semibold text-red-400">
                      {analysis.targetLowPrice != null ? `$${analysis.targetLowPrice.toFixed(2)}` : "—"}
                    </div>
                  </div>
                  <div className="rounded bg-zinc-800/40 p-2 text-center">
                    <div className="text-[10px] text-zinc-500">中位</div>
                    <div className="mt-0.5 text-xs font-mono text-zinc-300">
                      {analysis.targetMedianPrice != null ? `$${analysis.targetMedianPrice.toFixed(2)}` : "—"}
                    </div>
                  </div>
                  <div className="rounded bg-zinc-800/40 p-2 text-center">
                    <div className="text-[10px] text-zinc-500">高位</div>
                    <div className="mt-0.5 text-xs font-mono font-semibold text-green-400">
                      {analysis.targetHighPrice != null ? `$${analysis.targetHighPrice.toFixed(2)}` : "—"}
                    </div>
                  </div>
                  <div className="rounded bg-zinc-800/40 p-2 text-center">
                    <div className="text-[10px] text-zinc-500">评级</div>
                    <div className="mt-0.5">
                      {analysis.recommendationMean != null ? (
                        <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${
                          analysis.recommendationMean <= 1.5 ? "bg-green-500/20 text-green-400" :
                          analysis.recommendationMean <= 2.5 ? "bg-lime-500/20 text-lime-400" :
                          analysis.recommendationMean <= 3.5 ? "bg-yellow-500/20 text-yellow-400" :
                          analysis.recommendationMean <= 4.5 ? "bg-orange-500/20 text-orange-400" :
                          "bg-red-500/20 text-red-400"
                        }`}>
                          {analysis.recommendationMean <= 1.5 ? "强买" :
                           analysis.recommendationMean <= 2.5 ? "买入" :
                           analysis.recommendationMean <= 3.5 ? "持有" :
                           analysis.recommendationMean <= 4.5 ? "卖出" : "强卖"}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* 价格区间条形 */}
                {analysis.targetLowPrice != null && analysis.targetHighPrice != null && analysis.currentPrice != null && analysis.targetHighPrice > analysis.targetLowPrice && (
                  <div className="mt-3">
                    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                      <div className="absolute inset-y-0 left-0 right-0 bg-gradient-to-r from-red-500/30 via-yellow-500/30 to-green-500/30" />
                      <div
                        className="absolute top-0 h-full w-1 -translate-x-1/2 rounded-full bg-white shadow"
                        style={{
                          left: `${Math.max(0, Math.min(100,
                            ((analysis.currentPrice - analysis.targetLowPrice) / (analysis.targetHighPrice - analysis.targetLowPrice)) * 100
                          ))}%`
                        }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
                      <span>${analysis.targetLowPrice.toFixed(2)}</span>
                      <span>${analysis.targetHighPrice.toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 同行业对比 */}
            {analysis.industryRank && (
              <div className="rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-transparent p-4">
                <div className="mb-3 flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-purple-400" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                  <span className="text-xs font-medium text-purple-400">同行业对比</span>
                  <span className="text-[10px] text-zinc-500">
                    · {analysis.industry || analysis.sector || "所属行业"} · {analysis.industryRank.peerCount} 家公司
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {[
                    {
                      label: "PE 估值",
                      value: analysis.industryRank.pePercentile,
                      desc: "越低越好 → 百分位越高越优",
                    },
                    {
                      label: "ROE",
                      value: analysis.industryRank.roePercentile,
                      desc: "越高越好 → 百分位越高越优",
                    },
                    {
                      label: "营收增长",
                      value: analysis.industryRank.revenueGrowthPercentile,
                      desc: "越高越好 → 百分位越高越优",
                    },
                  ].map((item) => (
                    <div key={item.label} className="rounded-lg bg-zinc-900/50 p-3">
                      <div className="text-[10px] text-zinc-500">{item.label}</div>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span
                          className={`text-xl font-mono font-bold ${
                            item.value == null
                              ? "text-zinc-600"
                              : item.value >= 70
                                ? "text-green-400"
                                : item.value >= 40
                                  ? "text-yellow-400"
                                  : "text-red-400"
                          }`}
                        >
                          {item.value != null ? `${item.value}` : "—"}
                        </span>
                        <span className="text-[10px] text-zinc-500">
                          {item.value != null ? "百分位" : ""}
                        </span>
                      </div>
                      {/* 进度条 */}
                      {item.value != null && (
                        <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              item.value >= 70
                                ? "bg-green-500"
                                : item.value >= 40
                                  ? "bg-yellow-500"
                                  : "bg-red-500"
                            }`}
                            style={{ width: `${item.value}%` }}
                          />
                        </div>
                      )}
                      <div className="mt-1.5 text-[10px] text-zinc-600">{item.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TradingView 技术信号（仅美股）——概览 Tab 内部
               * 优先用父组件传来的最新 snapshot（与 Card 徽章同源），保证两边一致；
               * snapshot 缺失时回退到 analysis.technicalSignals（AnalysisCache 旧值）。 */}
            {(signalSnapshot || analysis.technicalSignals) && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-cyan-400" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                  </svg>
                  <span className="text-sm font-medium text-cyan-300">技术信号</span>
                  <span className="text-[10px] text-zinc-500">TradingView</span>
                  {signalSnapshot?.fetchedAt && (
                    <span className="ml-auto text-[10px] text-zinc-500">
                      {new Date(signalSnapshot.fetchedAt).toLocaleString("zh-CN", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      更新
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {(() => {
                    // 数据源优先级：snapshot（最新，与 Card 同源）> analysis.technicalSignals
                    const sigSource = signalSnapshot
                      ? {
                          overall: signalSnapshot.overall,
                          oscillators: signalSnapshot.oscillators,
                          movingAverages: signalSnapshot.movingAverages,
                        }
                      : analysis.technicalSignals!;
                    return [
                      { label: "综合", signal: sigSource.overall },
                      { label: "振荡指标", signal: sigSource.oscillators },
                      { label: "移动均线", signal: sigSource.movingAverages },
                    ].map(({ label, signal }) => (
                      <div key={label} className="flex flex-col items-center gap-1 rounded-md bg-zinc-800/50 p-2">
                        <span className="text-[10px] text-zinc-500">{label}</span>
                        <span className={`text-xs font-medium ${SIGNAL_COLORS[signal]}`}>
                          ● {SIGNAL_LABELS[signal]}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}
              </div>
            )}

            {/* ==================== 指标详解 Tab ==================== */}
            {activeTab === "metrics" && (
              <div className="space-y-2">
                {analysis.metrics.length > 0 ? (
                  analysis.metrics.map((m) => (
                    <div
                      key={m.key}
                      className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5"
                    >
                      {/* 第一行：标题 + 徽章 | 数值 */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-zinc-100">
                            {m.title}
                          </span>
                          <VerdictBadge verdict={m.verdict} />
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <span className="whitespace-pre-line text-sm font-mono font-semibold text-orange-400">
                            {m.value}
                          </span>
                        </div>
                      </div>
                      {/* 第二行：阈值 */}
                      <div className="mt-1 text-[10px] text-zinc-600">
                        阈值 {m.threshold}
                      </div>
                      {/* 第三行：描述 */}
                      <p className="mt-1.5 text-xs text-zinc-500">{m.description}</p>
                      {/* 第四行：分析结论（带分隔线） */}
                      <p className="mt-2 border-t border-zinc-800/60 pt-2 text-xs text-zinc-400 leading-relaxed">{m.reasoning}</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-6 text-center">
                    <p className="text-sm text-zinc-400">暂无指标数据</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      请点击右上角「重新生成 AI 分析」获取最新指标
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ==================== AI 点评 Tab ==================== */}
            {activeTab === "ai" && (
              <div className="space-y-3">
            {/* LLM 叙述（完整内容：公司概览/指标判定/消息面分析/行业前景/总评） */}
            {(analysis.llmNarrative || (isRefreshing && analysis)) && (
              <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className={`h-4 w-4 text-orange-400 ${isRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                  </svg>
                  <span className="text-xs font-medium text-orange-400">
                    大模型点评
                  </span>
                  {isRefreshing ? (
                    <span className="text-[10px] text-zinc-500">
                      · 正在重新生成...
                    </span>
                  ) : analysis.llmProvider ? (
                    <span className="text-[10px] text-zinc-500">
                      · {analysis.llmProvider}
                    </span>
                  ) : null}
                </div>
                {analysis.llmNarrative ? (
                  <div className={`llm-narrative text-sm leading-relaxed text-zinc-200 ${isRefreshing ? "opacity-50" : ""}`}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => (
                        <h1 className="mt-4 mb-2 text-lg font-bold text-orange-300">{children}</h1>
                      ),
                      h2: ({ children }) => (
                        <h2 className="mt-4 mb-2 text-base font-bold text-orange-300">{children}</h2>
                      ),
                      h3: ({ children }) => (
                        <h3 className="mt-3 mb-1.5 text-sm font-bold text-zinc-100">{children}</h3>
                      ),
                      h4: ({ children }) => (
                        <h4 className="mt-3 mb-1 text-sm font-semibold text-zinc-100">{children}</h4>
                      ),
                      p: ({ children }) => (
                        <p className="my-2 text-zinc-200">{children}</p>
                      ),
                      ul: ({ children }) => (
                        <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>
                      ),
                      li: ({ children }) => <li className="text-zinc-200">{children}</li>,
                      strong: ({ children }) => (
                        <strong className="font-semibold text-zinc-50">{children}</strong>
                      ),
                      em: ({ children }) => <em className="text-zinc-300">{children}</em>,
                      blockquote: ({ children }) => (
                        <blockquote className="my-2 border-l-2 border-orange-500/40 pl-3 text-zinc-300 italic">
                          {children}
                        </blockquote>
                      ),
                      code: ({ children, className }) => {
                        const isInline = !className;
                        return isInline ? (
                          <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-orange-300">
                            {children}
                          </code>
                        ) : (
                          <code className="block rounded bg-zinc-900 p-3 text-xs text-zinc-300 overflow-x-auto">
                            {children}
                          </code>
                        );
                      },
                      pre: ({ children }) => <pre className="my-2">{children}</pre>,
                      table: ({ children }) => (
                        <div className="my-3 overflow-x-auto">
                          <table className="w-full border-collapse text-xs">{children}</table>
                        </div>
                      ),
                      thead: ({ children }) => (
                        <thead className="bg-zinc-800/60">{children}</thead>
                      ),
                      th: ({ children }) => (
                        <th className="border border-zinc-700 px-2 py-1 text-left font-semibold text-zinc-100">
                          {children}
                        </th>
                      ),
                      td: ({ children }) => (
                        <td className="border border-zinc-700 px-2 py-1 text-zinc-300">{children}</td>
                      ),
                      hr: () => <hr className="my-3 border-zinc-700/60" />,
                      a: ({ children, href }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-orange-400 underline hover:text-orange-300"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {analysis.llmNarrative}
                  </ReactMarkdown>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 py-4 text-sm text-zinc-400">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                    </svg>
                    正在调用大模型生成分析，请稍候...
                  </div>
                )}
              </div>
            )}

            {/* AI 点评空状态：无叙述、无错误、非刷新中 */}
            {!analysis.llmNarrative && !analysis.llmError && !isRefreshing && (
              <div className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-6 text-center">
                <p className="text-sm text-zinc-400">暂无 AI 分析</p>
                <p className="mt-1 text-xs text-zinc-500">
                  点击右上角「生成 AI 分析」获取大模型点评
                </p>
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
                {/* 限流 / 冷却类错误：建议换主用 provider 或等待 */}
                {/限流|冷却|429|rate.?limit/i.test(analysis.llmError) && (
                  <div className="mt-1 text-[11px] text-zinc-600">
                    免费层配额耗尽或限流中。建议在 ⚙ 设置中配置 Gemini 2.5 Flash 或 Groq 免费 Key 作为主用，或等待 5 分钟自动恢复后重试。
                  </div>
                )}
                {/* 仅在确实缺 Key / 配置问题时才提示去设置 */}
                {/未配置 API Key|未配置.*Key/i.test(analysis.llmError) &&
                  !/限流|冷却|429/i.test(analysis.llmError) && (
                    <div className="mt-1 text-[11px] text-zinc-600">
                      请在右上角 ⚙ 设置中配置 LLM API Key（如 Groq 免费层）。
                    </div>
                  )}
                {/* 超时类错误：建议换更快的模型或重试 */}
                {/超时|timeout/i.test(analysis.llmError) &&
                  !/限流|冷却|429/i.test(analysis.llmError) && (
                    <div className="mt-1 text-[11px] text-zinc-600">
                      当前模型响应过慢，可在 ⚙ 设置中切换更快的模型（如 Gemini 2.5 Flash / Groq），或稍后重试。
                    </div>
                  )}
              </div>
            )}
              </div>
            )}

            {/* 数据来源 & 警告——Tab 外部，始终显示 */}
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

            <div className="text-right text-[10px] text-zinc-600">
              {isRefreshing ? (
                <span className="inline-flex items-center gap-1 text-orange-400">
                  <svg viewBox="0 0 24 24" className="h-3 w-3 animate-spin" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  AI 分析更新中...
                </span>
              ) : (
                <>
                  数据时间：{new Date(analysis.fetchedAt).toLocaleString("zh-CN")}
                </>
              )}
            </div>

            {/* 分享到 X */}
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-zinc-600 hover:bg-zinc-800"
                title="分享当前 Tab 内容到 X"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                分享{activeTab === "overview" ? "概览" : activeTab === "metrics" ? "指标" : "AI点评"}
              </button>
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
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  const showToast = (msg: string, type: "ok" | "err" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // 财务数据源相关状态
  const [fmpKeyMasked, setFmpKeyMasked] = useState("");
  const [hasFmpKey, setHasFmpKey] = useState(false);
  const [avKeyMasked, setAvKeyMasked] = useState("");
  const [hasAvKey, setHasAvKey] = useState(false);
  const [tiingoKeyMasked, setTiingoKeyMasked] = useState("");
  const [hasTiingoKey, setHasTiingoKey] = useState(false);
  const [finnhubKeyMasked, setFinnhubKeyMasked] = useState("");
  const [hasFinnhubKey, setHasFinnhubKey] = useState(false);
  const [financeLoading, setFinanceLoading] = useState(true);
  const [fmpKeyInput, setFmpKeyInput] = useState("");
  const [avKeyInput, setAvKeyInput] = useState("");
  const [tiingoKeyInput, setTiingoKeyInput] = useState("");
  const [finnhubKeyInput, setFinnhubKeyInput] = useState("");
  const [financeError, setFinanceError] = useState<string | null>(null);
  const [savingFmp, setSavingFmp] = useState(false);
  const [savingAv, setSavingAv] = useState(false);
  const [savingTiingo, setSavingTiingo] = useState(false);
  const [savingFinnhub, setSavingFinnhub] = useState(false);

  const reloadLLM = useCallback(async () => {
    setLlmLoading(true);
    try {
      const res = await fetch("/api/llm-providers", { cache: "no-store" });
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
      setTiingoKeyMasked(json.tiingoApiKeyMasked || "");
      setHasTiingoKey(!!json.hasTiingoKey);
      setFinnhubKeyMasked(json.finnhubApiKeyMasked || "");
      setHasFinnhubKey(!!json.hasFinnhubKey);
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
      const p = providers.find((x) => x.id === providerId);
      if (action === "setActive") showToast(`已设为活跃：${p?.name ?? providerId}`);
      else if (action === "setEnabled") showToast(`${p?.name ?? providerId} 已${payload.enabled ? "启用" : "禁用"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLlmError(msg);
      showToast(msg, "err");
    }
  };

  const handleSaveKey = async (providerId: string) => {
    const key = (keyInputs[providerId] || "").trim();
    if (!key) return;
    await updateProvider(providerId, "setKey", { apiKey: key });
    setKeyInputs((prev) => ({ ...prev, [providerId]: "" }));
    showToast("API Key 已保存");
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
      const json = await res.json();
      await reloadLLM();
      const p = providers.find((x) => x.id === providerId);
      if (json.ok) {
        showToast(`✓ ${p?.name ?? providerId} 测试通过`);
      } else {
        showToast(`✗ ${p?.name ?? providerId} 测试失败：${json.error ?? "未知错误"}`, "err");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLlmError(msg);
      showToast(msg, "err");
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
      showToast("批量测试完成");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLlmError(msg);
      showToast(msg, "err");
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

  const handleSaveTiingoKey = async () => {
    const key = tiingoKeyInput.trim();
    if (!key) return;
    setSavingTiingo(true);
    setFinanceError(null);
    try {
      const res = await fetch("/api/finance-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiingoApiKey: key }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }
      setTiingoKeyInput("");
      await reloadFinance();
    } catch (err) {
      setFinanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTiingo(false);
    }
  };

  const handleSaveFinnhubKey = async () => {
    const key = finnhubKeyInput.trim();
    if (!key) return;
    setSavingFinnhub(true);
    setFinanceError(null);
    try {
      const res = await fetch("/api/finance-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finnhubApiKey: key }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }
      setFinnhubKeyInput("");
      await reloadFinance();
    } catch (err) {
      setFinanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingFinnhub(false);
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
            管理 LLM 提供商和财务数据源的 API Key。设置会保存到数据库（Vercel）或本地文件。
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
                服务端每 24 小时自动检查一次（结果持久化到数据库或本地）
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
                  const isTesting = testing === p.id;
                  const canTest = p.enabled && (!p.needsKey || p.hasKey || !!keyInputs[p.id]);
              return (
                <div
                  key={p.id}
                  className={`rounded-lg border p-4 transition-all ${
                    isActive
                      ? "border-orange-500/50 bg-orange-500/5"
                      : "border-zinc-800 bg-zinc-900/60"
                  }`}
                >
                  {/* 标题行 */}
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100">{p.name}</span>
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
                    {p.free && (
                      <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                        免费
                      </span>
                    )}
                  </div>

                  {/* 信息行 */}
                  <div className="mt-1 text-[11px] text-zinc-500">
                    模型：<span className="font-mono text-zinc-400">{p.model}</span>
                    {" · "}
                    {p.freeQuota}
                  </div>
                  {p.hasKey ? (
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
                  ) : p.needsKey ? (
                    <div className="mt-1 text-[11px] text-zinc-600">
                      环境变量名：
                      <span className="font-mono text-zinc-500">{p.envVarName}</span>
                    </div>
                  ) : null}
                  {p.lastError && (
                    <div className="mt-1 text-[11px] text-red-400/80">
                      错误：{p.lastError}
                    </div>
                  )}

                  {/* Key 输入（仅 local/none 且需要 Key） */}
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
                    </div>
                  )}
                  {p.needsKey && p.keySource === "env" && (
                    <div className="mt-2 rounded border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-[11px] text-blue-300/80">
                      Key 由环境变量 <span className="font-mono">{p.envVarName}</span> 提供，无法在此处修改。
                    </div>
                  )}

                  {/* 操作栏 */}
                  <div className="mt-3 flex items-center gap-3 border-t border-zinc-800 pt-3">
                    {/* 启用开关 */}
                    <button
                      type="button"
                      onClick={() => updateProvider(p.id, "setEnabled", { enabled: !p.enabled })}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
                        p.enabled ? "bg-orange-500" : "bg-zinc-700"
                      }`}
                      title={p.enabled ? "已启用" : "已禁用"}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          p.enabled ? "translate-x-5" : "translate-x-1"
                        }`}
                      />
                    </button>
                    <span className="text-[11px] text-zinc-400">{p.enabled ? "已启用" : "已禁用"}</span>

                    <div className="flex-1" />

                    {/* 设为活跃 */}
                    {!isActive ? (
                      <button
                        type="button"
                        onClick={() => updateProvider(p.id, "setActive", {})}
                        disabled={!p.enabled}
                        className="rounded-lg border border-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400 disabled:opacity-30"
                      >
                        设为活跃
                      </button>
                    ) : (
                      <span className="rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-1 text-[11px] font-medium text-orange-400">
                        当前活跃
                      </span>
                    )}

                    {/* 测试 */}
                    <button
                      type="button"
                      onClick={() => handleTestOne(p.id)}
                      disabled={isTesting || !canTest}
                      className="rounded-lg border border-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-300 transition-all hover:border-blue-500/50 hover:text-blue-400 disabled:opacity-30"
                    >
                      {isTesting ? (
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
                          测试中
                        </span>
                      ) : (
                        "测试"
                      )}
                    </button>

                    {/* 注册链接 */}
                    <a
                      href={p.signupUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-orange-400/80 hover:text-orange-300"
                    >
                      获取 Key →
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Toast 提示 */}
        {toast && (
          <div
            className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-lg ${
              toast.type === "ok"
                ? "border-green-500/40 bg-green-500/15 text-green-400"
                : "border-red-500/40 bg-red-500/15 text-red-400"
            }`}
          >
            {toast.msg}
          </div>
        )}

          <div className="mt-6 border-t border-zinc-800 pt-4 text-[11px] text-zinc-600">
            推荐配置：Gemini 2.5 Flash（主力）→ Qwen 2.5 / DeepSeek R1（OpenRouter 共用 Key）→ Groq（速度兜底）
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
                      Tiingo
                    </span>
                    <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                      免费
                    </span>
                    <span className="text-[10px] text-zinc-600">需要 Key</span>
                    <span className="rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[10px] text-orange-400">
                      首选
                    </span>
                    {hasTiingoKey && (
                      <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                        已配置
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    当前首选数据源。免费 tier 每天 500 次请求，提供 EOD 价格、财务基本面、分析师目标价等。失败时自动降级到 Finnhub → FMP → Alpha Vantage → Yahoo Finance。
                  </p>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    免费额度：500 次/天
                  </div>
                  {hasTiingoKey && tiingoKeyMasked && (
                    <div className="mt-1 text-[11px] text-zinc-600">
                      已配置 Key：{tiingoKeyMasked}
                    </div>
                  )}
                  <div className="mt-1">
                    <a
                      href="https://www.tiingo.com/"
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
                  value={tiingoKeyInput}
                  onChange={(e) => setTiingoKeyInput(e.target.value)}
                  placeholder="输入 Tiingo API Key"
                  className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveTiingoKey}
                  disabled={!tiingoKeyInput.trim() || savingTiingo}
                  className="rounded border border-orange-500/40 bg-orange-500/20 px-3 py-1 text-xs text-orange-400 hover:bg-orange-500/30 disabled:opacity-30"
                >
                  {savingTiingo ? "保存中..." : "保存"}
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100">
                      Finnhub
                    </span>
                    <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                      免费
                    </span>
                    <span className="text-[10px] text-zinc-600">需要 Key</span>
                    <span className="rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[10px] text-orange-400">
                      次选
                    </span>
                    {hasFinnhubKey && (
                      <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                        已配置
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    免费 tier 60 次/分钟，提供财务指标、分析师目标价和评级、公司新闻、公司概况等。Tiingo 不可用时作为次选数据源。
                  </p>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    免费额度：60 次/分钟
                  </div>
                  {hasFinnhubKey && finnhubKeyMasked && (
                    <div className="mt-1 text-[11px] text-zinc-600">
                      已配置 Key：{finnhubKeyMasked}
                    </div>
                  )}
                  <div className="mt-1">
                    <a
                      href="https://finnhub.io/register"
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
                  value={finnhubKeyInput}
                  onChange={(e) => setFinnhubKeyInput(e.target.value)}
                  placeholder="输入 Finnhub API Key"
                  className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-orange-500/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveFinnhubKey}
                  disabled={!finnhubKeyInput.trim() || savingFinnhub}
                  className="rounded border border-orange-500/40 bg-orange-500/20 px-3 py-1 text-xs text-orange-400 hover:bg-orange-500/30 disabled:opacity-30"
                >
                  {savingFinnhub ? "保存中..." : "保存"}
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
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
                    <span className="rounded border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      备选
                    </span>
                    {hasFmpKey && (
                      <span className="rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400">
                        已配置
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    提供美股完整财务数据（PE、PEG、ROE、营收增长、速动比率等），免费 tier 每天 250 次请求。部分股票为 Premium 数据，当 Tiingo / Finnhub 失败时作为备选数据源。
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
                    Tiingo / Finnhub / FMP 的补充数据源，部分 Premium 股票在 Alpha Vantage 中可免费访问。免费 tier 每天 25 次请求。
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

            <div className="mt-4 rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3 text-[11px] text-zinc-500">
              <div className="font-medium text-zinc-400 mb-1">数据源优先级</div>
              <ol className="ml-4 list-decimal space-y-0.5">
                <li>Tiingo — EOD + 基本面（500/天，首选）</li>
                <li>Finnhub — 分析师目标价 + 财务 + 新闻（60/min）</li>
                <li>FMP — 数据最完整（备选，部分股票为 Premium）</li>
                <li>Alpha Vantage — 补充（25/天）</li>
                <li>Yahoo Finance quoteSummary（带 crumb）</li>
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

function AuthModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (mode === "register") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: normalizedEmail,
            password,
            name: name.trim() || undefined,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(typeof json.error === "string" ? json.error : "注册失败");
          return;
        }
      }

      const result = await signIn("credentials", {
        email: normalizedEmail,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError(mode === "register" ? "注册成功但登录失败，请手动登录" : "邮箱或密码错误");
        return;
      }
      onClose();
    } catch {
      setError("请求失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
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

        <div className="mb-5">
          <h3 className="text-xl font-bold text-white">
            {mode === "login" ? "登录" : "注册"}
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            {mode === "login"
              ? "使用邮箱和密码登录你的账号"
              : "创建账号以保存个人收藏和设置"}
          </p>
        </div>

        <div className="mb-4 flex gap-1 border-b border-zinc-800">
          {([
            { id: "login" as const, label: "登录" },
            { id: "register" as const, label: "注册" },
          ]).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setMode(tab.id);
                setError(null);
              }}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                mode === tab.id
                  ? "text-orange-400 border-orange-400"
                  : "text-zinc-400 border-transparent hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "register" && (
            <div>
              <label className="mb-1 block text-xs text-zinc-400">昵称（可选）</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-orange-500/50"
                placeholder="显示名称"
                autoComplete="name"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-zinc-400">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-orange-500/50"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-orange-500/50"
              placeholder={mode === "register" ? "至少 6 位" : "请输入密码"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg border border-orange-500/40 bg-orange-500/20 px-4 py-2 text-sm font-medium text-orange-300 transition-all hover:bg-orange-500/30 disabled:opacity-50"
          >
            {loading ? "处理中..." : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function Home() {
  const { data: session, status: sessionStatus } = useSession();
  const [activeSub, setActiveSub] = useState("wallstreetbets");
  const [view, setView] = useState<"subreddit" | "favorites">("subreddit");
  const [data, setData] = useState<Record<string, SubredditData>>({});
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // 收藏状态（服务端按登录用户持久化）
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
  // 收藏筛选
  const [favFilter, setFavFilter] = useState<"all" | "starred" | "pinned">("all");
  // 市场筛选：全部 / 美股 / A股
  const [marketFilter, setMarketFilter] = useState<"all" | "us" | "cn">("all");
  const [showAuth, setShowAuth] = useState(false);
  const [signalCount, setSignalCount] = useState(0);
  // ticker -> 最新技术信号快照（来自 /api/technical-snapshots）
  const [signalSnapshots, setSignalSnapshots] = useState<
    Record<string, TechnicalSnapshotRow>
  >({});
  // 轻量行情（价格 + 涨跌幅），来自 /api/quote
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  // 正在刷新的 ticker（用于 UI 节流，避免同一 ticker 重复请求）
  const refreshingRef = useRef<Set<string>>(new Set());
  const isAuthenticated = sessionStatus === "authenticated";
  const isAdmin = !!session?.user?.isAdmin;

  // 批量拉取行情（合并进 quotes，不覆盖已有）
  const loadQuotes = useCallback(async (tickers: string[]) => {
    const tk = Array.from(
      new Set(tickers.map((t) => t.trim().toUpperCase()))
    ).filter(Boolean);
    if (tk.length === 0) return;
    try {
      const res = await fetch(
        `/api/quote?tickers=${encodeURIComponent(tk.join(","))}`
      );
      if (!res.ok) return;
      const json = await res.json();
      if (json.quotes) {
        setQuotes((prev) => ({ ...prev, ...json.quotes }));
      }
    } catch (err) {
      console.warn("[quote] 加载失败:", err);
    }
  }, []);

  const promptSignIn = useCallback(() => {
    setShowAuth(true);
  }, []);

  // 初始化：从后端 API 读取收藏
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (sessionStatus === "loading") return;
      if (sessionStatus !== "authenticated") {
        if (!cancelled) {
          setFavorites([]);
          setSignalCount(0);
        }
        return;
      }
      try {
        const [favRes, sigRes] = await Promise.all([
          fetch("/api/favorites"),
          fetch("/api/signals?limit=0"),
        ]);
        const favJson = await favRes.json();
        const sigJson = await sigRes.json();
        if (cancelled) return;
        if (favJson.favorites && Array.isArray(favJson.favorites)) {
          // 服务端已按 starred > pinned > addedAt 排序，客户端再排一次兜底
          setFavorites(
            sortFavoritesClient(
              favJson.favorites.map(mapFavoriteFromApi)
            )
          );
        }
        if (sigJson.total != null) {
          setSignalCount(sigJson.total);
        }
      } catch (err) {
        console.error("Failed to load favorites/signals:", err);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [sessionStatus]);

  // 加载/刷新技术信号快照：每次收藏变化时批量取一次
  useEffect(() => {
    if (favorites.length === 0) return;
    let cancelled = false;
    const tickers = Array.from(new Set(favorites.map((f) => f.ticker.toUpperCase())));
    fetch(`/api/technical-snapshots?tickers=${encodeURIComponent(tickers.join(","))}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.snapshots) return;
        const map: Record<string, TechnicalSnapshotRow> = {};
        for (const row of json.snapshots as TechnicalSnapshotRow[]) {
          map[row.ticker.toUpperCase()] = row;
        }
        setSignalSnapshots(map);
      })
      .catch((err) => console.warn("[technical-snapshots] 加载失败:", err));
    return () => {
      cancelled = true;
    };
  }, [favorites]);

  // 加载行情：每次收藏变化时批量取一次（合并进 quotes）
  useEffect(() => {
    if (favorites.length === 0) return;
    loadQuotes(favorites.map((f) => f.ticker));
  }, [favorites, loadQuotes]);

  // 加载行情：subreddit 列表里的 ticker（随数据刷新 / 切换板块更新）
  useEffect(() => {
    const tk = (data[activeSub]?.tickers || []).map((t) => t.ticker);
    if (tk.length === 0) return;
    loadQuotes(tk);
  }, [data, activeSub, loadQuotes]);

  /**
   * 懒刷新：snapshot 缺失或 > 24h 时调用 /api/technical-snapshots/refresh
   * - 美股刷新 TradingView 技术信号，A 股刷新同花顺筹码状态
   * - 同 ticker 5 分钟内只能请求一次（ref 节流）
   * - 服务端也会做 5 分钟内的去重保护
   */
  const requestRefreshSnapshot = useCallback(async (ticker: string) => {
    const upper = ticker.toUpperCase();
    if (refreshingRef.current.has(upper)) return;
    refreshingRef.current.add(upper);
    try {
      const res = await fetch("/api/technical-snapshots/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: upper }),
      });
      if (!res.ok) return;
      const json = await res.json();
      if (json.snapshot) {
        const row = json.snapshot as TechnicalSnapshotRow;
        setSignalSnapshots((prev) => ({
          ...prev,
          [row.ticker.toUpperCase()]: row,
        }));
      }
    } catch (err) {
      console.warn("[technical-snapshots/refresh] 失败:", err);
    } finally {
      refreshingRef.current.delete(upper);
    }
  }, []);

  // 注册 Service Worker (PWA)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    const registerSW = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => console.warn("SW registration failed:", err));
    };
    if (document.readyState === "complete") {
      registerSW();
    } else {
      window.addEventListener("load", registerSW);
      return () => window.removeEventListener("load", registerSW);
    }
  }, []);

  const favoriteTickers = useMemo(
    () => new Set(favorites.map((f) => f.ticker.toUpperCase())),
    [favorites]
  );

  const isFavorite = useCallback(
    (ticker: string) => favoriteTickers.has(ticker.toUpperCase()),
    [favoriteTickers]
  );

  const addFavorite = useCallback(
    async (ticker: string, name?: string | null) => {
      if (!isAuthenticated) {
        promptSignIn();
        return;
      }
      const upper = ticker.trim().toUpperCase();
      if (!upper) return;
      setFavorites((prev) => {
        if (prev.some((f) => f.ticker.toUpperCase() === upper)) return prev;
        return [
          ...prev,
          { ticker: upper, name: name ?? null, addedAt: Date.now() },
        ];
      });
      try {
        await fetch("/api/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: upper, name: name ?? undefined }),
        });
      } catch (err) {
        console.error("Failed to add favorite:", err);
      }
    },
    [isAuthenticated, promptSignIn]
  );

  const removeFavorite = useCallback(async (ticker: string) => {
    if (!isAuthenticated) {
      promptSignIn();
      return;
    }
    const upper = ticker.trim().toUpperCase();
    // 乐观更新：先从列表移除
    setFavorites((prev) =>
      prev.filter((f) => f.ticker.toUpperCase() !== upper)
    );
    try {
      const res = await fetch(`/api/favorites?ticker=${encodeURIComponent(upper)}`, {
        method: "DELETE",
      });
      // 服务端返回 deleted=0 说明没删到任何记录（可能是 ticker 不匹配），
      // 或返回非 2xx（DB 异常）。两种情况都回拉服务端真实状态，
      // 避免乐观更新与后端不一致导致「移除不生效」。
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.deleted === 0) {
        console.warn("[favorites] DELETE may not have removed record:", {
          status: res.status,
          deleted: data.deleted,
          tried: data.tried,
        });
        const syncRes = await fetch("/api/favorites");
        const syncJson = await syncRes.json();
        if (syncJson.favorites && Array.isArray(syncJson.favorites)) {
          setFavorites(syncJson.favorites.map(mapFavoriteFromApi));
        }
      }
    } catch (err) {
      console.error("Failed to remove favorite:", err);
      // 网络错误时同样回拉服务端状态
      try {
        const syncRes = await fetch("/api/favorites");
        const syncJson = await syncRes.json();
        if (syncJson.favorites && Array.isArray(syncJson.favorites)) {
          setFavorites(syncJson.favorites.map(mapFavoriteFromApi));
        }
      } catch {
        /* ignore */
      }
    }
  }, [isAuthenticated, promptSignIn]);

  // 置顶 / 取消置顶：先在前端更新状态并重排序，再异步同步到后端
  const togglePinFavorite = useCallback(
    async (ticker: string, pinned: boolean) => {
      if (!isAuthenticated) {
        promptSignIn();
        return;
      }
      const upper = ticker.trim().toUpperCase();
      setFavorites((prev) => {
        const updated = prev.map((f) =>
          f.ticker.toUpperCase() === upper ? { ...f, pinned } : f
        );
        // 客户端按 starred > pinned > addedAt 重排
        return sortFavoritesClient(updated);
      });
      try {
        await fetch("/api/favorites", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: upper, pinned }),
        });
      } catch (err) {
        console.error("Failed to toggle pin:", err);
        // 失败时回滚
        setFavorites((prev) =>
          prev.map((f) =>
            f.ticker.toUpperCase() === upper
              ? { ...f, pinned: !pinned }
              : f
          )
        );
      }
    },
    [isAuthenticated, promptSignIn]
  );

  // 重点关注 / 取消关注：前端更新状态，异步同步后端
  const toggleStarFavorite = useCallback(
    async (ticker: string, starred: boolean) => {
      if (!isAuthenticated) {
        promptSignIn();
        return;
      }
      const upper = ticker.trim().toUpperCase();
      setFavorites((prev) => {
        const updated = prev.map((f) =>
          f.ticker.toUpperCase() === upper ? { ...f, starred } : f
        );
        // 重点关注切换后立即重排（重点项上浮）
        return sortFavoritesClient(updated);
      });
      try {
        await fetch("/api/favorites", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: upper, starred }),
        });
      } catch (err) {
        console.error("Failed to toggle star:", err);
        setFavorites((prev) =>
          prev.map((f) =>
            f.ticker.toUpperCase() === upper
              ? { ...f, starred: !starred }
              : f
          )
        );
      }
    },
    [isAuthenticated, promptSignIn]
  );

  const toggleFavorite = useCallback(
    async (ticker: string, name?: string | null) => {
      if (!isAuthenticated) {
        promptSignIn();
        return;
      }
      const upper = ticker.trim().toUpperCase();
      if (!upper) return;
      const willAdd = !favorites.some((f) => f.ticker.toUpperCase() === upper);
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
      try {
        if (willAdd) {
          await fetch("/api/favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticker: upper, name: name ?? undefined }),
          });
        } else {
          // 取消收藏 = DELETE。校验响应，失败或 deleted=0 时回拉服务端真实状态，
          // 避免乐观更新与后端不一致导致「移除不生效」。
          const res = await fetch(`/api/favorites?ticker=${encodeURIComponent(upper)}`, {
            method: "DELETE",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.deleted === 0) {
            const syncRes = await fetch("/api/favorites");
            const syncJson = await syncRes.json();
            if (syncJson.favorites && Array.isArray(syncJson.favorites)) {
              setFavorites(syncJson.favorites.map(mapFavoriteFromApi));
            }
          }
        }
      } catch (err) {
        console.error("Failed to toggle favorite:", err);
        // 网络错误时回拉服务端状态
        try {
          const syncRes = await fetch("/api/favorites");
          const syncJson = await syncRes.json();
          if (syncJson.favorites && Array.isArray(syncJson.favorites)) {
            setFavorites(syncJson.favorites.map(mapFavoriteFromApi));
          }
        } catch {
          /* ignore */
        }
      }
    },
    [favorites, isAuthenticated, promptSignIn]
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
    const sym = manualTicker.trim();
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
            `✓ 有效${json.name ? ` · ${json.name}` : ""}${json.quoteType ? ` · ${json.quoteType}` : ""}${json.market === "CN" ? " · A股" : ""}`
          );
          if (json.name && !manualName) {
            setManualName(json.name);
          }
          // A 股规范化后的 ticker（600519.SH）回填，保证后续添加/分析使用正确格式
          if (json.ticker && json.ticker !== sym.toUpperCase()) {
            setManualTicker(json.ticker);
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
    if (!isAuthenticated) {
      promptSignIn();
      return;
    }
    const sym = manualTicker.trim().toUpperCase();
    if (!sym) return;
    addFavorite(sym, manualName.trim() || null);
    setManualTicker("");
    setManualName("");
    setValidateError(null);
    setValidateHint(null);
  }, [isAuthenticated, manualTicker, manualName, addFavorite, promptSignIn]);

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
        <div className="mx-auto max-w-screen-2xl px-4 py-4">
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
              {isAdmin && (
                <a
                  href="/admin"
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-orange-500/40 hover:text-orange-400"
                  title="定时任务监控"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                  </svg>
                  <span className="hidden sm:inline">监控</span>
                </a>
              )}
              {isAdmin && (
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
              )}
              {isAdmin && (
                <button
                  onClick={() => setShowSettings(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-orange-500/40 hover:text-orange-400"
                  title="设置（LLM / 财务数据源）"
                >
                  <GearIcon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">设置</span>
                </button>
              )}
              {isAuthenticated ? (
                <div className="hidden lg:flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300">
                  <span className="max-w-44 truncate">{session?.user?.email || session?.user?.name || "已登录"}</span>
                  {isAdmin && (
                    <span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                      管理员
                    </span>
                  )}
                </div>
              ) : null}
              {isAuthenticated ? (
                <button
                  onClick={() => void signOut()}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-zinc-600 hover:text-white"
                  title="退出登录"
                >
                  退出
                </button>
              ) : (
                <button
                  onClick={promptSignIn}
                  className="rounded-lg border border-orange-500/40 bg-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-300 transition-all hover:bg-orange-500/30"
                  title="登录或注册"
                >
                  登录
                </button>
              )}
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
        <div className="mx-auto max-w-screen-2xl px-4">
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

      <main className="mx-auto max-w-screen-2xl px-4 py-6">
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
                    quote={quotes[ticker.ticker.toUpperCase()]}
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
                  {isAuthenticated
                    ? `已收藏 ${favorites.length} 个标的 · 数据保存在你的账号下`
                    : "登录后，可保存和查看你的个人收藏"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isAuthenticated && (
                  <a
                    href="/signals"
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                      signalCount > 0
                        ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-400"
                        : "border-zinc-700 text-zinc-400 hover:border-cyan-500/30 hover:text-cyan-300"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                    </svg>
                    信号提醒
                    {signalCount > 0 && (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-cyan-500 text-[10px] font-bold text-white">
                        {signalCount}
                      </span>
                    )}
                  </a>
                )}
                {isAuthenticated && favorites.length > 0 && (
                  <div className="flex gap-1.5">
                    {(["all", "starred", "pinned"] as const).map((f) => {
                      const labels = { all: "全部", starred: "重点关注", pinned: "置顶" };
                      const counts = {
                        all: favorites.length,
                        starred: favorites.filter((x) => x.starred).length,
                        pinned: favorites.filter((x) => x.pinned).length,
                      };
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setFavFilter(f)}
                          className={`rounded-lg border px-3 py-1 text-xs font-medium transition-all ${
                            favFilter === f
                              ? "border-orange-500/50 bg-orange-500/15 text-orange-400"
                              : "border-zinc-700 text-zinc-400 hover:border-orange-500/30 hover:text-zinc-300"
                          }`}
                        >
                          {labels[f]} ({counts[f]})
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {!isAuthenticated ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-orange-500/15">
                  <StarIcon filled className="h-8 w-8 text-orange-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">登录后查看你的专属收藏</h3>
                <p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">
                  收藏列表按账号隔离。登录后，你只能看到并管理自己的股票收藏；旧的全局收藏会自动迁移到首个管理员账号。
                </p>
                <button
                  type="button"
                  onClick={promptSignIn}
                  className="mt-5 rounded-lg border border-orange-500/40 bg-orange-500/20 px-4 py-2 text-sm font-medium text-orange-300 transition-all hover:bg-orange-500/30"
                >
                  登录 / 注册
                </button>
              </div>
            ) : (
              <>
                {/* 市场筛选：全部 / 美股 / A股 */}
                {favorites.length > 0 && (
                  <div className="mb-4 flex gap-1.5">
                    {(["all", "us", "cn"] as const).map((m) => {
                      const marketLabels = { all: "全部市场", us: "美股", cn: "A股" };
                      const marketCounts = {
                        all: favorites.length,
                        us: favorites.filter((x) => !isCNTicker(x.ticker)).length,
                        cn: favorites.filter((x) => isCNTicker(x.ticker)).length,
                      };
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setMarketFilter(m)}
                          className={`rounded-lg border px-3 py-1 text-xs font-medium transition-all ${
                            marketFilter === m
                              ? m === "cn"
                                ? "border-red-500/50 bg-red-500/15 text-red-400"
                                : "border-orange-500/50 bg-orange-500/15 text-orange-400"
                              : "border-zinc-700 text-zinc-400 hover:border-orange-500/30 hover:text-zinc-300"
                          }`}
                        >
                          {marketLabels[m]} ({marketCounts[m]})
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* 手动添加收藏（带校验） */}
                <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-300">
                      手动添加收藏
                    </span>
                    <span className="text-[11px] text-zinc-600">
                      支持美股(如 AAPL)与 A 股(如 600519 / 000001)，自动校验
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
                        placeholder="股票代码 (美股 AAPL / A股 600519)"
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
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {favorites
                      .filter((item) =>
                        favFilter === "all" ? true :
                        favFilter === "starred" ? !!item.starred :
                        favFilter === "pinned" ? !!item.pinned : true
                      )
                      .filter((item) =>
                        marketFilter === "all" ? true :
                        marketFilter === "cn" ? isCNTicker(item.ticker) :
                        marketFilter === "us" ? !isCNTicker(item.ticker) : true
                      )
                      .map((item) => (
                        <FavoriteCard
                          key={item.ticker}
                          item={item}
                          onRemove={removeFavorite}
                          onAnalyze={handleAnalyze}
                          onTogglePin={togglePinFavorite}
                          onToggleStar={toggleStarFavorite}
                          signalSnapshot={signalSnapshots[item.ticker.toUpperCase()]}
                          onRequestRefreshSnapshot={requestRefreshSnapshot}
                          quote={quotes[item.ticker.toUpperCase()]}
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
                  收藏数据：按账号隔离存储 · 策略 / 分析缓存：服务端数据库
                </div>
              </>
            )}
          </>
        )}
      </main>

      {analyzingItem && (
        <AnalysisModal
          item={analyzingItem}
          signalSnapshot={signalSnapshots[analyzingItem.ticker.toUpperCase()]}
          onSnapshotUpdated={(snapshot) => {
            const key = snapshot.ticker.toUpperCase();
            setSignalSnapshots((prev) => ({ ...prev, [key]: snapshot }));
          }}
          onClose={() => setAnalyzingItem(null)}
        />
      )}
      {showAuth && (
        <AuthModal onClose={() => setShowAuth(false)} />
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
