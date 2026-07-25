/**
 * 免费 LLM 提供商清单（精选）
 *
 * 这些提供商均提供免费额度，部分需要注册获取 API Key。
 * 用户可在设置 UI 或环境变量中配置 Key。
 *
 * 分析场景推荐：Gemini 2.5 Flash（主力）→ Qwen 2.5（中文）→ DeepSeek R1（推理）→ Groq（速度兜底）
 */

export interface LLMProvider {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  free: boolean;
  needsKey: boolean;
  signupUrl: string;
  docsUrl?: string;
  description: string;
  /** 调用方式：openai（OpenAI 兼容协议）/ gemini */
  protocol: "openai" | "gemini";
  freeQuota: string;
}

/**
 * OpenRouter 系列 provider 共享同一 API Key。
 * 仅保留 1 个：使用官方 Free Models Router（openrouter/free），
 * 由 OpenRouter 自动从可用免费模型中挑选，无需自行筛选/打分。
 */
export const OPENROUTER_PROVIDER_IDS = ["openrouter-1"] as const;

/** Gemini 系列 provider 共享同一 API Key */
export const GEMINI_PROVIDER_IDS = [
  "gemini-1",
  "gemini-2",
] as const;

/** Groq 系列 provider 共享同一 API Key（GROQ_API_KEY） */
export const GROQ_PROVIDER_IDS = [
  "groq-1",
  "groq-2",
  "groq-3",
] as const;

/**
 * 自动选择活跃 provider 时的优先级（配额 + 质量综合优先）。
 *
 * 排序原则：
 *   1. 高配额免费层优先（Gemini 1500/天、Groq 14400/天）
 *   2. 低配额免费层（OpenRouter 50/天共享）作为深度分析补充
 */
export const PREFERRED_ACTIVE_ORDER = [
  "gemini-1",
  "gemini-2",
  "deepseek-1",
  "groq-1",
  "groq-2",
  "groq-3",
  "openrouter-1",
] as const;

export const LLM_PROVIDERS: LLMProvider[] = [
  {
    id: "gemini-1",
    name: "Google Gemini 2.5 Flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "gemini-2.5-flash",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "推荐主力：中文好、指令遵循强，适合结构化财务分析。与其他 Gemini 模型共用 Key",
    protocol: "gemini",
    freeQuota: "免费层：约 15 req/min，每天 1500 req",
  },
  {
    id: "gemini-2",
    name: "Google Gemini 2.5 Flash Lite",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "gemini-2.5-flash-lite",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "更轻量更快，适合快速分析场景。与其他 Gemini 模型共用 Key",
    protocol: "gemini",
    freeQuota: "免费层：约 15 req/min，每天 1500 req",
  },
  {
    id: "openrouter-1",
    name: "OpenRouter · GPT-OSS 120B (free)",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-oss-120b:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/models/openai/gpt-oss-120b",
    description:
      "OpenRouter 上的 OpenAI 开源 120B 推理模型（固定免费档 :free），质量显著强于随机 Free Router，适合长文财务分析。与其他 OpenRouter 配置共用 Key",
    protocol: "openai",
    freeQuota: "免费层 openai/gpt-oss-120b:free，每日有限额但稳定可用",
  },
  {
    id: "deepseek-1",
    name: "DeepSeek · V3 (deepseek-chat)",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    free: true,
    needsKey: true,
    signupUrl: "https://platform.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com",
    description:
      "质量接近 Gemini，中文/推理强；免费额度后极便宜（$0.14/$0.28 每M）。适合做 Gemini 满额后的主力替补。与其他 DeepSeek 配置共用 Key",
    protocol: "openai",
    freeQuota: "免费 ~500万 token/30天；之后 $0.14/$0.28 每M，极便宜",
  },
  {
    id: "groq-1",
    name: "Groq · Qwen3 32B",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "qwen/qwen3-32b",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "中文表达最好，32B 参数分析能力够，400 t/s 速度快，适合中文股票分析。与其他 Groq 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req（Groq 系列共享配额）",
  },
  {
    id: "groq-2",
    name: "Groq · GPT-OSS 120B",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "OpenAI 开源 120B 推理模型，分析深度最强，500 t/s，适合复杂财务推理。与其他 Groq 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req（Groq 系列共享配额）",
  },
  {
    id: "groq-3",
    name: "Groq · Llama 3.3 70B",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "速度最快（280 t/s），适合兜底；分析深度略逊于 Gemini / Qwen。与其他 Groq 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req（Groq 系列共享配额）",
  },
];

export function getProviderById(id: string): LLMProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

export function isOpenRouterProvider(id: string): boolean {
  return OPENROUTER_PROVIDER_IDS.includes(
    id as (typeof OPENROUTER_PROVIDER_IDS)[number]
  );
}
