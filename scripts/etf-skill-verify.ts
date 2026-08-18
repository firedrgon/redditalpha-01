/**
 * ETF 6 维评估「非估值字段」交叉验证脚本
 *
 * 背景：scripts/etf-valuation-verify.ts 只验证了估值维度（PE/PB/分位）。
 * 本脚本补上其余维度的交叉验证 —— 好运营（公司/经理/成立日）、好成本（费率/规模/
 * 成交额）、好资产（跟踪指数）—— 这些此前是**东方财富单一来源、从未被第二源校验**。
 *
 * 主源（生产引擎实际使用）：
 *   - 东方财富 jbgk_{code}.html   → 费率 / 跟踪标的 / 基金公司 / 经理 / 成立日
 *   - 东方财富 push2              → 规模 f116 / 成交额 f185
 *
 * 第二源（本脚本引入，用于对照）：
 *   - 同花顺 fund.10jqka.com.cn/data/client/myfund/{code}  【真正独立厂商】
 *       manager(经理) / orgname(公司) / clrq(成立日) / asset(资产亿) / name(简称)
 *   - 腾讯 qt.gtimg.cn                                     【真正独立厂商】
 *       成交额(万) / 总市值(亿)
 *   - 东方财富 jjfl_{code}.html（费率专页）                 【同厂异页，验解析而非验源】
 *       管理费率 / 托管费率
 *
 * 判定口径（差异容忍度按字段性质设定，不搞"一刀切"）：
 *   - 公司名：归一化去后缀后做包含匹配（「华泰柏瑞基金」vs 全称不算错）
 *   - 基金经理：按人名集合「有交集」判定 —— ETF 多为多人共管，各源展示的主经理
 *     不一定是同一位（东财「成曦、刘树荣」vs 同花顺「刘树荣等」），无交集才是真冲突
 *   - 费率：绝对差 ≤ 0.001 个百分点视为一致（同一披露值）
 *   - 成交额：相对差 ≤ 5%（不同源快照时点略有差异）
 *   - 规模：≤20% 一致 / 20~50% 记「口径差异」/ >50% 才算冲突。因东财 f116 是
 *     实时份额×现价，同花顺 asset 是季报资产净值，口径与时点均不同
 *
 * 运行：npx tsx scripts/etf-skill-verify.ts
 * 注：依赖外网 best-effort；沙箱 IP 可能被限流，取不到的项标「限流」而非算作不一致。
 */

import { fetchEtfFundData, type EtfBoard } from "../lib/etf-fund-data";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

interface EtfSpec {
  code: string;
  board: EtfBoard;
  label: string;
}

/** 覆盖宽基 / 行业 / 科创 / 深市，避免只测一只造成"样本幸存者偏差" */
const SAMPLES: EtfSpec[] = [
  { code: "510300", board: "SH", label: "沪深300ETF" },
  { code: "512880", board: "SH", label: "证券ETF" },
  { code: "159915", board: "SZ", label: "创业板ETF" },
  { code: "588000", board: "SH", label: "科创50ETF" },
  { code: "510500", board: "SH", label: "中证500ETF" },
];

async function getText(
  url: string,
  referer: string,
  decode = "utf-8"
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return new TextDecoder(decode).decode(buf);
  } catch {
    return null;
  }
}

// ============================================================
// 第二源 1：同花顺 myfund（独立厂商）
// ============================================================

interface ThsFund {
  name: string | null;
  manager: string | null;
  orgname: string | null;
  clrq: string | null;
  assetYi: number | null;
}

async function fetchThsFund(code: string): Promise<ThsFund | null> {
  const txt = await getText(
    `https://fund.10jqka.com.cn/data/client/myfund/${code}`,
    "https://fund.10jqka.com.cn/"
  );
  if (!txt) return null;
  try {
    const j = JSON.parse(txt) as {
      data?: Array<Record<string, unknown>>;
    };
    const d = j.data?.[0];
    if (!d) return null;
    const s = (k: string): string | null => {
      const v = d[k];
      return typeof v === "string" && v.trim() && v !== "--" ? v.trim() : null;
    };
    const asset = s("asset");
    return {
      name: s("name"),
      manager: s("manager"),
      orgname: s("orgname"),
      clrq: s("clrq"),
      assetYi: asset != null && Number.isFinite(parseFloat(asset)) ? parseFloat(asset) : null,
    };
  } catch {
    return null;
  }
}

