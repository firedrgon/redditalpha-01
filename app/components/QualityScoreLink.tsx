"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getQualityScore,
  QUALITY_SCORES_EVENT,
  type QualityScoreEntry,
} from "@/lib/quality-store";

/** 评分等级 → 徽章配色（涨红跌绿惯例不适用，这里按质地等级语义着色） */
function badgeClass(level: string): string {
  switch (level) {
    case "优质":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
    case "良好":
      return "border-lime-500/40 bg-lime-500/15 text-lime-300";
    case "中性":
      return "border-sky-500/40 bg-sky-500/15 text-sky-300";
    default:
      return "border-red-500/40 bg-red-500/15 text-red-300";
  }
}

/**
 * 在 A股热榜 / 收藏卡片上展示「公司质地打分」入口：
 * - 已打分 → 评分徽章（质地 59·中性），点击查看详情
 * - 未打分 → 「去打分」按钮，点击跳转去打分
 * 自包含：自行从 localStorage 读取 + 监听更新事件，父组件只需传 ticker。
 */
export default function QualityScoreLink({ ticker }: { ticker: string }) {
  const [entry, setEntry] = useState<QualityScoreEntry | null>(null);

  useEffect(() => {
    const sync = () => setEntry(getQualityScore(ticker));
    sync();
    window.addEventListener(QUALITY_SCORES_EVENT, sync);
    return () => window.removeEventListener(QUALITY_SCORES_EVENT, sync);
  }, [ticker]);

  const href = `/stock-quality?ticker=${encodeURIComponent(ticker)}`;

  if (entry) {
    return (
      <Link
        href={href}
        className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80 ${badgeClass(
          entry.level
        )}`}
        title={`公司质地 ${entry.totalScore} 分（${entry.level}）· 点击查看详情`}
      >
        质地 {entry.totalScore}·{entry.level}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
      title="对公司做质地打分"
    >
      去打分
    </Link>
  );
}
