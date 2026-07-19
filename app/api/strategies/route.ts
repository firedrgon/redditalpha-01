import { NextRequest, NextResponse } from "next/server";
import {
  readStrategiesDB as readStrategies,
  addStrategyDB as addStrategy,
  updateStrategyDB as updateStrategy,
  deleteStrategyDB as deleteStrategy,
  resetStrategiesDB as resetStrategies,
  setStrategyEnabledDB as setStrategyEnabled,
  addCategoryDB as addCategory,
  updateCategoryDB as updateCategory,
  deleteCategoryDB as deleteCategory,
  setCategoryStrategiesEnabledDB as setCategoryStrategiesEnabled,
} from "@/lib/db";
import {
  type Strategy,
  type StrategyCategory,
  type MetricField,
  type Operator,
  type ValueFormat,
  METRIC_FIELD_INFO,
  OPERATORS,
} from "@/lib/strategies";
import { requireAdmin } from "@/lib/auth-guards";

export const runtime = "nodejs";

function buildMeta() {
  return {
    metricFields: Object.entries(METRIC_FIELD_INFO).map(([key, info]) => ({
      value: key as MetricField,
      label: info.label,
      format: info.format,
      description: info.description,
    })),
    operators: OPERATORS,
    formats: [
      { value: "percent", label: "百分比 (0.10 显示为 10%)" },
      { value: "number", label: "数字" },
      { value: "ratio", label: "比值" },
    ] as Array<{ value: ValueFormat; label: string }>,
  };
}

function buildResponse(store: {
  categories: StrategyCategory[];
  strategies: Strategy[];
  updatedAt: number;
}) {
  return {
    categories: store.categories,
    strategies: store.strategies,
    updatedAt: store.updatedAt,
    meta: buildMeta(),
  };
}

/** GET /api/strategies — 列出分类 + 策略 + 元数据 */
export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;

  const store = await readStrategies();
  return NextResponse.json(buildResponse(store));
}

// ============================================================
// POST：新增策略 / 新增分类 / 批量操作 / 重置
// ============================================================

interface StrategyCreateBody {
  name: string;
  description?: string;
  categoryId: string;
  metricField: MetricField;
  operator: Operator;
  threshold: number;
  format: ValueFormat;
  enabled?: boolean;
}

interface CategoryCreateBody {
  resource: "category";
  name: string;
  description?: string;
  color?: string;
}

interface ActionBody {
  action:
    | "reset"
    | "enableAll"
    | "disableAll"
    | "enableCategory"
    | "disableCategory";
  categoryId?: string;
}

type PostBody = StrategyCreateBody | CategoryCreateBody | ActionBody;

export async function POST(request: NextRequest) {
  const { response } = await requireAdmin();
  if (response) return response;

  const body = (await request.json().catch(() => ({}))) as PostBody;

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }

  // 按 action 区分批量操作
  if ("action" in body && body.action) {
    return handleAction(body as ActionBody);
  }

  // 新增分类
  if ("resource" in body && (body as CategoryCreateBody).resource === "category") {
    return handleAddCategory(body as CategoryCreateBody);
  }

  // 新增策略
  return handleAddStrategy(body as StrategyCreateBody);
}

async function handleAction(body: ActionBody) {
  switch (body.action) {
    case "reset": {
      const store = await resetStrategies();
      return NextResponse.json(buildResponse(store));
    }
    case "enableAll":
    case "disableAll": {
      const target = body.action === "enableAll";
      const store = await readStrategies();
      for (const s of store.strategies) {
        await setStrategyEnabled(s.id, target);
      }
      const after = await readStrategies();
      return NextResponse.json(buildResponse(after));
    }
    case "enableCategory":
    case "disableCategory": {
      if (!body.categoryId) {
        return NextResponse.json(
          { error: "缺少 categoryId" },
          { status: 400 }
        );
      }
      const target = body.action === "enableCategory";
      const store = await setCategoryStrategiesEnabled(
        body.categoryId,
        target
      );
      return NextResponse.json(buildResponse(store));
    }
    default:
      return NextResponse.json(
        { error: `未知 action: ${body.action}` },
        { status: 400 }
      );
  }
}