// ============================================================
// 第二源 2：腾讯 gtimg（独立厂商）—— 成交额 / 总市值
// ============================================================

async function fetchQqEtf(
  code: string,
  board: EtfBoard
): Promise<{ turnoverWan: number | null; mktCapYi: number | null } | null> {
  const prefix = board === "SZ" ? "sz" : "sh";
  const txt = await getText(`https://qt.gtimg.cn/q=${prefix}${code}`, "https://gu.qq.com/", "gbk");
  if (!txt) return null;
  const m = txt.match(/="(.+)"/);
  if (!m) return null;
  const p = m[1].split("~");
  const f = (i: number): number | null => {
    const v = parseFloat(p[i]);
    return Number.isFinite(v) ? v : null;
  };
  return { turnoverWan: f(37), mktCapYi: f(45) };
}

// ============================================================
// 第二源 3：东财费率专页（同厂异页，验「解析」正确性）
// ============================================================

async function fetchEmFeePage(
  code: string
): Promise<{ mgmt: number | null; custody: number | null } | null> {
  const html = await getText(
    `https://fundf10.eastmoney.com/jjfl_${code}.html`,
    "https://fundf10.eastmoney.com/"
  );
  if (!html) return null;
  const t = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const pick = (re: RegExp): number | null => {
    const mm = t.match(re);
    if (!mm) return null;
    const v = parseFloat(mm[1]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    mgmt: pick(/管理费率\s*([\d.]+)\s*%/),
    custody: pick(/托管费率\s*([\d.]+)\s*%/),
  };
}

// ============================================================
// 比较工具
// ============================================================

/** 文本归一化：去公司后缀/空白/括号，便于「简称 vs 全称」比较 */
function normName(s: string | null): string {
  if (!s) return "";
  return s
    .replace(/基金管理有限公司|基金管理股份有限公司|基金管理公司|基金/g, "")
    .replace(/[()（）\s·]/g, "")
    .trim();
}

type Verdict = "一致" | "不一致" | "缺失" | "口径差异";

function cmpText(a: string | null, b: string | null): Verdict {
  if (!a || !b) return "缺失";
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return "缺失";
  return na === nb || na.includes(nb) || nb.includes(na) ? "一致" : "不一致";
}

/**
 * 基金经理比对：ETF 常由多位经理共管（东财原文「成曦 、 刘树荣」），
 * 而各数据源展示的「主经理」不一定是同一位（同花顺常显示「刘树荣等」）。
 * 因此按「人名集合是否有交集」判定，而非要求字符串完全相同 —— 无交集才是真冲突。
 */
function cmpManagers(a: string | null, b: string | null): Verdict {
  if (!a || !b) return "缺失";
  const split = (s: string) =>
    s
      .replace(/等$/g, "")
      .split(/[、,，\/]/)
      .map((x) => x.replace(/[\s·]/g, "").trim())
      .filter((x) => x.length >= 2);
  const sa = split(a);
  const sb = split(b);
  if (!sa.length || !sb.length) return "缺失";
  return sa.some((x) => sb.includes(x)) ? "一致" : "不一致";
}

function cmpNum(
  a: number | null,
  b: number | null,
  opts: { abs?: number; relPct?: number }
): Verdict {
  if (a == null || b == null) return "缺失";
  if (opts.abs != null && Math.abs(a - b) <= opts.abs) return "一致";
  if (opts.relPct != null && b !== 0) {
    const rel = Math.abs((a - b) / b) * 100;
    if (rel <= opts.relPct) return "一致";
  }
  return "不一致";
}

const mark = (v: Verdict) =>
  v === "一致" ? "✓" : v === "不一致" ? "✗" : v === "口径差异" ? "≈" : "—";

/**
 * 规模比对：东财 f116 = 实时份额 × 现价（场内总市值，实时）；
 * 同花顺 asset = 资产净值（季报口径，jbgk 页明示「截止至 2026-06-30」）。
 * 两者本质不同口径 + 不同时点，ETF 又常有大额申赎，差 20~40% 属正常。
 * 故只校验「数量级一致」：≤20% 记一致，20~50% 记口径差异，>50% 才算真冲突。
 */
function cmpScale(a: number | null, b: number | null): Verdict {
  if (a == null || b == null) return "缺失";
  if (b === 0) return "缺失";
  const rel = Math.abs((a - b) / b) * 100;
  if (rel <= 20) return "一致";
  if (rel <= 50) return "口径差异";
  return "不一致";
}

function bar(title: string) {
  console.log("\n" + "═".repeat(84));
  console.log(title);
  console.log("═".repeat(84));
}

interface Row {
  field: string;
  main: string;
  second: string;
  src: string;
  verdict: Verdict;
}

async function verifyOne(spec: EtfSpec): Promise<Row[]> {
  const [main, ths, qq, emFee] = await Promise.all([
    fetchEtfFundData(spec.code, spec.board).catch(() => null),
    fetchThsFund(spec.code).catch(() => null),
    fetchQqEtf(spec.code, spec.board).catch(() => null),
    fetchEmFeePage(spec.code).catch(() => null),
  ]);

  const r = main?.raw;
  const rows: Row[] = [];
  const push = (
    field: string,
    mainVal: unknown,
    secondVal: unknown,
    src: string,
    verdict: Verdict
  ) =>
    rows.push({
      field,
      main: mainVal == null ? "—" : String(mainVal),
      second: secondVal == null ? "—" : String(secondVal),
      src,
      verdict,
    });

  // 好运营：公司 / 经理 / 成立日 —— 同花顺（真独立源）
  push("基金公司", r?.fundCompany, ths?.orgname, "同花顺", cmpText(r?.fundCompany ?? null, ths?.orgname ?? null));
  push("基金经理", r?.fundManager, ths?.manager, "同花顺", cmpManagers(r?.fundManager ?? null, ths?.manager ?? null));
  push("成立日期", r?.establishDate, ths?.clrq, "同花顺",
    r?.establishDate && ths?.clrq ? (r.establishDate === ths.clrq ? "一致" : "不一致") : "缺失");

  // 好成本：费率 —— 东财费率专页（验解析）
  const emFeeTotal =
    emFee?.mgmt != null && emFee?.custody != null ? emFee.mgmt + emFee.custody : emFee?.mgmt ?? null;
  push("综合费率%", r?.feeRatePct, emFeeTotal, "东财费率页",
    cmpNum(r?.feeRatePct ?? null, emFeeTotal, { abs: 0.001 }));

  // 好成本：成交额 —— 腾讯（真独立源）
  push("成交额(万)", r?.dailyTurnoverWan?.toFixed(0), qq?.turnoverWan?.toFixed(0), "腾讯",
    cmpNum(r?.dailyTurnoverWan ?? null, qq?.turnoverWan ?? null, { relPct: 5 }));

  // 好成本：规模 —— 同花顺 asset（实时场内市值 vs 季报资产净值，只校数量级）
  push("规模(亿)", r?.scaleYi?.toFixed(1), ths?.assetYi?.toFixed(1), "同花顺",
    cmpScale(r?.scaleYi ?? null, ths?.assetYi ?? null));

  // 好资产：跟踪指数（同花顺无该字段，仅确认主源是否抓到 → 影响 indexType 分类）
  push("跟踪指数", r?.trackIndexName, `分类=${r?.indexType ?? "—"}`, "主源自检",
    r?.trackIndexName ? "一致" : "缺失");

  console.log(`\n【${spec.label} ${spec.code}】 主源名称=${main?.name ?? "—"} / 同花顺=${ths?.name ?? "—"}`);
  console.log("  字段".padEnd(14) + "主源(东财)".padEnd(26) + "第二源".padEnd(26) + "对照源".padEnd(12) + "判定");
  for (const row of rows) {
    console.log(
      "  " +
        row.field.padEnd(12) +
        row.main.slice(0, 24).padEnd(26) +
        row.second.slice(0, 24).padEnd(26) +
        row.src.padEnd(12) +
        `${mark(row.verdict)} ${row.verdict}`
    );
  }
  return rows;
}

async function main() {
  bar("ETF 6 维评估字段交叉验证：东方财富(主源) vs 同花顺/腾讯(独立第二源)");
  console.log(
    "判定：公司名归一化包含匹配；基金经理按人名集合有交集（ETF 多为共管）；\n" +
      "      费率绝对差≤0.001；成交额相对差≤5%；规模 ≤20%一致 / 20~50%记口径差异\n" +
      "      （东财=实时份额×现价，同花顺=季报资产净值，口径与时点均不同）。"
  );

  const all: Row[] = [];
  for (const s of SAMPLES) {
    const rows = await verifyOne(s);
    all.push(...rows);
  }

  bar("汇总");
  const byField = new Map<
    string,
    { ok: number; bad: number; miss: number; diff: number }
  >();
  for (const r of all) {
    const e = byField.get(r.field) ?? { ok: 0, bad: 0, miss: 0, diff: 0 };
    if (r.verdict === "一致") e.ok++;
    else if (r.verdict === "不一致") e.bad++;
    else if (r.verdict === "口径差异") e.diff++;
    else e.miss++;
    byField.set(r.field, e);
  }
  console.log(
    "  字段".padEnd(14) +
      "一致".padEnd(8) +
      "口径差".padEnd(8) +
      "不一致".padEnd(8) +
      "缺失".padEnd(8) +
      "结论"
  );
  let totalBad = 0;
  for (const [field, e] of byField) {
    totalBad += e.bad;
    const concl =
      e.bad > 0
        ? "⚠ 存在冲突，需排查"
        : e.ok + e.diff > 0
          ? e.diff > 0
            ? "≈ 数量级一致（口径/时点不同）"
            : "✓ 与第二源一致"
          : "— 数据源无此项/被限流";
    console.log(
      "  " +
        field.padEnd(12) +
        String(e.ok).padEnd(8) +
        String(e.diff).padEnd(8) +
        String(e.bad).padEnd(8) +
        String(e.miss).padEnd(8) +
        concl
    );
  }

  bar("结论");
  if (totalBad === 0) {
    console.log("· 所有可比字段与独立第二源（同花顺/腾讯）一致，未发现数据冲突。");
  } else {
    console.log(`· 发现 ${totalBad} 处字段与第二源冲突，需逐项排查（见上方 ✗ 标记）。`);
  }
  console.log("\n【验证强度分级 —— 不要把所有 ✓ 当成同等可信】");
  console.log("  强（真独立厂商对照）：基金公司 / 基金经理 / 成立日期 / 成交额 / 规模");
  console.log("  中（同厂异页对照，验解析而非验源）：综合费率（jbgk vs jjfl 费率专页）");
  console.log("  弱（仅主源自检，无第二源）：跟踪指数名 —— 同花顺该接口不返回此字段，");
  console.log("     故只能确认「抓到了」，无法确认「抓对了」；它决定 indexType 分类，需人工抽查。");
  console.log("\n【本脚本覆盖不到的项】");
  console.log("  · 实际年化跟踪误差：无免费公开源，评分层按缺失处理（不按满分）");
  console.log("  · EPS 上修幅度：无免费源，恒为 null");
  console.log("  · 折溢价率：多数 ETF 的 push2 f164(IOPV) 为「-」，常缺失");
  console.log("  · 估值维度（PE/PB/历史分位）：见 scripts/etf-valuation-verify.ts");
}

main().catch((e) => {
  console.error("验证脚本异常:", e);
  process.exit(1);
});
