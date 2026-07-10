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

/** OpenRouter 系列 provider 共享同一 API Key */
export const OPENROUTER_PROVIDER_IDS = [
  "openrouter-1",
  "openrouter-2",
  "openrouter-3",
  "openrouter-4",
  "openrouter-5",
] as const;

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
  "groq-1",
  "groq-2",
  "groq-3",
  "openrouter-1",
  "openrouter-2",
  "openrouter-3",
  "openrouter-4",
  "openrouter-5",
] as const;

export const LLM_PROVIDERS: LLMProvider[] = [
  {
    id: "gemini-1",
    name: "Google Gemini · 模型 1",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "Gemini 动态发现的模型（自动更新），与其他 Gemini 模型共用 Key",
    protocol: "gemini",
    freeQuota: "免费层：约 15 req/min，每天 1500 req",
  },
  {
    id: "gemini-2",
    name: "Google Gemini · 模型 2",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "Gemini 动态发现的模型（自动更新），与其他 Gemini 模型共用 Key",
    protocol: "gemini",
    freeQuota: "免费层：约 15 req/min，每天 1500 req",
  },
  {
    id: "openrouter-1",
    name: "OpenRouter · 模型 1",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenRouter 动态发现的免费模型（自动更新），与其他 OpenRouter 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req（充值 $10 可升至 1000/天）",
  },
  {
    id: "openrouter-2",
    name: "OpenRouter · 模型 2",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenRouter 动态发现的免费模型（自动更新），与其他 OpenRouter 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "openrouter-3",
    name: "OpenRouter · 模型 3",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenRouter 动态发现的免费模型（自动更新），与其他 OpenRouter 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "openrouter-4",
    name: "OpenRouter · 模型 4",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenRouter 动态发现的免费模型（自动更新），与其他 OpenRouter 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "openrouter-5",
    name: "OpenRouter · 模型 5",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenRouter 动态发现的免费模型（自动更新），与其他 OpenRouter 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "groq-1",
    name: "Groq · 模型 1",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "Groq 动态发现的模型（自动更新），与其他 Groq 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req（Groq 系列共享配额）",
  },
  {
    id: "groq-2",
    name: "Groq · 模型 2",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "Groq 动态发现的模型（自动更新），与其他 Groq 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req（Groq 系列共享配额）",
  },
  {
    id: "groq-3",
    name: "Groq · 模型 3",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "Groq 动态发现的模型（自动更新），与其他 Groq 模型共用 Key",
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
