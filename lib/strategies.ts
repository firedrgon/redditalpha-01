/**
 * 分析策略管理
 *
 * 策略按分类管理，默认 4 个分类：成长能力、估值水平、盈利能力、流动性
 * 每个分类下有若干策略，可新增/编辑/禁用/删除（内置策略不可删除）。
 *
 * 持久化：项目根目录 .strategies.json
 */

import fs from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), ".strategies.json");

/** 可用作策略判定依据的财务指标字段 */
export type MetricField =
  | "revenueGrowthYoY" // 营收同比增速（小数）
  | "quarterlyRevenueGrowth"
  | "trailingPE"
  | "forwardPE"
  | "pegRatio"
  | "returnOnEquity5yAvg" // 近 5 年平均 ROE（小数）
  | "roe" // 当前 ROE（小数）
  | "quickRatio"
  | "currentRatio"
  | "grossMargin" // 毛利率（小数）
  | "profitMargin" // 净利率（小数）
  | "peVsIndustry" // PE / 行业 PE（特殊：比值型，无 industryPE 时不可判定）
  | "targetUpside" // 分析师目标价上涨空间（小数，0.10 = 10%）
  | "recommendationMean"; // 分析师推荐均值（1=强力买入，2=买入，3=持有，4=卖出，5=强力卖出）

export type Operator = ">=" | ">" | "<=" | "<" | "==" | "!=";
export type ValueFormat = "percent" | "number" | "ratio";

