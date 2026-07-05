/**
 * 定时刷新 SiliconFlow 可用的免费大模型
 *
 * 调用 SiliconFlow /v1/models?type=text&sub_type=chat 接口获取最新模型列表，
 * 与已知免费模型列表对比，更新本地 provider 的可用性状态：
 *   - 模型仍存在：保持启用，清除 working 标记（下次调用时重新检测）
 *   - 模型已下架：标记 working=false，避免后续调用失败
 *   - 发现新的免费模型：返回给调用方（用于人工评估是否加入静态配置）
 *
 * 触发方式：
 *   1. Vercel Cron（vercel.json 配置，每天 03:00 北京时间自动调用）
 *   2. 手动 POST /api/llm-providers/refresh-siliconflow
 */
import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/llm-config";
import {
  LLM_PROVIDERS,
  SILICONFLOW_PROVIDER_IDS,
  SILICONFLOW_KNOWN_FREE_MODELS,
} from "@/lib/llm-providers";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SiliconFlowModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

interface SiliconFlowModelsResponse {
  object: string;
  data: SiliconFlowModel[];
}

/** 获取 SiliconFlow 所有可用文本模型 */
async function fetchSiliconFlowModels(
  apiKey: string
): Promise<SiliconFlowModel[]> {
  const url = "https://api.siliconflow.cn/v1/models?type=text&sub_type=chat";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SiliconFlow /v1/models HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as SiliconFlowModelsResponse;
  return data.data ?? [];
}

/**
 * GET /api/llm-providers/refresh-siliconflow
 * Vercel Cron 调用入口（也支持浏览器手动触发）
 */
export async function GET() {
  return runRefresh();
}

/** POST /api/llm-providers/refresh-siliconflow：手动触发 */
export async function POST() {
  return runRefresh();
}

async function runRefresh() {
  const config = await readConfig();

  // 取 SiliconFlow 共享 Key
  let apiKey = "";
  for (const id of SILICONFLOW_PROVIDER_IDS) {
    const s = config.providers[id];
    if (s?.apiKey?.trim()) {
      apiKey = s.apiKey.trim();
      break;
    }
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "SiliconFlow API Key 未配置，跳过刷新",
        updatedAt: Date.now(),
      },
      { status: 200 }
    );
  }

  try {
    const models = await fetchSiliconFlowModels(apiKey);
    const modelIds = new Set(models.map((m) => m.id));

    // 已知免费模型中当前可用的
    const availableFreeModels = SILICONFLOW_KNOWN_FREE_MODELS.filter((id) =>
      modelIds.has(id)
    );
    // 已知免费模型中已下架的
    const removedModels = SILICONFLOW_KNOWN_FREE_MODELS.filter(
      (id) => !modelIds.has(id)
    );
    // 平台新增的（在已知列表外、但可能是免费的）
    // SiliconFlow /v1/models 不直接返回是否免费，这里仅记录新模型供人工评估
    const knownSet = new Set<string>(SILICONFLOW_KNOWN_FREE_MODELS);
    const newCandidates = models
      .map((m) => m.id)
      .filter(
        (id) =>
          !knownSet.has(id) &&
          // 仅关注可能免费的模型（开源模型）
          /^(Qwen|deepseek-ai|meta-llama|THUDM|internlm|mistralai)\//.test(id)
      );

    // 更新本地 SiliconFlow provider 可用性
    const now = Date.now();
    const updated: string[] = [];
    for (const provider of LLM_PROVIDERS) {
      if (!SILICONFLOW_PROVIDER_IDS.includes(
        provider.id as (typeof SILICONFLOW_PROVIDER_IDS)[number]
      )) {
        continue;
      }
      const status = config.providers[provider.id];
      if (!status) continue;

      const stillAvailable = modelIds.has(provider.model);
      if (stillAvailable) {
        // 模型仍存在：清除 working 标记，下次调用时重新检测
        if (status.working === false || status.cooldownUntil) {
          status.working = null;
          status.cooldownUntil = null;
          status.lastError = null;
          updated.push(`${provider.id}: 恢复为未测试（模型可用）`);
        } else {
          updated.push(`${provider.id}: 保持可用`);
        }
      } else {
        // 模型已下架：标记为不可用
        status.working = false;
        status.lastTested = now;
        status.lastError = `模型 ${provider.model} 已从 SiliconFlow 下架`;
        updated.push(`${provider.id}: 标记为不可用（已下架）`);
      }
    }

    await writeConfig(config);

    return NextResponse.json({
      ok: true,
      updatedAt: now,
      summary: {
        totalModels: models.length,
        knownFreeTotal: SILICONFLOW_KNOWN_FREE_MODELS.length,
        availableFree: availableFreeModels.length,
        removed: removedModels.length,
        newCandidates: newCandidates.length,
      },
      availableFreeModels,
      removedModels,
      newCandidates,
      providerUpdates: updated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: msg, updatedAt: Date.now() },
      { status: 200 }
    );
  }
}
