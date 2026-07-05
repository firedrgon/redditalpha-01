/**
 * 定时刷新所有动态模型的 LLM provider 可用性
 *
 * 当前覆盖：
 *   1. OpenRouter：调用 /api/v1/models，自动替换已下架的免费模型 slug
 *      （由 lib/llm.ts 的 refreshOpenRouterModels 实现）
 *   2. SiliconFlow：调用 /v1/models?type=text&sub_type=chat，更新 provider 可用性
 *      （由 lib/llm.ts 的 refreshSiliconFlowModels 实现）
 *
 * 触发方式：
 *   1. Vercel Cron（vercel.json 配置，每天 03:00 北京时间自动调用）
 *   2. 手动 POST /api/llm-providers/refresh-models
 *
 * 返回各来源的刷新结果汇总，便于调试和监控。
 */
import { NextResponse } from "next/server";
import {
  refreshOpenRouterModels,
  refreshSiliconFlowModels,
} from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/llm-providers/refresh-models：Vercel Cron 调用入口 */
export async function GET() {
  return runRefresh();
}

/** POST /api/llm-providers/refresh-models：手动触发 */
export async function POST() {
  return runRefresh();
}

async function runRefresh() {
  const now = Date.now();
  const errors: string[] = [];

  // 1. OpenRouter 模型刷新（自动替换已下架的 slug）
  let openrouter: {
    updated: Array<{ providerId: string; oldModel: string; newModel: string }>;
    availableModels: string[];
  } = { updated: [], availableModels: [] };
  try {
    openrouter = await refreshOpenRouterModels();
  } catch (err) {
    errors.push(
      `OpenRouter: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 2. SiliconFlow 模型刷新（更新可用性标记）
  let siliconflow: {
    updated: Array<{ providerId: string; action: string }>;
    availableModels: string[];
    removedModels: string[];
    newCandidates: string[];
  } = {
    updated: [],
    availableModels: [],
    removedModels: [],
    newCandidates: [],
  };
  try {
    siliconflow = await refreshSiliconFlowModels();
  } catch (err) {
    errors.push(
      `SiliconFlow: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return NextResponse.json({
    ok: errors.length === 0,
    updatedAt: now,
    errors,
    summary: {
      openrouter: {
        availableCount: openrouter.availableModels.length,
        updatedCount: openrouter.updated.length,
      },
      siliconflow: {
        availableCount: siliconflow.availableModels.length,
        removedCount: siliconflow.removedModels.length,
        newCandidateCount: siliconflow.newCandidates.length,
        updatedCount: siliconflow.updated.length,
      },
    },
    openrouter,
    siliconflow,
  });
}
