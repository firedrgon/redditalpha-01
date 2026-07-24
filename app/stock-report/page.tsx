"use client";

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "@/app/components/SiteHeader";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface ReportData {
  ticker: string;
  name?: string | null;
  price?: number | null;
  changePercent?: number | null;
  currency?: string;
  marketCap?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  targetMeanPrice?: number | null;
  recommendationMean?: number | null;
  industry?: string | null;
  technical?: { overall: string; oscillators: string; movingAverages: string } | null;
  notes?: string[];
}

interface ReportResp {
  ticker: string;
  report: string;
  data: ReportData;
  generatedAt: string;
}

const SIGNAL_LABELS: Record<string, string> = {
  strong_sell: "强烈卖出",
  sell: "卖出",
  neutral: "中立",
  buy: "买入",
  strong_buy: "强烈买入",
};

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtBig(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${fmt(n)}`;
}

function recLabel(mean: number | null | undefined): string {
  if (mean == null) return "—";
  if (mean <= 1.5) return "买入";
  if (mean <= 2.5) return "偏多";
  if (mean <= 3.5) return "中性";
  return "偏空";
}

// react-markdown 自定义样式（teal 风格，无需额外 typography 插件）
const mdComponents: Components = {
  h2: (props) => (
    <h2
      className="mb-3 mt-8 border-l-2 border-orange-500 pl-3 text-lg font-bold text-zinc-100"
      {...props}
    />
  ),
  h3: (props) => (
    <h3 className="mb-2 mt-5 text-base font-semibold text-zinc-200" {...props} />
  ),
  p: (props) => <p className="mb-3 leading-7 text-zinc-300" {...props} />,
  ul: (props) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 text-zinc-300" {...props} />
  ),
  ol: (props) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 text-zinc-300" {...props} />
  ),
  li: (props) => <li className="leading-7" {...props} />,
  strong: (props) => (
    <strong className="font-semibold text-zinc-100" {...props} />
  ),
  a: (props) => (
    <a
      className="text-orange-400 underline"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  table: (props) => (
    <div className="mb-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-zinc-200" {...props} />
  ),
  td: (props) => (
    <td className="border border-zinc-700 px-3 py-2 text-zinc-300" {...props} />
  ),
  blockquote: (props) => (
    <blockquote className="border-l-2 border-zinc-600 pl-3 text-zinc-400" {...props} />
  ),
};

export default function StockReportPage() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReportResp | null>(null);

  async function run() {
    const ticker = input.trim();
    if (!ticker) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/stock-report?ticker=${encodeURIComponent(ticker)}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "分析失败，请稍后重试");
        setResult(null);
      } else {
        setResult(json as ReportResp);
      }
    } catch {
      setError("网络错误，请稍后重试");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const d = result?.data;

  return (
    <>
      <SiteHeader />
      <main className="page-gutter py-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-2xl font-bold text-zinc-100">美股研报</h1>
          <p className="mt-1 text-sm text-zinc-400">
            基于 stockanalysis.com 实时数据 + TradingView 技术信号，由 AI 生成综合分析报告（仅美股）。
          </p>

          {/* 输入区 */}
          <div className="mt-6 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") run();
              }}
              placeholder="输入美股代码，如 AAPL / NVDA / CEG"
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-orange-500/50"
            />
            <button
              onClick={run}
              disabled={loading || !input.trim()}
              className="rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "生成中…" : "生成报告"}
            </button>
          </div>

          {/* 状态 */}
          {error && (
            <div className="mt-6 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {loading && (
            <div className="mt-6 flex items-center gap-3 text-sm text-zinc-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-orange-400" />
              正在抓取数据并生成报告（约 10–60 秒）…
            </div>
          )}

          {!loading && !error && !result && (
            <div className="mt-10 rounded-md border border-zinc-800 bg-zinc-900/50 px-6 py-12 text-center text-sm text-zinc-500">
              输入一只美股代码，点击「生成报告」即可获取综合分析。
            </div>
          )}

          {/* 结果 */}
          {result && d && (
            <div className="mt-8">
              {/* 摘要卡 */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-3">
                    <span className="text-xl font-bold text-zinc-100">
                      {d.ticker}
                    </span>
                    {d.name && (
                      <span className="text-sm text-zinc-400">{d.name}</span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="text-xl font-semibold text-zinc-100">
                      {fmt(d.price)}
                    </span>
                    <span
                      className={`ml-2 text-sm ${
                        (d.changePercent ?? 0) >= 0
                          ? "text-red-400"
                          : "text-green-400"
                      }`}
                    >
                      {(d.changePercent ?? 0) >= 0 ? "+" : ""}
                      {fmt(d.changePercent)}%
                    </span>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                  <Stat label="行业" value={d.industry || "—"} />
                  <Stat label="市值" value={fmtBig(d.marketCap)} />
                  <Stat
                    label="市盈率(TTM)"
                    value={d.trailingPE != null ? fmt(d.trailingPE) : "—"}
                  />
                  <Stat
                    label="前瞻 PE"
                    value={d.forwardPE != null ? fmt(d.forwardPE) : "—"}
                  />
                  <Stat
                    label="分析师目标价"
                    value={d.targetMeanPrice != null ? fmt(d.targetMeanPrice) : "—"}
                  />
                  <Stat label="分析师共识" value={recLabel(d.recommendationMean)} />
                  <Stat
                    label="技术信号"
                    value={
                      d.technical
                        ? SIGNAL_LABELS[d.technical.overall] || d.technical.overall
                        : "—"
                    }
                  />
                </div>

                {d.notes && d.notes.length > 0 && (
                  <div className="mt-4 space-y-1 text-xs text-zinc-500">
                    {d.notes.map((n, i) => (
                      <div key={i}>· {n}</div>
                    ))}
                  </div>
                )}
              </div>

              {/* 报告正文 */}
              <article className="mt-6">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {result.report}
                </ReactMarkdown>
              </article>

              <div className="mt-8 text-xs text-zinc-600">
                报告生成时间：{new Date(result.generatedAt).toLocaleString("zh-CN")}
                {" · "}
                <Link href="/hot" className="text-orange-400/80 hover:text-orange-400">
                  查看 A 股热榜
                </Link>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 font-medium text-zinc-200">{value}</div>
    </div>
  );
}
