"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import CompanyQualityReport from "../components/CompanyQualityReport";
import type { CompanyQuality } from "@/lib/company-quality";

export default function StockQualityPage() {
  const [ticker, setTicker] = useState("002739");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CompanyQuality | null>(null);
  // 跳转来源页（from 参数），用于「返回」按钮精确回到热榜/收藏列表
  const [from, setFrom] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("from");
    setFrom(p && p.length > 1 ? p : null);
  }, []);

  async function run(code: string, refresh = false) {
    const t = code.trim();
    if (!/^\d{6}(\.(SH|SZ|BJ))?$/i.test(t)) {
      setError("请输入 A 股 6 位代码，如 002739 / 600519.SH");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url = `/api/company-quality?ticker=${encodeURIComponent(t)}${refresh ? "&refresh=1" : ""}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "请求失败");
        setData(null);
      } else {
        // 评分结果由 API 自动落库（CompanyQualityCache），列表徽章直接读，无需前端写入
        setData(json as CompanyQuality);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-gutter mx-auto max-w-3xl py-8">
      <Link
        href={from ?? "/"}
        className="inline-flex items-center gap-1 text-sm text-zinc-400 transition-colors hover:text-orange-400"
      >
        ← 返回
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-zinc-100">A 股公司质地打分</h1>
      <p className="mt-1 text-sm text-zinc-400">
        基于同花顺金融数据（fuyao API + 10jqka F10），按「七维质地框架」自动评分，输出格式与「公司质地打分」技能一致。
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run(ticker)}
          placeholder="A 股 6 位代码，如 002739"
          className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-orange-500"
        />
        <button
          onClick={() => run(ticker)}
          disabled={loading}
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-600 disabled:opacity-50"
        >
          {loading ? "打分中…" : "开始打分"}
        </button>
        <button
          onClick={() => run("002739")}
          className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
        >
          示例 002739
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-8 text-center text-sm text-zinc-400">正在拉取同花顺数据并评分…</div>
      )}

      {data && !loading && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>
              {(data as any).cached
                ? `已缓存分析 · ${new Date((data as any).evaluatedAt).toLocaleString("zh-CN")}`
                : "本次实时计算"}
            </span>
            <button
              onClick={() => run(data.ticker)}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-300 transition-all hover:border-orange-500/50 hover:text-orange-400"
              title="忽略缓存，重新抓取同花顺数据并评分"
            >
              重新分析
            </button>
          </div>
          <div className="mt-4">
            <CompanyQualityReport data={data} />
          </div>
        </>
      )}

      <p className="mt-8 text-center text-xs text-zinc-600">
        ⚠️ 本功能仅供研究与学习参考，不构成任何投资建议。市场有风险，投资需谨慎。
      </p>
    </main>
  );
}
