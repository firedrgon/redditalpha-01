"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { EtfSkillEvaluation, EtfGoal } from "@/lib/etf-skill-evaluate";
import type { EtfNavHistory, EtfPeer } from "@/lib/etf-fund-data";

function thsEtfUrl(code: string): string {
  return `https://fund.10jqka.com.cn/${code}/`;
}

const GOALS: { key: EtfGoal; label: string; desc: string }[] = [
  { key: "growth", label: "长期增长", desc: "追求长期资本增值" },
  { key: "income", label: "收入/分红", desc: "偏好稳定现金流" },
  { key: "stable", label: "稳健", desc: "低波动、控回撤" },
  { key: "balanced", label: "均衡", desc: "宽基+风格分散" },
];

const GOAL_KEYS = ["growth", "income", "stable", "balanced"] as const;

function parseGoal(raw: string | null): EtfGoal {
  if (!raw) return null;
  return (GOAL_KEYS as readonly string[]).includes(raw) ? (raw as EtfGoal) : null;
}

interface ApiResp {
  code: string;
  name: string | null;
  board: string | null;
  goal: EtfGoal;
  fund: {
    fundCompany: string | null;
    fundManager: string | null;
    establishDate: string | null;
    trackIndexName: string | null;
    indexType: "broad" | "sector" | "strategy" | null;
    proxy: boolean;
    feeRatePct: number | null;
    scaleYi: number | null;
    indexPe: number | null;
    indexPb: number | null;
    indexPePercentile: number | null;
    indexPbPercentile: number | null;
    dividendYieldPct: number | null;
    navNow: number | null;
    trackingErrorPct: number | null;
  };
  nav: EtfNavHistory | null;
  peers: EtfPeer[] | null;
  evaluation: EtfSkillEvaluation;
  /** true = 来自数据库缓存（未重新计算）；false/undefined = 本次实时计算 */
  cached?: boolean;
  /** 缓存命中的分析时间（ISO 字符串），用于展示「已于 X 分析」 */
  cachedAt?: string | null;
}

// ============================================================
// 工具
// ============================================================
const idxTypeLabel = (t: ApiResp["fund"]["indexType"]): string =>
  t === "broad" ? "宽基指数" : t === "sector" ? "行业/主题指数" : t === "strategy" ? "策略指数" : "—";

const fmtPct = (v: number | null, d = 1): string =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;

const retClass = (v: number | null): string =>
  v == null ? "text-zinc-400" : v >= 0 ? "text-emerald-400" : "text-red-400";

/** ISO 时间 → 友好的本地时间文案（用于「已于 X 分析」展示） */
function formatCachedAt(iso: string | null | undefined): string {
  if (!iso) return "未知时间";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "未知时间";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 估值分位 → 解读（与技能报告一致的阈值语义） */
function valVerdict(pct: number | null): { text: string; cls: string } {
  if (pct == null) return { text: "—", cls: "text-zinc-500" };
  if (pct >= 60) return { text: "偏贵", cls: "text-red-400" };
  if (pct <= 30) return { text: "便宜", cls: "text-emerald-400" };
  return { text: "合理", cls: "text-sky-400" };
}

// ============================================================
// 小组件：评分条 / 评级徽章
// ============================================================
function ScoreBar({ label, score }: { label: string; score: number | null }) {
  const pct = score ?? 0;
  const color =
    score == null
      ? "bg-zinc-700"
      : score >= 70
      ? "bg-emerald-500"
      : score >= 50
      ? "bg-amber-500"
      : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      {label && <span className="w-14 shrink-0 font-medium text-zinc-300">{label}</span>}
      <div className="h-2 flex-1 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full rounded ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-zinc-300">
        {score != null ? (score / 10).toFixed(0) : "—"}
      </span>
    </div>
  );
}

