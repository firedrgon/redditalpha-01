"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { QualityStatus } from "@/lib/db/company-quality-cache";

/** 评分等级 → 徽章配色（按质地等级语义着色，不套用涨跌红绿惯例） */
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
 * - 已打分（status.scored）→ 评分徽章（质地 59·中性），点击查看详情
 * - 未打分 / 无状态 → 「去打分」按钮，点击跳转去打分
 *
 * 受控组件：status 由父组件批量查询 CompanyQualityCache 后传入（替代旧 localStorage 方案）。
 */
export default function QualityScoreLink({
  ticker,
  status,
}: {
  ticker: string;
  status?: QualityStatus | null;
}) {
  const pathname = usePathname();
  const href = `/stock-quality?ticker=${encodeURIComponent(ticker)}&from=${encodeURIComponent(
    pathname || "/"
  )}`;

  if (status?.scored) {
    return (
      <Link
        href={href}
        className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-all hover:opacity-80 ${badgeClass(
          status.level ?? ""
        )}`}
        title={`公司质地 ${status.totalScore} 分（${status.level}）· 点击查看详情`}
      >
        质地 {status.totalScore}·{status.level}
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
