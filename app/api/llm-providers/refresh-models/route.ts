/**
 * 定时刷新 OpenRouter / Groq 可用的免费大模型
 *
 * 调用各平台的 /models 接口获取最新模型列表，
 * 自动替换已下架的 provider 的 model slug，保持 provider 可用。
 *
 * 触发方式：
 *   1. Vercel Cron（vercel.json 配置，每天 03:00 北京时间自动调用）
 *   2. 手动 POST /api/llm-providers/refresh-models
 */
import { NextResponse } from "next/server";
import { refreshOpenRouterModels, refreshGroqModels } from "@/lib/llm";

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

  let openrouter: {
    updated: Array<{ providerId: string; oldModel: string; newModel: string }>;
    availableModels: string[];
  } = { updated: [], availableModels: [] };

  let groq: {
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

  try {
    groq = await refreshGroqModels();
  } catch (err) {
    errors.push(`Groq: ${err instanceof Error ? err.message : String(err)}`);
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
      groq: {
        availableCount: groq.availableModels.length,
        updatedCount: groq.updated.length,
      },
    },
    openrouter,
    groq,
  });
}