function GradeBadge({ grade, score }: { grade: string; score: number | null }) {
  const style: Record<string, string> = {
    A: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    B: "border-sky-500/40 bg-sky-500/15 text-sky-300",
    C: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    D: "border-red-500/40 bg-red-500/15 text-red-300",
    "?": "border-zinc-600/40 bg-zinc-700/20 text-zinc-400",
  };
  const cls = style[grade] ?? style["?"];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-sm font-bold ${cls}`}
    >
      评级 {grade}
      <span className="font-mono">{score != null ? (score / 10).toFixed(1) : "—"}</span>
    </span>
  );
}

// ============================================================
// 图表（纯 SVG）
// ============================================================
function RadarChart({ dims }: { dims: { label: string; score: number | null }[] }) {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 108;
  const n = dims.length;
  const angle = (i: number) => ((-90 + i * (360 / n)) * Math.PI) / 180;
  const pt = (i: number, r: number): [number, number] => [
    cx + r * Math.cos(angle(i)),
    cy + r * Math.sin(angle(i)),
  ];
  const grid = [0.25, 0.5, 0.75, 1].map((f) => (
    <polygon
      key={f}
      points={dims.map((_, i) => pt(i, maxR * f).join(",")).join(" ")}
      fill="none"
      stroke="#3f3f46"
      strokeWidth={1}
    />
  ));
  const axes = dims.map((_, i) => {
    const [x, y] = pt(i, maxR);
    return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#3f3f46" strokeWidth={1} />;
  });
  const dataPts = dims.map((d, i) => pt(i, maxR * ((d.score ?? 0) / 100)));
  const dataPoly = dataPts.map((p) => p.join(",")).join(" ");
  const labels = dims.map((d, i) => {
    const [x, y] = pt(i, maxR + 20);
    return (
      <text key={i} x={x} y={y} fontSize={11} fill="#a1a1aa" textAnchor="middle" dominantBaseline="middle">
        {d.label}
      </text>
    );
  });
  const scores = dims.map((d, i) => {
    const [x, y] = pt(i, maxR * ((d.score ?? 0) / 100));
    return (
      <text key={i} x={x} y={y - 7} fontSize={10} fill="#fb923c" textAnchor="middle">
        {d.score != null ? (d.score / 10).toFixed(0) : "—"}
      </text>
    );
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: 320 }}>
      {grid}
      {axes}
      <polygon points={dataPoly} fill="rgba(251,146,60,0.22)" stroke="#fb923c" strokeWidth={2} />
      {dataPts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="#fb923c" />
      ))}
      {labels}
      {scores}
    </svg>
  );
}

function NavLineChart({ points }: { points: { date: string; nav: number }[] }) {
  const w = 900;
  const h = 240;
  const pad = 30;
  if (points.length < 2) return <div className="text-xs text-zinc-500">暂无净值数据</div>;
  const ns = points.map((p) => p.nav);
  const min = Math.min(...ns);
  const max = Math.max(...ns);
  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (w - 2 * pad));
  const ys = ns.map((v) => h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad));
  const line = points.map((_, i) => `${xs[i]},${ys[i]}`).join(" ");
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="none">
      <polygon points={area} fill="rgba(56,189,248,0.10)" />
      <polyline points={line} fill="none" stroke="#38bdf8" strokeWidth={2} />
    </svg>
  );
}

function DrawdownChart({ points }: { points: { date: string; nav: number }[] }) {
  const w = 900;
  const h = 240;
  const pad = 30;
  if (points.length < 2) return <div className="text-xs text-zinc-500">暂无回撤数据</div>;
  let runMax = -Infinity;
  const dds: number[] = [];
  for (const p of points) {
    if (p.nav > runMax) runMax = p.nav;
    dds.push(p.nav / runMax - 1);
  }
  const minDD = Math.min(...dds) || -0.01;
  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (w - 2 * pad));
  const ys = dds.map((v) => pad + (v / minDD) * (h - 2 * pad));
  const line = points.map((_, i) => `${xs[i]},${ys[i]}`).join(" ");
  const area = `${pad},${pad} ${line} ${w - pad},${pad}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="none">
      <polygon points={area} fill="rgba(239,68,68,0.12)" />
      <polyline points={line} fill="none" stroke="#ef4444" strokeWidth={2} />
    </svg>
  );
}

