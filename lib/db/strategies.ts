import { prisma } from "./prisma";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_STRATEGIES,
  type Strategy,
  type StrategyCategory,
  type StrategyStore,
} from "../strategies";

export async function readStrategiesDB(): Promise<StrategyStore> {
  const [categories, strategies] = await Promise.all([
    prisma.strategyCategory.findMany({ orderBy: { order: "asc" } }),
    prisma.strategy.findMany(),
  ]);

  if (categories.length === 0 && strategies.length === 0) {
    await seedDefaultStrategies();
    return {
      categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      strategies: DEFAULT_STRATEGIES.map((s) => ({ ...s })),
      updatedAt: Date.now(),
    };
  }

  const catMap = new Map(categories.map((c) => [c.id, c]));
  const mergedCats: StrategyCategory[] = [];
  const usedCatIds = new Set<string>();

  for (const def of DEFAULT_CATEGORIES) {
    const cur = catMap.get(def.id);
    if (cur) {
      mergedCats.push({
        id: cur.id,
        name: cur.name,
        description: cur.description ?? undefined,
        order: cur.order,
        isDefault: cur.isDefault,
        color: cur.color ?? undefined,
      });
    } else {
      mergedCats.push({ ...def });
    }
    usedCatIds.add(def.id);
  }
  for (const c of categories) {
    if (usedCatIds.has(c.id)) continue;
    mergedCats.push({
      id: c.id,
      name: c.name,
      description: c.description ?? undefined,
      order: c.order,
      isDefault: c.isDefault,
      color: c.color ?? undefined,
    });
  }
  mergedCats.sort((a, b) => a.order - b.order);

  const stratMap = new Map(strategies.map((s) => [s.id, s]));
  const firstCatId = mergedCats[0]?.id ?? "cat-growth";
  const mergedStrats: Strategy[] = [];
  const usedStratIds = new Set<string>();

  for (const def of DEFAULT_STRATEGIES) {
    const cur = stratMap.get(def.id);
    if (cur) {
      mergedStrats.push({
        id: cur.id,
        name: cur.name,
        description: cur.description,
        categoryId: cur.categoryId ?? def.categoryId ?? firstCatId,
        metricField: cur.metricField as Strategy["metricField"],
        operator: cur.operator as Strategy["operator"],
        threshold: cur.threshold,
        format: cur.format as Strategy["format"],
        enabled: cur.enabled,
        isDefault: cur.isDefault,
        order: cur.order,
        createdAt: cur.createdAt.getTime(),
        updatedAt: cur.updatedAt.getTime(),
      });
    } else {
      mergedStrats.push({ ...def });
    }
    usedStratIds.add(def.id);
  }
  for (const s of strategies) {
    if (usedStratIds.has(s.id)) continue;
    mergedStrats.push({
      id: s.id,
      name: s.name,
      description: s.description,
      categoryId: s.categoryId ?? firstCatId,
      metricField: s.metricField as Strategy["metricField"],
      operator: s.operator as Strategy["operator"],
      threshold: s.threshold,
      format: s.format as Strategy["format"],
      enabled: s.enabled,
      isDefault: s.isDefault,
      order: s.order,
      createdAt: s.createdAt.getTime(),
      updatedAt: s.updatedAt.getTime(),
    });
  }

  mergedStrats.sort((a, b) => {
    if (a.categoryId !== b.categoryId) {
      const aOrder = mergedCats.find((c) => c.id === a.categoryId)?.order ?? 999;
      const bOrder = mergedCats.find((c) => c.id === b.categoryId)?.order ?? 999;
      return aOrder - bOrder;
    }
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt - b.createdAt;
  });

  return {
    categories: mergedCats,
    strategies: mergedStrats,
    updatedAt: Date.now(),
  };
}

async function seedDefaultStrategies(): Promise<void> {
  for (const cat of DEFAULT_CATEGORIES) {
    await prisma.strategyCategory.upsert({
      where: { id: cat.id },
      update: {},
      create: {
        id: cat.id,
        name: cat.name,
        description: cat.description,
        order: cat.order,
        isDefault: cat.isDefault,
        color: cat.color,
      },
    });
  }
  for (const s of DEFAULT_STRATEGIES) {
    await prisma.strategy.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        name: s.name,
        description: s.description,
        categoryId: s.categoryId,
        metricField: s.metricField,
        operator: s.operator,
        threshold: s.threshold,
        format: s.format,
        enabled: s.enabled,
        isDefault: s.isDefault,
        order: s.order,
      },
    });
  }
}

export async function writeStrategiesDB(
  strategies: Strategy[]
): Promise<StrategyStore> {
  for (const s of strategies) {
    await prisma.strategy.upsert({
      where: { id: s.id },
      update: {
        name: s.name,
        description: s.description,
        categoryId: s.categoryId,
        metricField: s.metricField,
        operator: s.operator,
        threshold: s.threshold,
        format: s.format,
        enabled: s.enabled,
        order: s.order,
      },
      create: {
        id: s.id,
        name: s.name,
        description: s.description,
        categoryId: s.categoryId,
        metricField: s.metricField,
        operator: s.operator,
        threshold: s.threshold,
        format: s.format,
        enabled: s.enabled,
        isDefault: s.isDefault,
        order: s.order,
      },
    });
  }
  return readStrategiesDB();
}

