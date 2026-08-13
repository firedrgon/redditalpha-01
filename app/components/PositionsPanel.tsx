"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface PositionRow {
  id: string;
  ticker: string;
  tickerName: string | null;
  status: string;
  assetType: string;
  currency: string;
  entryPrice: number;
  entryAt: string;
  shares: number;
  capital: number;
  exitPrice: number | null;
  exitAt: string | null;
  holdDays: number | null;
  pnl: number | null;
  pnlPct: number | null;
  currentPrice?: number | null;
  unrealizedPnl?: number | null;
  unrealizedPnlPct?: number | null;
}

interface Summary {
  invested: number;
  currentValue: number;
  unrealized: number;
  realized: number;
  winRate: number;
  openCount: number;
  closedCount: number;
}

const isCN = (t: string) => /^\d{6}\.(SH|SZ)$/.test(t);

/** 外部跳转链接（复用 app/page.tsx 的口径）：A 股→东财，美股→富途 */
function extUrl(t: string): string {
  if (isCN(t)) {
    const m = t.match(/^(\d{6})\.(SH|SZ)$/);
    if (!m) return "#";
    const prefix = m[2] === "SH" ? "sh" : "sz";
    return `https://quote.eastmoney.com/${prefix}${m[1]}.html`;
  }
  return `https://www.futunn.com/stock/${t}-US`;
}

/** 按持仓币种返回符号：CNY→¥，USD→$，空→无符号（汇总跨币种时不显示统一符号） */
const moneySymbol = (cur?: string | null) =>
  cur === "CNY" ? "¥" : cur === "USD" ? "$" : "";