function PeerBarChart({ peers, selfCode }: { peers: EtfPeer[]; selfCode: string }) {
  if (!peers.length) return <div className="text-xs text-zinc-500">暂无同类规模数据（数据源不支持或该指数无其他 ETF）</div>;
  const max = Math.max(...peers.map((p) => p.scaleYi ?? 0), 0.01);
  return (
    <div className="space-y-2">
      {peers.map((p) => {
        const isSelf = p.code === selfCode;
        const wPct = ((p.scaleYi ?? 0) / max) * 100;
        return (
          <div key={p.code} className="flex items-center gap-2 text-[11px]">
            <span className={`w-32 shrink-0 truncate ${isSelf ? "text-orange-400 font-medium" : "text-zinc-400"}`}>
              {p.name || p.code}
              {isSelf ? "（本基）" : ""}
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-zinc-800">
              <div
                className={`h-full rounded ${isSelf ? "bg-orange-500" : "bg-zinc-600"}`}
                style={{ width: `${wPct}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-zinc-300">{(p.scaleYi ?? 0).toFixed(2)}亿</span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// 主组件
// ============================================================
function EtfEvaluateInner() {
  const searchParams = useSearchParams();

  const urlCode = (searchParams.get("code") ?? "").trim();
  const urlGoal = parseGoal(searchParams.get("goal"));
  const hasUrlCode = /^\d{6}$/.test(urlCode);

  const [code, setCode] = useState(hasUrlCode ? urlCode : "");
  const [goal, setGoal] = useState<EtfGoal>(urlGoal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResp | null>(null);

  // 收藏状态（与首页收藏列表共享同一份数据）
  const [fav, setFav] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const favCode = (data?.code ?? code).trim();
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!/^\d{6}$/.test(favCode)) {
        await Promise.resolve();
        if (!cancelled) setFav(false);
        return;
      }
      try {
        const r = await fetch(`/api/favorites?ticker=${encodeURIComponent(favCode)}`, {
          cache: "no-store",
        });
        const d = await r.json();
        if (!cancelled) setFav(!!d?.isFavorite);
      } catch {
        if (!cancelled) setFav(false);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [favCode]);

  const toggleFav = useCallback(async () => {
    if (!/^\d{6}$/.test(favCode) || favBusy) return;
    setFavBusy(true);
    try {
      if (fav) {
        const res = await fetch(`/api/favorites?ticker=${encodeURIComponent(favCode)}`, {
          method: "DELETE",
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.deleted !== 0) setFav(false);
        else if (!res.ok) setFav(false); // 乐观：失败即视为已移除
      } else {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticker: favCode,
            name: data?.name ?? undefined,
            assetType: "ETF",
          }),
        });
        if (res.ok) setFav(true);
      }
    } catch {
      /* 网络错误：保持原状 */
    } finally {
      setFavBusy(false);
    }
  }, [favCode, fav, favBusy, data]);

  const runWith = useCallback(async (rawCode: string, g: EtfGoal, force = false) => {
    const c = rawCode.trim();
    if (!/^\d{6}$/.test(c)) {
      setError("请输入 6 位 ETF 代码（如 510300）");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url = `/api/etf-evaluate?code=${c}${g ? `&goal=${g}` : ""}${force ? "&refresh=1" : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "评估失败");
        setData(null);
        return;
      }
      setData(json);
    } catch {
      setError("网络错误，请稍后重试");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const run = useCallback(() => {
    void runWith(code, goal);
  }, [runWith, code, goal]);

  /** 手动重新分析：强制后端忽略缓存、重抓重算 */
  const refresh = useCallback(() => {
    void runWith(code, goal, true);
  }, [runWith, code, goal]);

  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !hasUrlCode) return;
    autoRan.current = true;
    void runWith(urlCode, urlGoal);
  }, [hasUrlCode, urlCode, urlGoal, runWith]);

  // 关键指标卡（来自净值历史）；顺序与「ETF产品智能评估」技能报告对齐
  const nav = data?.nav;
  const trackErr = data?.fund.trackingErrorPct;
  const metricCards: { label: string; value: string; cls: string; sub?: string }[] = nav
    ? [
        { label: "最新单位净值", value: nav.navNow != null ? nav.navNow.toFixed(4) : "—", cls: "text-zinc-100" },
        { label: "今年以来", value: fmtPct(nav.ytdPct), cls: retClass(nav.ytdPct) },
        { label: "近1年", value: fmtPct(nav.y1Pct), cls: retClass(nav.y1Pct) },
        { label: "近3月", value: fmtPct(nav.m3Pct), cls: retClass(nav.m3Pct) },
        { label: "近5年", value: fmtPct(nav.y5Pct), cls: retClass(nav.y5Pct) },
        { label: "近1年年化波动", value: nav.annualVolPct != null ? `${nav.annualVolPct.toFixed(1)}%` : "—", cls: "text-zinc-100" },
        { label: "历史最大回撤", value: nav.maxDrawdownPct != null ? `${nav.maxDrawdownPct.toFixed(1)}%` : "—", cls: "text-red-400" },
        {
          label: "年化跟踪误差",
          value: trackErr != null ? `${trackErr.toFixed(2)}%` : "—",
          cls: trackErr != null ? "text-zinc-100" : "text-zinc-600",
          sub: trackErr != null ? undefined : "免费源暂无",
        },
      ]
    : [];

  // 估值表行
  const f = data?.fund;
  const valRows = f
    ? [
        { name: "市盈率 PE-TTM", cur: f.indexPe, pct: f.indexPePercentile, unit: "倍" },
        { name: "市净率 PB", cur: f.indexPb, pct: f.indexPbPercentile, unit: "倍" },
        { name: "股息率", cur: f.dividendYieldPct, pct: null, unit: "%" },
        { name: "PEG（盈利预期）", cur: null, pct: null, unit: "", pegMissing: true },
      ]
    : [];

  // 乘积法（几何均值）综合分：任意短板会拉低整体，故除加权外另算几何均值
  const scoredDims = data?.evaluation.dimensions.filter((d) => d.score != null) ?? [];
  const geoMean =
    scoredDims.length > 0
      ? (scoredDims.reduce((acc, d) => acc * ((d.score as number) / 100), 1) **
          (1 / scoredDims.length)) *
        100
      : null;

  // 评估日期（用于 header 标注，与技能报告一致）
  const evalDate = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-2 flex items-center gap-2">
        <Link href="/" className="text-xs text-zinc-500 transition-colors hover:text-orange-400">
          ← 返回首页
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-white">ETF 产品智能评估</h1>
      <p className="mt-2 text-sm text-zinc-500">
        对齐「ETF产品智能评估」框架：
        <span className="text-zinc-400">
          好资产 × 好价格 × 好运营 × 好时机 × 好匹配 × 好成本
        </span>
        。输入 ETF 代码与投资目标，获取六维分项评估、净值走势与综合配置建议。
      </p>

      {/* 输入区 */}
      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="ETF 代码，如 510300"
            className="w-44 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-orange-500/50"
          />
          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-2 text-sm font-medium text-orange-400 transition-all hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "评估中…" : "开始评估"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-zinc-500">投资目标（好匹配维度）：</span>
          {GOALS.map((g) => {
            const active = goal === g.key;
            return (
              <button
                key={g.key as string}
                type="button"
                title={g.desc}
                onClick={() => setGoal(active ? null : g.key)}
                className={`rounded border px-2.5 py-1 text-[11px] font-medium transition-all ${
                  active
                    ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                    : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {g.label}
              </button>
            );
          })}
          {goal && (
            <button
              type="button"
              onClick={() => setGoal(null)}
              className="rounded border border-zinc-700 bg-zinc-800/40 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
            >
              清除
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* 结果区 */}
      {data && (
        <div className="mt-6 space-y-5">
          {/* 缓存提示：来自历史分析结果，可一键重新分析 */}
          {data.cached && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1 text-emerald-400/80">
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                已缓存
              </span>
              <span>
                该 ETF 已于 {formatCachedAt(data.cachedAt)} 完成分析，以下为缓存结果（点右上「重新分析」可强制刷新）。
              </span>
            </div>
          )}

          {/* 综合评级 + 名称 + 标签 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex flex-wrap items-center gap-4">
              <GradeBadge grade={data.evaluation.grade} score={data.evaluation.totalScore} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-lg font-bold text-white">
                  {data.name ?? "未知"}
                  <span className="font-mono text-sm text-zinc-500">{data.code}</span>
                </div>
                <p className="mt-0.5 text-xs text-zinc-400">{data.evaluation.summary}</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  评估日期 {evalDate} ｜ 数据来源：东方财富 / 同花顺（免费公开源）
                </p>
              </div>
              <a
                href={thsEtfUrl(data.code)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-zinc-700/50 px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-400"
              >
                同花顺估值页
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5v13h13v-8.5M15 3h6v6M21 3l-9 9" />
                </svg>
              </a>
              <button
                type="button"
                onClick={toggleFav}
                disabled={favBusy}
                title={fav ? "取消收藏" : "加入收藏"}
                className={`inline-flex items-center gap-1 rounded border px-2.5 py-1.5 text-[11px] font-medium transition-all disabled:opacity-50 ${
                  fav
                    ? "border-yellow-500/50 bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25"
                    : "border-zinc-700/50 text-zinc-400 hover:border-yellow-500/40 hover:text-yellow-400"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5"
                  fill={fav ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5l2.3 4.66 5.14.75-3.72 3.63.88 5.12-4.6-2.42-4.6 2.42.88-5.12L3.56 8.9l5.14-.75 2.3-4.66z" />
                </svg>
                {fav ? "已收藏" : "收藏"}
              </button>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                title="忽略缓存，重新抓取并分析"
                className={`inline-flex items-center gap-1 rounded border px-2.5 py-1.5 text-[11px] font-medium transition-all disabled:opacity-50 ${
                  loading
                    ? "border-zinc-700/50 text-zinc-500"
                    : "border-zinc-700/50 text-zinc-400 hover:border-orange-500/40 hover:text-orange-400"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M5.5 9a7 7 0 0112-2.5L20 9M18.5 15a7 7 0 01-12 2.5L4 15" />
                </svg>
                {loading ? "分析中…" : "重新分析"}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
              <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">类型：{idxTypeLabel(data.fund.indexType)}</span>
              {data.fund.trackIndexName && (
                <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">跟踪：{data.fund.trackIndexName}</span>
              )}
              {data.fund.fundCompany && (
                <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">公司：{data.fund.fundCompany}</span>
              )}
              {data.fund.fundManager && (
                <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">经理：{data.fund.fundManager}</span>
              )}
              {data.fund.establishDate && (
                <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">成立：{data.fund.establishDate}</span>
              )}
              {data.fund.scaleYi != null && (
                <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">规模：{data.fund.scaleYi.toFixed(2)}亿</span>
              )}
              {data.fund.feeRatePct != null && (
                <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">总费率：{data.fund.feeRatePct.toFixed(2)}%/年</span>
              )}
              {data.fund.proxy && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-400">估值分位为估算（无真实历史数据）</span>
              )}
            </div>
          </div>

          {/* 关键指标卡 */}
          {metricCards.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {metricCards.map((m) => (
                <div key={m.label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="text-[10px] text-zinc-500">{m.label}</div>
                  <div className={`mt-1 text-lg font-bold ${m.cls}`}>{m.value}</div>
                  {m.sub && <div className="mt-0.5 text-[9px] text-zinc-600">{m.sub}</div>}
                </div>
              ))}
            </div>
          )}

          {/* 六维雷达 + 总分 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="text-xs font-medium text-zinc-300">六维评分总览</div>
            <div className="mt-2 flex flex-col items-center gap-4 sm:flex-row sm:items-center">
              <div className="shrink-0">
                <RadarChart dims={data.evaluation.dimensions.map((d) => ({ label: d.label, score: d.score }))} />
              </div>
              <div className="flex-1 text-sm text-zinc-400">
                <div className="text-3xl font-extrabold text-orange-400">
                  {data.evaluation.totalScore != null ? (data.evaluation.totalScore / 10).toFixed(1) : "—"}
                  <span className="text-base text-zinc-500"> / 10（加权均值）</span>
                </div>
                {geoMean != null && (
                  <div className="mt-1 text-xs text-zinc-500">
                    乘积法（几何均值）综合 ≈ <b className="text-zinc-300">{geoMean.toFixed(1)}</b>/10
                    （任意短板会拉低整体，故取几何均值）
                  </div>
                )}
                <div className="mt-2 leading-relaxed">
                  {data.evaluation.dimensions.map((d) => (
                    <span key={d.key} className="mr-3">
                      {d.label} <b className="text-zinc-200">{d.score != null ? (d.score / 10).toFixed(0) : "—"}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 净值走势 + 回撤 */}
          {nav && (
            <>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="mb-2 text-xs font-medium text-zinc-300">
                  单位净值走势（月度，自成立）
                </div>
                <NavLineChart points={nav.monthly} />
                <div className="mt-1 text-[10px] text-zinc-500">
                  {nav.establishDate ? `自 ${nav.establishDate} 成立` : ""}
                  {nav.sinceInceptionPct != null && ` 累计 ${fmtPct(nav.sinceInceptionPct)}`}
                  {nav.annualizedSinceInceptionPct != null && `（年化约 ${nav.annualizedSinceInceptionPct.toFixed(1)}%）`}
                  {nav.y3Pct != null && `｜近3年 ${fmtPct(nav.y3Pct)}`}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="mb-2 text-xs font-medium text-zinc-300">回撤水下图（月度）</div>
                <DrawdownChart points={nav.monthly} />
                <div className="mt-1 text-[10px] text-zinc-500">
                  {nav.maxDrawdownPct != null && `历史最大回撤 ${nav.maxDrawdownPct.toFixed(1)}%`}
                </div>
              </div>
            </>
          )}

          {/* 指数估值表 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-2 text-xs font-medium text-zinc-300">
              好价格 · 指数估值（{data.fund.trackIndexName ?? "跟踪指数"}）
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-zinc-500">
                  <th className="py-1.5 text-left font-medium">指标</th>
                  <th className="py-1.5 text-right font-medium">当前值</th>
                  <th className="py-1.5 text-right font-medium">历史分位</th>
                  <th className="py-1.5 text-left font-medium">解读</th>
                </tr>
              </thead>
              <tbody>
                {valRows.map((r) => {
                  const v = valVerdict(r.pct);
                  return (
                    <tr key={r.name} className="border-t border-zinc-800">
                      <td className="py-1.5 text-zinc-300">{r.name}</td>
                      <td className="py-1.5 text-right font-mono text-zinc-200">
                        {r.pegMissing ? (
                          <span className="text-zinc-600">免费源暂无</span>
                        ) : r.cur != null ? (
                          `${r.cur.toFixed(2)}${r.unit}`
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-1.5 text-right font-mono text-zinc-400">
                        {r.pct != null ? `${r.pct.toFixed(0)}%` : "—"}
                      </td>
                      <td className={`py-1.5 ${v.cls}`}>
                        {r.pegMissing ? (
                          <span className="text-zinc-600">需 Wind / 分析师盈利预期</span>
                        ) : r.cur != null ? (
                          v.text
                        ) : (
                          "暂无数据"
                        )}
                        {r.name === "股息率" && r.cur != null && r.pct == null && r.cur >= 2 ? "（有吸引力）" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.fund.proxy && (
              <div className="mt-2 text-[10px] text-amber-400/80">
                估值分位为代理估算（该指数无真实历史分位数据源），仅供参考。
              </div>
            )}
          </div>

          {/* 同类规模对比 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-2 text-xs font-medium text-zinc-300">
              好匹配 · 同类产品规模对比（跟踪 {data.fund.trackIndexName ?? "同指数"}）
            </div>
            <PeerBarChart peers={data.peers ?? []} selfCode={data.code} />
            {data.peers == null && (
              <div className="mt-1 text-[10px] text-zinc-500">同类对比需查询同指数 ETF 列表（数据源偶发限流，暂不可用）。</div>
            )}
          </div>

          {/* 六维逐项评估 */}
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="text-xs font-medium text-zinc-300">六维逐项评估</div>
            {data.evaluation.dimensions.map((d) => {
              const color =
                d.score == null
                  ? "text-zinc-400"
                  : d.score >= 70
                  ? "text-emerald-400"
                  : d.score >= 50
                  ? "text-amber-400"
                  : "text-red-400";
              return (
                <div key={d.key} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-200">{d.label}</span>
                    <span className={`text-sm font-bold ${color}`}>
                      {d.score != null ? (d.score / 10).toFixed(0) : "—"}
                    </span>
                  </div>
                  <ScoreBar label="" score={d.score} />
                  {d.metrics.length > 0 ? (
                    d.metrics.map((m) => (
                      <p key={m.key} className="pl-1 text-[10px] text-zinc-500">
                        {m.label}：{m.note}
                      </p>
                    ))
                  ) : d.note ? (
                    <p className="pl-1 text-[10px] text-zinc-500">{d.note}</p>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* 综合结论与行动建议 */}
          <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-4">
            <div className="mb-1.5 text-xs font-medium text-orange-300">综合结论与行动建议</div>
            <p className="text-sm text-zinc-200">{data.evaluation.summary}</p>
            {data.evaluation.suggestions.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-zinc-400">
                {data.evaluation.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </div>

          {/* 风险提示 */}
          {data.evaluation.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="mb-1.5 text-xs font-medium text-amber-300">风险提示</div>
              <ul className="list-disc space-y-1 pl-5 text-[11px] text-amber-200/90">
                {data.evaluation.warnings
                  .filter((w) => !w.includes("数据缺失"))
                  .map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
              </ul>
              {data.evaluation.warnings.some((w) => w.includes("数据缺失")) && (
                <p className="mt-1 text-[10px] text-amber-200/70">
                  注：{data.evaluation.warnings.find((w) => w.includes("数据缺失"))}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <p className="mt-8 border-t border-zinc-800 pt-4 text-center text-[11px] text-zinc-600">
        本评估基于公开市场数据（东方财富 / 同花顺主升浪池），仅用于学习研究，不构成投资建议。市场有风险，交易需谨慎。
        <br />
        净值/回撤/同类规模来自东方财富公开数据；实际年化跟踪误差缺乏免费公开源，未纳入评分；缺失项按可得指标重新归一化权重。
      </p>
    </main>
  );
}

/** useSearchParams 需在 Suspense 边界内使用 */
export default function EtfEvaluatePage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-4xl px-4 py-8">
          <div className="h-8 w-64 animate-pulse rounded bg-zinc-800" />
          <div className="mt-6 h-28 animate-pulse rounded-xl bg-zinc-900/60" />
        </main>
      }
    >
      <EtfEvaluateInner />
    </Suspense>
  );
}