export async function addCategoryDB(
  input: Omit<StrategyCategory, "id" | "isDefault" | "order">
): Promise<StrategyStore> {
  const store = await readStrategiesDB();
  const now = Date.now();
  const maxOrder = store.categories.reduce((m, c) => Math.max(m, c.order), 0);
  const newId = `cat-${now}-${Math.random().toString(36).slice(2, 6)}`;

  await prisma.strategyCategory.create({
    data: {
      id: newId,
      name: input.name,
      description: input.description,
      order: maxOrder + 1,
      isDefault: false,
      color: input.color,
    },
  });

  return readStrategiesDB();
}

export async function updateCategoryDB(
  id: string,
  patch: Partial<Omit<StrategyCategory, "id" | "isDefault">>
): Promise<StrategyStore> {
  const existing = await prisma.strategyCategory.findUnique({ where: { id } });
  if (!existing) throw new Error("分类不存在");

  await prisma.strategyCategory.update({
    where: { id },
    data: {
      name: patch.name,
      description: patch.description,
      order: patch.order,
      color: patch.color,
    },
  });

  return readStrategiesDB();
}

export async function deleteCategoryDB(id: string): Promise<StrategyStore> {
  const cat = await prisma.strategyCategory.findUnique({ where: { id } });
  if (!cat) throw new Error("分类不存在");
  if (cat.isDefault) throw new Error("内置分类不可删除，可编辑");

  const remaining = await prisma.strategyCategory.findMany({
    orderBy: { order: "asc" },
    take: 1,
    where: { id: { not: id } },
  });
  if (remaining.length === 0) throw new Error("至少保留一个分类");

  const targetCatId = remaining[0].id;

  await prisma.strategy.updateMany({
    where: { categoryId: id },
    data: { categoryId: targetCatId },
  });

  await prisma.strategyCategory.delete({ where: { id } });

  return readStrategiesDB();
}

export async function addStrategyDB(
  input: Omit<Strategy, "id" | "isDefault" | "order" | "createdAt" | "updatedAt">
): Promise<StrategyStore> {
  const store = await readStrategiesDB();
  const now = Date.now();

  const catStrats = store.strategies.filter(
    (s) => s.categoryId === input.categoryId
  );
  const maxOrder = catStrats.reduce((m, s) => Math.max(m, s.order), 0);

  const newId = `custom-${now}-${Math.random().toString(36).slice(2, 6)}`;

  await prisma.strategy.create({
    data: {
      id: newId,
      name: input.name,
      description: input.description,
      categoryId: input.categoryId,
      metricField: input.metricField,
      operator: input.operator,
      threshold: input.threshold,
      format: input.format,
      enabled: input.enabled,
      isDefault: false,
      order: maxOrder + 1,
    },
  });

  return readStrategiesDB();
}

export async function updateStrategyDB(
  id: string,
  patch: Partial<Omit<Strategy, "id" | "isDefault" | "createdAt">>
): Promise<StrategyStore> {
  const existing = await prisma.strategy.findUnique({ where: { id } });
  if (!existing) throw new Error("策略不存在");

  await prisma.strategy.update({
    where: { id },
    data: {
      name: patch.name,
      description: patch.description,
      categoryId: patch.categoryId,
      metricField: patch.metricField,
      operator: patch.operator,
      threshold: patch.threshold,
      format: patch.format,
      enabled: patch.enabled,
      order: patch.order,
    },
  });

  return readStrategiesDB();
}

export async function deleteStrategyDB(id: string): Promise<StrategyStore> {
  const cur = await prisma.strategy.findUnique({ where: { id } });
  if (!cur) throw new Error("策略不存在");
  if (cur.isDefault) throw new Error("内置策略不可删除，可禁用或编辑");

  await prisma.strategy.delete({ where: { id } });

  return readStrategiesDB();
}

export async function setStrategyEnabledDB(
  id: string,
  enabled: boolean
): Promise<StrategyStore> {
  return updateStrategyDB(id, { enabled });
}

export async function setCategoryStrategiesEnabledDB(
  categoryId: string,
  enabled: boolean
): Promise<StrategyStore> {
  await prisma.strategy.updateMany({
    where: { categoryId },
    data: { enabled },
  });
  return readStrategiesDB();
}

export async function resetStrategiesDB(): Promise<StrategyStore> {
  await prisma.strategy.deleteMany();
  await prisma.strategyCategory.deleteMany();
  await seedDefaultStrategies();
  return readStrategiesDB();
}

export async function getEnabledStrategiesDB(): Promise<Strategy[]> {
  const store = await readStrategiesDB();
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
