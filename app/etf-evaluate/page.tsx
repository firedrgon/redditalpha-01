"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { EtfSkillEvaluation, EtfGoal } from "@/lib/etf-skill-evaluate";

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

/** 把 URL 里的 goal 参数收敛为合法 EtfGoal（非法值 → null，不报错） */
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
    indexType: string | null;
    proxy: boolean;
  };
  evaluation: EtfSkillEvaluation;
}

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
      <span className="w-14 shrink-0 font-medium text-zinc-300">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full rounded ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-zinc-300">
        {score != null ? score.toFixed(0) : "—"}
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
      <span className="font-mono">{score != null ? score.toFixed(0) : "—"}</span>
    </span>
  );
}

function EtfEvaluateInner() {
  const searchParams = useSearchParams();

  // 从 URL 直接初始化（而非在 effect 里 setState），避免级联渲染
  const urlCode = (searchParams.get("code") ?? "").trim();
  const urlGoal = parseGoal(searchParams.get("goal"));
  const hasUrlCode = /^\d{6}$/.test(urlCode);

  const [code, setCode] = useState(hasUrlCode ? urlCode : "");
  const [goal, setGoal] = useState<EtfGoal>(urlGoal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResp | null>(null);

  /** 以显式参数执行评估（供手动点击与 URL 自动评估复用） */
  const runWith = useCallback(async (rawCode: string, g: EtfGoal) => {
    const c = rawCode.trim();
    if (!/^\d{6}$/.test(c)) {
      setError("请输入 6 位 ETF 代码（如 510300）");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url = `/api/etf-evaluate?code=${c}${g ? `&goal=${g}` : ""}`;
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

  /**
   * 带 ?code= 进入时自动评估一次：/etf-evaluate?code=510300&goal=growth
   * 主升浪卡片的「深度评估」按钮走这条路径，点进来直接出结果。
   * ref 保证只跑一次，用户随后手动改代码不会被 URL 覆盖。
   */
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !hasUrlCode) return;
    autoRan.current = true;
    void runWith(urlCode, urlGoal);
  }, [hasUrlCode, urlCode, urlGoal, runWith]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-2 flex items-center gap-2">
        <Link
          href="/"
          className="text-xs text-zinc-500 transition-colors hover:text-orange-400"
        >
          ← 返回首页
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-white">ETF 产品智能评估</h1>
      <p className="mt-2 text-sm text-zinc-500">
        对齐「ETF产品智能评估」框架：
        <span className="text-zinc-400">
          好资产 × 好价格 × 好运营 × 好时机 × 好匹配 × 好成本
        </span>
        。输入 ETF 代码与投资目标，获取 6 维分项评估与综合配置建议。
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
          {/* 综合评级卡 */}
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <GradeBadge
              grade={data.evaluation.grade}
              score={data.evaluation.totalScore}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-lg font-bold text-white">
                {data.name ?? "未知"}
                <span className="font-mono text-sm text-zinc-500">{data.code}</span>
              </div>
              <p className="mt-0.5 text-xs text-zinc-400">{data.evaluation.summary}</p>
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
          </div>

          {/* 基金信息 */}
          <div className="flex flex-wrap gap-2 text-[10px]">
            {data.fund.trackIndexName && (
              <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">
                跟踪：{data.fund.trackIndexName}
              </span>
            )}
            {data.fund.fundCompany && (
              <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">
                公司：{data.fund.fundCompany}
              </span>
            )}
            {data.fund.fundManager && (
              <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">
                经理：{data.fund.fundManager}
              </span>
            )}
            {data.fund.establishDate && (
              <span className="rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 text-zinc-400">
                成立：{data.fund.establishDate}
              </span>
            )}
            {data.fund.proxy && (
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-400">
                估值分位为估算（无真实历史数据）
              </span>
            )}
          </div>

          {/* 6 维进度条 + 明细 */}
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="text-xs font-medium text-zinc-300">六维评估</div>
            {data.evaluation.dimensions.map((d) => (
              <div key={d.key} className="space-y-1">
                <ScoreBar label={d.label} score={d.score} />
                {d.metrics.map((m) => (
                  <p key={m.key} className="pl-16 text-[10px] text-zinc-500">
                    {m.label}：{m.note}
                  </p>
                ))}
                {d.note && d.metrics.length === 0 && (
                  <p className="pl-16 text-[10px] text-zinc-500">{d.note}</p>
                )}
              </div>
            ))}
          </div>

          {/* 风险预警 */}
          {data.evaluation.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="mb-1.5 text-xs font-medium text-amber-300">风险提示</div>
              <ul className="list-disc space-y-1 pl-5 text-[11px] text-amber-200/90">
                {data.evaluation.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 配置建议 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-1.5 text-xs font-medium text-zinc-300">配置建议</div>
            <ul className="list-disc space-y-1 pl-5 text-[11px] text-zinc-400">
              {data.evaluation.suggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <p className="mt-8 border-t border-zinc-800 pt-4 text-center text-[11px] text-zinc-600">
        本评估基于公开市场数据（东方财富 / 同花顺主升浪池），仅用于学习研究，不构成投资建议。市场有风险，交易需谨慎。
        <br />
        说明：实际年化跟踪误差缺乏免费公开数据源，未纳入「好成本」评分；缺失指标不按满分处理，
        而是按可得指标重新归一化权重。
      </p>
    </main>
  );
}

/** useSearchParams 需在 Suspense 边界内使用（Next.js App Router 静态渲染要求） */
export default function EtfEvaluatePage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl px-4 py-8">
          <div className="h-8 w-64 animate-pulse rounded bg-zinc-800" />
          <div className="mt-6 h-28 animate-pulse rounded-xl bg-zinc-900/60" />
        </main>
      }
    >
      <EtfEvaluateInner />
    </Suspense>
  );
}
