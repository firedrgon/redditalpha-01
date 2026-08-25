import type { CompanyQuality, QualityDimension } from "@/lib/company-quality";

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

export default function CompanyQualityReport({ data }: { data: CompanyQuality }) {
  const dimByKey = Object.fromEntries(data.dimensions.map((d) => [d.key, d])) as Record<string, QualityDimension>;
  const v = data.valuation;

  return (
    <div className="mx-auto max-w-3xl">
      {/* 头部 */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center gap-2 text-orange-400">
          <span>🔖</span>
          <span className="text-sm font-semibold tracking-wide">公司质地打分</span>
          <span className="text-zinc-500">｜</span>
          <span className="text-zinc-100">
            {data.name}
            <span className="ml-1 text-xs text-zinc-500">{data.ticker}</span>
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-bold text-zinc-50">{data.totalScore}</span>
            <span className="text-lg text-zinc-500">/100</span>
          </div>
          <span
            className={`rounded-full border px-3 py-1 text-sm font-medium ${scoreColor(data.totalScore)}`}
          >
            等级：{data.level}
          </span>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-lg bg-zinc-800/40 px-3 py-2 text-sm text-zinc-200">
          <span>📝</span>
          <span>
            <span className="text-zinc-400">一句话结论：</span>
            {data.oneLiner}
          </span>
        </div>
      </div>

      {/* 五维卡片 */}
      <div className="mt-4 space-y-3">
        {DIMS.map(({ key, emoji }) => {
          const d = dimByKey[key];
          if (!d) return null;
          return (
            <div key={key} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{emoji}</span>
                  <span className="font-semibold text-zinc-100">{d.title}</span>
                  {d.dataLimited && (
                    <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-[10px] text-zinc-300">
                      数据有限·代理评估
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{d.level}</span>
                  <span
                    className={`min-w-[3rem] rounded-lg border px-2 py-1 text-center text-sm font-bold ${scoreColor(d.score)}`}
                  >
                    {d.score}
                  </span>
                </div>
              </div>
              <ul className="mt-2 space-y-1 text-sm text-zinc-300">
                {d.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-zinc-600">•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* 主要扣分项 */}
      <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-2 flex items-center gap-2 font-semibold text-zinc-100">
          <span className="text-lg">6️⃣</span>
          <span>主要扣分项</span>
        </div>
        <ul className="space-y-1 text-sm text-zinc-300">
          {data.deductions.map((d, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-red-400/70">•</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 估值 / 好公司≠好股票 */}
      <div className="mt-3 rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4">
        <div className="mb-2 flex items-center gap-2 font-semibold text-orange-300">
          <span>⚠️</span>
          <span>好公司 ≠ 好股票</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-zinc-300 sm:grid-cols-3">
          <div>现价：<span className="text-zinc-100">{fmt(v.price)}</span>{v.changePct != null && <span dangerouslySetInnerHTML={{ __html: fmtChange(v.changePct) }} />}</div>
          <div>PE(静)：<span className="text-zinc-100">{fmt(v.peStatic)}</span></div>
          <div>PB：<span className="text-zinc-100">{fmt(v.pb)}</span></div>
          <div>股息率：<span className="text-zinc-100">{fmtPct(v.dividendYield)}</span></div>
          <div>总市值：<span className="text-zinc-100">{fmtYi(v.marketCap)}</span></div>
          <div>PB 历史分位：<span className="text-zinc-100">{v.pbPercentile == null ? "—" : `${v.pbPercentile}%`}</span></div>
        </div>
        <p className="mt-3 text-sm text-orange-200/90">{v.verdict}</p>
      </div>

      {/* 脚注 */}
      <div className="mt-3 text-center text-xs text-zinc-500">
        数据来源：{data.dataSource} ｜ 抓取时间：{new Date(data.fetchedAt).toLocaleString("zh-CN")}
        {data.warnings.length > 0 && (
          <div className="mt-1 text-amber-500/80">提示：{data.warnings.join("；")}</div>
        )}
        <div className="mt-1 text-zinc-600">⚠️ 质地评估仅供参考，不构成投资建议。</div>
      </div>
    </div>
  );
}