async function handleAddCategory(body: CategoryCreateBody) {
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "缺少 name" }, { status: 400 });
  }
  try {
    const store = await addCategory({
      name: body.name.trim(),
      description: body.description?.trim(),
      color: body.color,
    });
    return NextResponse.json(buildResponse(store));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

async function handleAddStrategy(body: StrategyCreateBody) {
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "缺少 name" }, { status: 400 });
  }
  if (!body.categoryId) {
    return NextResponse.json({ error: "缺少 categoryId" }, { status: 400 });
  }
  if (!body.metricField) {
    return NextResponse.json({ error: "缺少 metricField" }, { status: 400 });
  }
  if (!body.operator) {
    return NextResponse.json({ error: "缺少 operator" }, { status: 400 });
  }
  if (typeof body.threshold !== "number") {
    return NextResponse.json(
      { error: "缺少或非法 threshold" },
      { status: 400 }
    );
  }
  if (!body.format) {
    return NextResponse.json({ error: "缺少 format" }, { status: 400 });
  }
  if (!METRIC_FIELD_INFO[body.metricField]) {
    return NextResponse.json(
      { error: `未知 metricField: ${body.metricField}` },
      { status: 400 }
    );
  }

  try {
    const store = await addStrategy({
      name: body.name.trim(),
      description: body.description?.trim() || "",
      categoryId: body.categoryId,
      metricField: body.metricField,
      operator: body.operator,
      threshold: body.threshold,
      format: body.format,
      enabled: body.enabled ?? true,
    });
    return NextResponse.json(buildResponse(store));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

// ============================================================
// PATCH：更新策略 / 更新分类
// ============================================================

interface StrategyPatchBody {
  id: string;
  name?: string;
  description?: string;
  categoryId?: string;
  metricField?: MetricField;
  operator?: Operator;
  threshold?: number;
  format?: ValueFormat;
  enabled?: boolean;
  order?: number;
}

interface CategoryPatchBody {
  resource: "category";
  id: string;
  name?: string;
  description?: string;
  color?: string;
  order?: number;
}

export async function PATCH(request: NextRequest) {
  const { response } = await requireAdmin();
  if (response) return response;

  const body = (await request.json().catch(() => null)) as
    | StrategyPatchBody
    | CategoryPatchBody
    | null;

  if (!body?.id) {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }

  if ("resource" in body && body.resource === "category") {
    return handlePatchCategory(body as CategoryPatchBody);
  }

  return handlePatchStrategy(body as StrategyPatchBody);
}

async function handlePatchStrategy(body: StrategyPatchBody) {
  const patch: Partial<Strategy> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.description === "string")
    patch.description = body.description.trim();
  if (body.categoryId) patch.categoryId = body.categoryId;
  if (body.metricField) {
    if (!METRIC_FIELD_INFO[body.metricField]) {
      return NextResponse.json(
        { error: `未知 metricField: ${body.metricField}` },
        { status: 400 }
      );
    }
    patch.metricField = body.metricField;
    patch.format = METRIC_FIELD_INFO[body.metricField].format;
  }
  if (body.operator) patch.operator = body.operator;
  if (typeof body.threshold === "number") patch.threshold = body.threshold;
  if (body.format) patch.format = body.format;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.order === "number") patch.order = body.order;

  try {
    const store = await updateStrategy(body.id, patch);
    return NextResponse.json(buildResponse(store));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

async function handlePatchCategory(body: CategoryPatchBody) {
  const patch: Partial<StrategyCategory> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.description === "string")
    patch.description = body.description.trim();
  if (body.color) patch.color = body.color;
  if (typeof body.order === "number") patch.order = body.order;

  try {
    const store = await updateCategory(body.id, patch);
    return NextResponse.json(buildResponse(store));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

// ============================================================
// DELETE：删除策略 / 删除分类
// ============================================================

export async function DELETE(request: NextRequest) {
  const { response } = await requireAdmin();
  if (response) return response;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const resource = searchParams.get("resource"); // "strategy" | "category"

  if (!id) {
    return NextResponse.json({ error: "缺少 id 参数" }, { status: 400 });
  }

  try {
    if (resource === "category") {
      const store = await deleteCategory(id);
      return NextResponse.json(buildResponse(store));
    }
    const store = await deleteStrategy(id);
    return NextResponse.json(buildResponse(store));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