/** 策略分类 */
export interface StrategyCategory {
  id: string;
  name: string;
  description?: string;
  order: number;
  isDefault: boolean; // 内置分类不可删除
  color?: string; // 标签色（tailwind 颜色名）
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  categoryId: string; // 所属分类 id
  metricField: MetricField;
  operator: Operator;
  threshold: number;
  format: ValueFormat;
  enabled: boolean;
  isDefault: boolean; // 内置策略不可删除
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface StrategyStore {
  categories: StrategyCategory[];
  strategies: Strategy[];
  updatedAt: number;
}

/** 字段对应的展示格式与中文说明 */
export const METRIC_FIELD_INFO: Record<
  MetricField,
  { label: string; format: ValueFormat; description: string }
> = {
  revenueGrowthYoY: {
    label: "营收同比增速",
    format: "percent",
    description: "本年度营收相对上年的增长率（小数，0.10 = 10%）",
  },
  quarterlyRevenueGrowth: {
    label: "季度营收增速",
    format: "percent",
    description: "最近一季度的营收同比增速",
  },
  trailingPE: {
    label: "滚动市盈率 PE",
    format: "number",
    description: "当前股价 ÷ 过去 12 个月 EPS",
  },
  forwardPE: {
    label: "预期市盈率",
    format: "number",
    description: "基于未来 12 个月预期 EPS 计算的 PE",
  },
  pegRatio: {
    label: "PEG",
    format: "number",
    description: "PE ÷ 盈利增速，看估值与增长匹配度",
  },
  returnOnEquity5yAvg: {
    label: "近 5 年平均 ROE",
    format: "percent",
    description: "近 5 年股东权益回报率平均值（小数）",
  },
  roe: {
    label: "当前 ROE",
    format: "percent",
    description: "当前净资产收益率（小数）",
  },
  quickRatio: {
    label: "速动比率",
    format: "number",
    description: "(流动资产 - 存货) ÷ 流动负债",
  },
  currentRatio: {
    label: "流动比率",
    format: "number",
    description: "流动资产 ÷ 流动负债",
  },
  grossMargin: {
    label: "毛利率",
    format: "percent",
    description: "(营收 - 成本) ÷ 营收（小数）",
  },
  profitMargin: {
    label: "净利率",
    format: "percent",
    description: "净利润 ÷ 营收（小数）",
  },
  peVsIndustry: {
    label: "PE / 行业 PE 比值",
    format: "ratio",
    description: "PE 相对行业平均 PE 的倍数，1.5 表示 PE 比行业高 50%",
  },
  targetUpside: {
    label: "分析师目标价上涨空间",
    format: "percent",
    description: "(分析师目标均价 ÷ 当前价 - 1)，正值表示有上涨潜力",
  },
  recommendationMean: {
    label: "分析师推荐评级",
    format: "number",
    description: "1=强力买入, 2=买入, 3=持有, 4=卖出, 5=强力卖出，数值越低越看好",
  },
};

export const OPERATORS: { value: Operator; label: string }[] = [
  { value: ">=", label: "≥ 大于等于" },
  { value: ">", label: "> 大于" },
  { value: "<=", label: "≤ 小于等于" },
  { value: "<", label: "< 小于" },
  { value: "==", label: "= 等于" },
  { value: "!=", label: "≠ 不等于" },
];

/** 默认分类 */
export const DEFAULT_CATEGORIES: StrategyCategory[] = [
  {
    id: "cat-growth",
    name: "成长能力",
    description: "衡量公司业务扩张速度",
    order: 1,
    isDefault: true,
    color: "green",
  },
  {
    id: "cat-valuation",
    name: "估值水平",
    description: "衡量股价相对价值的高低",
    order: 2,
    isDefault: true,
    color: "orange",
  },
  {
    id: "cat-profitability",
    name: "盈利能力",
    description: "衡量公司赚钱效率",
    order: 3,
    isDefault: true,
    color: "purple",
  },
  {
    id: "cat-liquidity",
    name: "流动性",
    description: "衡量公司短期偿债能力",
    order: 4,
    isDefault: true,
    color: "blue",
  },
  {
    id: "cat-analyst",
    name: "分析师预期",
    description: "基于华尔街分析师目标价与评级",
    order: 5,
    isDefault: true,
    color: "cyan",
  },
];

/** 默认 5 项内置策略 */
export const DEFAULT_STRATEGIES: Strategy[] = [
  {
    id: "default-revenue-growth",
    name: "营收年增长 ≥ 10%",
    description: "营收是公司成长的发动机，达不到 10% 说明成长动力明显不足。",
    categoryId: "cat-growth",
    metricField: "revenueGrowthYoY",
    operator: ">=",
    threshold: 0.1,
    format: "percent",
    enabled: true,
    isDefault: true,
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-pe-vs-industry",
    name: "PE 不远高于行业平均",
    description: "PE 远高于同行说明股价可能已被市场炒高，有接盘风险。",
    categoryId: "cat-valuation",
    metricField: "peVsIndustry",
    operator: "<=",
    threshold: 1.5,
    format: "ratio",
    enabled: true,
    isDefault: true,
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-peg",
    name: "PEG ≤ 2",
    description: "PEG 看增长和估值搭不搭，超过 2 说明增长撑不起当前价格。",
    categoryId: "cat-valuation",
    metricField: "pegRatio",
    operator: "<=",
    threshold: 2,
    format: "number",
    enabled: true,
    isDefault: true,
    order: 2,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-roe-5y",
    name: "近 5 年平均 ROE > 15%",
    description: "ROE 是赚钱能力的硬核指标，低于 15% 说明盈利能力偏弱。",
    categoryId: "cat-profitability",
    metricField: "returnOnEquity5yAvg",
    operator: ">",
    threshold: 0.15,
    format: "percent",
    enabled: true,
    isDefault: true,
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-quick-ratio",
    name: "速动比率 > 1.5",
    description: "看公司短期还钱能力，低于 1.5 有流动性隐患。",
    categoryId: "cat-liquidity",
    metricField: "quickRatio",
    operator: ">",
    threshold: 1.5,
    format: "number",
    enabled: true,
    isDefault: true,
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-target-upside",
    name: "目标价上涨空间 ≥ 10%",
    description: "华尔街分析师共识目标价相对当前价有 10% 以上的上涨空间。",
    categoryId: "cat-analyst",
    metricField: "targetUpside",
    operator: ">=",
    threshold: 0.1,
    format: "percent",
    enabled: true,
    isDefault: true,
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-recommendation",
    name: "分析师评级为买入或以上",
    description: "分析师推荐均值 ≤ 2.0（2=买入，1=强力买入），多数分析师看好。",
    categoryId: "cat-analyst",
    metricField: "recommendationMean",
    operator: "<=",
    threshold: 2.0,
    format: "number",
    enabled: true,
    isDefault: true,
    order: 2,
    createdAt: 0,
    updatedAt: 0,
  },
];

// 内存降级副本：当文件不可写时使用
let memoryStore: StrategyStore | null = null;

/** 读取策略库（不存在时返回默认） */
export async function readStrategies(): Promise<StrategyStore> {
  // 优先用内存副本（写入失败后的降级路径）
  if (memoryStore) {
    return JSON.parse(JSON.stringify(memoryStore)) as StrategyStore;
  }
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StrategyStore>;
    const cats = (parsed.categories ?? []).filter(Boolean);
    const strats = (parsed.strategies ?? []).filter(Boolean);
    const mergedCats = mergeCategoriesWithDefaults(cats);
    const mergedStrats = mergeStrategiesWithDefaults(strats, mergedCats);
    return {
      categories: mergedCats,
      strategies: mergedStrats,
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return {
      categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      strategies: DEFAULT_STRATEGIES.map((s) => ({ ...s })),
      updatedAt: 0,
    };
  }
}

/** 合并分类：默认分类缺失则补回，编辑过则保留 */
function mergeCategoriesWithDefaults(
  existing: StrategyCategory[]
): StrategyCategory[] {
  const out: StrategyCategory[] = [];
  const usedIds = new Set<string>();

  for (const def of DEFAULT_CATEGORIES) {
    const cur = existing.find((c) => c.id === def.id);
    if (cur) {
      out.push({ ...def, ...cur, isDefault: true });
    } else {
      out.push({ ...def });
    }
    usedIds.add(def.id);
  }
  for (const c of existing) {
    if (usedIds.has(c.id)) continue;
    out.push({ ...c, isDefault: false });
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

/** 合并策略：默认策略缺失则补回；给无 categoryId 的老策略分配第一个分类 */
function mergeStrategiesWithDefaults(
  existing: Strategy[],
  categories: StrategyCategory[]
): Strategy[] {
  const out: Strategy[] = [];
  const usedIds = new Set<string>();
  const firstCatId = categories[0]?.id ?? "cat-growth";

  for (const def of DEFAULT_STRATEGIES) {
    const cur = existing.find((s) => s.id === def.id);
    if (cur) {
      out.push({
        ...def,
        ...cur,
        isDefault: true,
        categoryId: cur.categoryId ?? def.categoryId ?? firstCatId,
      });
    } else {
      out.push({ ...def });
    }
    usedIds.add(def.id);
  }
  for (const s of existing) {
    if (usedIds.has(s.id)) continue;
    out.push({
      ...s,
      isDefault: false,
      categoryId: s.categoryId ?? firstCatId,
    });
  }
  out.sort((a, b) => {
    if (a.categoryId !== b.categoryId) {
      const aOrder = categories.find((c) => c.id === a.categoryId)?.order ?? 999;
      const bOrder = categories.find((c) => c.id === b.categoryId)?.order ?? 999;
      return aOrder - bOrder;
    }
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt - b.createdAt;
  });
  return out;
}

/** 写入策略库：文件可写则写文件，否则只更新内存副本（serverless 降级） */
async function writeStore(store: StrategyStore): Promise<StrategyStore> {
  const mergedCats = mergeCategoriesWithDefaults(store.categories);
  const mergedStrats = mergeStrategiesWithDefaults(store.strategies, mergedCats);
  const out: StrategyStore = {
    categories: mergedCats,
    strategies: mergedStrats,
    updatedAt: Date.now(),
  };
  // 始终更新内存副本
  memoryStore = JSON.parse(JSON.stringify(out)) as StrategyStore;
  // 尝试写文件（失败则降级到内存模式）
  try {
    await fs.writeFile(FILE, JSON.stringify(out, null, 2), "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("EROFS") && !msg.includes("read-only")) {
      throw err;
    }
  }
  return out;
}

/** 写入策略（保留现有分类） */
export async function writeStrategies(
  strategies: Strategy[]
): Promise<StrategyStore> {
  const store = await readStrategies();
  return writeStore({ ...store, strategies });
}

// ============================================================
// 分类 CRUD
// ============================================================

/** 新增分类 */
export async function addCategory(
  input: Omit<StrategyCategory, "id" | "isDefault" | "order">
): Promise<StrategyStore> {
  const store = await readStrategies();
  const now = Date.now();
  const maxOrder = store.categories.reduce((m, c) => Math.max(m, c.order), 0);
  const newCat: StrategyCategory = {
    ...input,
    id: `cat-${now}-${Math.random().toString(36).slice(2, 6)}`,
    isDefault: false,
    order: maxOrder + 1,
  };
  store.categories.push(newCat);
  return writeStore(store);
}

/** 更新分类 */
export async function updateCategory(
  id: string,
  patch: Partial<Omit<StrategyCategory, "id" | "isDefault">>
): Promise<StrategyStore> {
  const store = await readStrategies();
  const idx = store.categories.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error("分类不存在");
  store.categories[idx] = { ...store.categories[idx], ...patch };
  return writeStore(store);
}

/** 删除分类（内置不可删；分类下的策略移到第一个分类） */
export async function deleteCategory(id: string): Promise<StrategyStore> {
  const store = await readStrategies();
  const cat = store.categories.find((c) => c.id === id);
  if (!cat) throw new Error("分类不存在");
  if (cat.isDefault) throw new Error("内置分类不可删除，可编辑");

  // 找一个目标分类（第一个非待删除的分类）
  const targetCat = store.categories.find((c) => c.id !== id);
  if (!targetCat) throw new Error("至少保留一个分类");

  // 把该分类下的策略移到目标分类
  for (const s of store.strategies) {
    if (s.categoryId === id) {
      s.categoryId = targetCat.id;
      s.updatedAt = Date.now();
    }
  }

  store.categories = store.categories.filter((c) => c.id !== id);
  return writeStore(store);
}

// ============================================================
// 策略 CRUD
// ============================================================

/** 新增自定义策略 */
export async function addStrategy(
  input: Omit<Strategy, "id" | "isDefault" | "order" | "createdAt" | "updatedAt">
): Promise<StrategyStore> {
  const store = await readStrategies();
  const now = Date.now();

  // 分类内 order 最大 + 1
  const catStrats = store.strategies.filter(
    (s) => s.categoryId === input.categoryId
  );
  const maxOrder = catStrats.reduce((m, s) => Math.max(m, s.order), 0);

  const newStrategy: Strategy = {
    ...input,
    id: `custom-${now}-${Math.random().toString(36).slice(2, 6)}`,
    isDefault: false,
    order: maxOrder + 1,
    createdAt: now,
    updatedAt: now,
  };
  store.strategies.push(newStrategy);
  return writeStore(store);
}

/** 更新策略（默认策略可编辑但不可删） */
export async function updateStrategy(
  id: string,
  patch: Partial<Omit<Strategy, "id" | "isDefault" | "createdAt">>
): Promise<StrategyStore> {
  const store = await readStrategies();
  const idx = store.strategies.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error("策略不存在");
  store.strategies[idx] = {
    ...store.strategies[idx],
    ...patch,
    updatedAt: Date.now(),
  };
  return writeStore(store);
}

/** 删除策略（默认策略不可删） */
export async function deleteStrategy(id: string): Promise<StrategyStore> {
  const store = await readStrategies();
  const cur = store.strategies.find((s) => s.id === id);
  if (!cur) throw new Error("策略不存在");
  if (cur.isDefault) throw new Error("内置策略不可删除，可禁用或编辑");
  store.strategies = store.strategies.filter((s) => s.id !== id);
  return writeStore(store);
}

/** 启用/禁用策略 */
export async function setStrategyEnabled(
  id: string,
  enabled: boolean
): Promise<StrategyStore> {
  return updateStrategy(id, { enabled });
}

/** 批量启用/禁用某分类下的策略 */
export async function setCategoryStrategiesEnabled(
  categoryId: string,
  enabled: boolean
): Promise<StrategyStore> {
  const store = await readStrategies();
  for (const s of store.strategies) {
    if (s.categoryId === categoryId) {
      s.enabled = enabled;
      s.updatedAt = Date.now();
    }
  }
  return writeStore(store);
}

/** 重置为默认（删除所有自定义策略和分类，恢复默认） */
export async function resetStrategies(): Promise<StrategyStore> {
  return writeStore({
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    strategies: DEFAULT_STRATEGIES.map((s) => ({ ...s })),
    updatedAt: 0,
  });
}

/** 获取当前启用的策略（按分类 order + 策略 order 排序） */
export async function getEnabledStrategies(): Promise<Strategy[]> {
  const store = await readStrategies();
  const cats = store.categories;
  return store.strategies
    .filter((s) => s.enabled)
    .sort((a, b) => {
      if (a.categoryId !== b.categoryId) {
        const aOrder = cats.find((c) => c.id === a.categoryId)?.order ?? 999;
        const bOrder = cats.find((c) => c.id === b.categoryId)?.order ?? 999;
        return aOrder - bOrder;
      }
      return a.order - b.order;
    });
}
