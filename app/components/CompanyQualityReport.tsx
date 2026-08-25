import type { CompanyQuality, QualityDimension, MainBusinessItem } from "@/lib/company-quality";

function scoreColor(score: number): string {
  if (score >= 85) return "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
  if (score >= 70) return "text-sky-400 bg-sky-500/10 border-sky-500/30";
  if (score >= 55) return "text-amber-400 bg-amber-500/10 border-amber-500/30";
  return "text-red-400 bg-red-500/10 border-red-500/30";
}

const DIMS: { key: string; emoji: string }[] = [
  { key: "business", emoji: "1️⃣" },
  { key: "industry", emoji: "2️⃣" },
  { key: "growth", emoji: "3️⃣" },
  { key: "finance", emoji: "4️⃣" },
  { key: "governance", emoji: "5️⃣" },
];

function fmt(n: number | null, digits = 2): string {
  return n == null ? "—" : n.toFixed(digits);
}
function fmtPct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(2)}%`;
}
function fmtYi(n: number | null): string {
  return n == null ? "—" : `${(n / 1e8).toFixed(2)} 亿元`;
}
function fmtChange(n: number | null): string {
  if (n == null) return "";
  const c = n >= 0 ? "text-emerald-400" : "text-red-400";
  return ` <span class="${c}">${n >= 0 ? "+" : ""}${n.toFixed(2)}%</span>`;
}

function MainBizTable({ title, items }: { title: string; items: MainBusinessItem[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-xs font-medium text-zinc-400">{title}</div>
      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800/40 text-[11px] text-zinc-500">
            <tr>
              <th className="px-3 py-1.5 text-left font-normal">名称</th>
              <th className="px-3 py-1.5 text-right font-normal">收入</th>
              <th className="px-3 py-1.5 text-right font-normal">占比</th>
              <th className="px-3 py-1.5 text-right font-normal">毛利率</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {items.map((it, i) => (
              <tr key={i} className="border-t border-zinc-800">
                <td className="max-w-[180px] truncate px-3 py-1.5" title={it.name}>
                  {it.name}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtYi(it.income)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {it.ratio == null ? "—" : `${it.ratio.toFixed(1)}%`}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {it.grossMargin == null ? "—" : `${it.grossMargin.toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CompanyQualityReport({ data }: { data: CompanyQuality }) {
  const dimByKey = Object.fromEntries(data.dimensions.map((d) => [d.key, d])) as Record<string, QualityDimension>;
  const v = data.valuation;

  const valuationRows: { label: string; value: string }[] = [
    { label: "现价", value: `${fmt(v.price)}${v.changePct != null ? (n => (n >= 0 ? ` +${n.toFixed(2)}%` : ` ${n.toFixed(2)}%`))(v.changePct) : ""}` },
    { label: "PE(静)", value: fmt(v.peStatic) },
    { label: "PB", value: fmt(v.pb) },
    { label: "股息率", value: fmtPct(v.dividendYield) },
    { label: "总市值", value: fmtYi(v.marketCap) },
    { label: "PB 历史分位", value: v.pbPercentile == null ? "—" : `${v.pbPercentile}%` },
  ];

  return (
    <div className="w-full space-y-4">
      {/* 头部卡片 */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-orange-400">
            <span>🔖</span>
            <span className="text-sm font-semibold tracking-wide">公司质地打分</span>
          </div>
          <div className="flex items-baseline gap-2 text-right">
            <span className="text-base font-semibold text-zinc-100">{data.name}</span>
            <span className="text-xs text-zinc-500">{data.ticker}</span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-5xl font-bold leading-none text-zinc-50">{data.totalScore}</span>
            <span className="text-base text-zinc-500">/ 100</span>
          </div>
          <span
            className={`rounded-full border px-3 py-1 text-sm font-medium ${scoreColor(data.totalScore)}`}
          >
            等级：{data.level}
          </span>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-lg bg-zinc-800/40 px-3 py-2 text-sm text-zinc-200">
          <span className="mt-0.5 shrink-0">📝</span>
          <span>
            <span className="text-zinc-400">一句话结论：</span>
            {data.oneLiner}
          </span>
        </div>
      </div>

      {/* 五维卡片：2 列网格 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {DIMS.map(({ key, emoji }) => {
          const d = dimByKey[key];
          if (!d) return null;
          return (
            <div key={key} className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-lg">{emoji}</span>
                  <span className="font-semibold text-zinc-100">{d.title}</span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[11px] text-zinc-500">{d.level}</span>
                  <span
                    className={`rounded-lg border px-2.5 py-0.5 text-center text-sm font-bold ${scoreColor(d.score)}`}
                  >
                    {d.score}
                  </span>
                </div>
              </div>
              <ul className="mt-2 space-y-1 text-sm text-zinc-300">
                {d.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-zinc-600">•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              {d.dataLimited && (
                <span className="mt-2 self-start rounded bg-zinc-700/60 px-1.5 py-0.5 text-[10px] text-zinc-300">
                  数据有限·代理评估
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* 主营构成（东方财富 F10） */}
      {data.mainBusiness &&
        (data.mainBusiness.byProduct.length > 0 ||
          data.mainBusiness.byIndustry.length > 0 ||
          data.mainBusiness.byArea.length > 0) && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="mb-3 flex items-center gap-2 font-semibold text-zinc-100">
              <span className="text-lg">🏭</span>
              <span>主营构成</span>
              <span className="text-xs font-normal text-zinc-500">
                东方财富 F10 · {data.mainBusiness.reportDate.slice(0, 10)}
              </span>
            </div>
            <MainBizTable title="按产品" items={data.mainBusiness.byProduct} />
            <MainBizTable title="按行业" items={data.mainBusiness.byIndustry} />
            <MainBizTable title="按地区" items={data.mainBusiness.byArea} />
          </div>
        )}

      {/* 主要扣分项 */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-2 flex items-center gap-2 font-semibold text-zinc-100">
          <span className="text-lg">6️⃣</span>
          <span>主要扣分项</span>
        </div>
        <ul className="space-y-1 text-sm text-zinc-300">
          {data.deductions.map((d, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 text-red-400/70">•</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 估值 / 好公司≠好股票 */}
      <div className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4">
        <div className="mb-3 flex items-center gap-2 font-semibold text-orange-300">
          <span>⚠️</span>
          <span>好公司 ≠ 好股票</span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {valuationRows.map((r) => (
            <div key={r.label} className="flex items-baseline gap-2">
              <span className="shrink-0 text-zinc-500">{r.label}</span>
              <span className="min-w-0 truncate text-zinc-100">{r.value}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-sm text-orange-200/90">{v.verdict}</p>
      </div>

      {/* 脚注 */}
      <div className="text-center text-xs text-zinc-500">
        数据来源：{data.dataSource} ｜ 抓取时间：{new Date(data.fetchedAt).toLocaleString("zh-CN")}
        {data.warnings.length > 0 && (
          <div className="mt-1 text-amber-500/80">提示：{data.warnings.join("；")}</div>
        )}
        <div className="mt-1 text-zinc-600">⚠️ 质地评估仅供参考，不构成投资建议。</div>
      </div>
    </div>
  );
}