const fmtMoney = (n: number | null | undefined, cur = "") =>
  n == null || Number.isNaN(n)
    ? "—"
    : `${moneySymbol(cur)}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const fmtPct = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

/** 涨红跌绿（A 股惯例）：正=红，负=绿 */
const pnlClass = (n: number | null | undefined) =>
  n == null || Number.isNaN(n)
    ? "text-zinc-400"
    : n >= 0
      ? "text-red-400"
      : "text-green-400";

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("zh-CN") : "—";

export default function PositionsPanel({
  onAnalyze,
}: {
  /** 打开首页同款的 AI 分析弹窗（按 ticker 触发，无需该标的已收藏） */
  onAnalyze?: (ticker: string, name?: string | null) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<PositionRow[]>([]);
  const [closed, setClosed] = useState<PositionRow[]>([]);
  const [summary, setSummary] = useState<Summary>({
    invested: 0,
    currentValue: 0,
    unrealized: 0,
    realized: 0,
    winRate: 0,
    openCount: 0,
    closedCount: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/positions");
      if (!res.ok) throw new Error("load failed");
      const d = await res.json();
      setOpen(d.open ?? []);
      setClosed(d.closed ?? []);
      setSummary(d.summary ?? summary);
    } catch {
      /* 保留旧数据 */
    } finally {
      setLoading(false);
    }
  }, [summary]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000); // 每分钟刷新现价/未实现盈亏
    return () => clearInterval(t);
  }, [load]);

  /** 行内操作：打开 AI 分析弹窗 / 跳转研报页面 */
  const renderActions = (ticker: string, name?: string | null) => (
    <div className="flex items-center justify-end gap-1.5">
      <button
        type="button"
        onClick={() => onAnalyze?.(ticker, name)}
        className="shrink-0 rounded-md border border-orange-500/40 bg-orange-500/10 px-2.5 py-1 text-xs font-medium text-orange-400 transition-all hover:bg-orange-500/20"
        title="打开 AI 分析（指标 + 大模型点评）"
      >
        分析
      </button>
      <Link
        href={`/stock-report?ticker=${encodeURIComponent(ticker)}`}
        className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
        title="打开研报页面"
      >
        研报
      </Link>
    </div>
  );

  const cards = [
    { label: "总投入", value: fmtMoney(summary.invested), cls: "text-zinc-100" },
    { label: "当前市值", value: fmtMoney(summary.currentValue), cls: "text-zinc-100" },
    {
      label: "未实现盈亏",
      value: fmtMoney(summary.unrealized),
      cls: pnlClass(summary.unrealized),
    },
    {
      label: "已实现盈亏",
      value: fmtMoney(summary.realized),
      cls: pnlClass(summary.realized),
    },
    {
      label: "胜率",
      value: summary.closedCount ? `${summary.winRate.toFixed(1)}%` : "—",
      cls: "text-zinc-100",
    },
    {
      label: "持仓 / 平仓",
      value: `${summary.openCount} / ${summary.closedCount}`,
      cls: "text-zinc-100",
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">模拟持仓</h2>
          <p className="mt-1 text-sm text-zinc-500">
            买入信号自动建仓、卖出信号自动平仓 · 纯模拟，不涉及真实交易
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-all hover:border-orange-500/40 hover:text-orange-400 disabled:opacity-50"
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {/* 汇总卡 */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
          >
            <div className="text-xs text-zinc-500">{c.label}</div>
            <div className={`mt-1 text-lg font-bold ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* 当前持仓 */}
      <h3 className="mb-3 text-sm font-semibold text-zinc-300">
        当前持仓（{open.length}）
      </h3>
      {open.length === 0 ? (
        <div className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 text-center text-sm text-zinc-500">
          暂无持仓。当某个收藏标的出现买入信号时会自动建仓。
        </div>
      ) : (
        <div className="mb-8 overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">标的</th>
                <th className="px-4 py-2.5 text-right font-medium">开仓价</th>
                <th className="px-4 py-2.5 text-right font-medium">现价</th>
                <th className="px-4 py-2.5 text-right font-medium">股数</th>
                <th className="px-4 py-2.5 text-right font-medium">投入</th>
                <th className="px-4 py-2.5 text-right font-medium">未实现盈亏</th>
                <th className="px-4 py-2.5 text-right font-medium">盈亏%</th>
                <th className="px-4 py-2.5 text-right font-medium">持仓天数</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {open.map((o) => (
                <tr
                  key={o.id}
                  className="border-t border-zinc-800 transition-colors hover:bg-zinc-800/40"
                >
                  <td className="px-4 py-3">
                    <a
                      href={extUrl(o.ticker)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-white hover:text-orange-400"
                    >
                      {o.ticker}
                    </a>
                    {o.tickerName && (
                      <div className="text-xs text-zinc-500">{o.tickerName}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-300">
                    {fmtMoney(o.entryPrice, o.currency)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-300">
                    {o.currentPrice == null ? "—" : fmtMoney(o.currentPrice, o.currency)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-300">
                    {o.shares.toFixed(4)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-300">
                    {fmtMoney(o.capital, o.currency)}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${pnlClass(o.unrealizedPnl)}`}>
                    {fmtMoney(o.unrealizedPnl, o.currency)}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${pnlClass(o.unrealizedPnlPct)}`}>
                    {fmtPct(o.unrealizedPnlPct)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-400">
                    {Math.floor(
                      (Date.now() - new Date(o.entryAt).getTime()) / 86_400_000
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {renderActions(o.ticker, o.tickerName)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 历史成交 */}
      <h3 className="mb-3 text-sm font-semibold text-zinc-300">
        历史成交（{closed.length}）
      </h3>
      {closed.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 text-center text-sm text-zinc-500">
          暂无平仓记录。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[940px] text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">标的</th>
                <th className="px-4 py-2.5 text-right font-medium">开仓价</th>
                <th className="px-4 py-2.5 text-right font-medium">平仓价</th>
                <th className="px-4 py-2.5 text-right font-medium">盈亏%</th>
                <th className="px-4 py-2.5 text-right font-medium">盈亏金额</th>
                <th className="px-4 py-2.5 text-right font-medium">持有天数</th>
                <th className="px-4 py-2.5 text-right font-medium">平仓日期</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-zinc-800 transition-colors hover:bg-zinc-800/40"
                >
                  <td className="px-4 py-3">
                    <a
                      href={extUrl(c.ticker)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-white hover:text-orange-400"
                    >
                      {c.ticker}
                    </a>
                    {c.tickerName && (
                      <div className="text-xs text-zinc-500">{c.tickerName}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-300">
                    {fmtMoney(c.entryPrice, c.currency)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-300">
                    {c.exitPrice == null ? "—" : fmtMoney(c.exitPrice, c.currency)}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${pnlClass(c.pnlPct)}`}>
                    {fmtPct(c.pnlPct)}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${pnlClass(c.pnl)}`}>
                    {fmtMoney(c.pnl, c.currency)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-400">
                    {c.holdDays ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-zinc-400">
                    {fmtDate(c.exitAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {renderActions(c.ticker, c.tickerName)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
