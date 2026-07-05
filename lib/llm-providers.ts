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
  /** 调用方式：openai（OpenAI 兼容协议）/ gemini / huggingface / duckduckgo */
  protocol: "openai" | "gemini" | "huggingface" | "duckduckgo";
  freeQuota: string;
}

/** OpenRouter 系列 provider 共享同一 API Key */
export const OPENROUTER_PROVIDER_IDS = [
  "openrouter-qwen",
  "openrouter-deepseek",
  "openrouter-free",
] as const;

/** Gemini 系列 provider 共享同一 API Key */
export const GEMINI_PROVIDER_IDS = [
  "gemini",
  "gemini-2.0",
] as const;

/** 自动选择活跃 provider 时的优先级（分析质量优先） */
export const PREFERRED_ACTIVE_ORDER = [
  "gemini",
  "gemini-2.0",
  "openrouter-qwen",
  "openrouter-deepseek",
  "groq",
  "openrouter-free",
  "together",
  "huggingface",
  "duckduckgo",
] as const;

export const LLM_PROVIDERS: LLMProvider[] = [
  {
    id: "gemini",
    name: "Google Gemini 2.5 Flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "gemini-2.5-flash",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "推荐主力：中文好、指令遵循强，适合结构化财务分析",
    protocol: "gemini",
    freeQuota: "免费层：约 15 req/min，每天 1500 req",
  },
  {
    id: "gemini-2.0",
    name: "Google Gemini 2.0 Flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "gemini-2.0-flash",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "Gemini 2.0 Flash：速度更快，适合快速分析场景",
    protocol: "gemini",
    freeQuota: "免费层：约 15 req/min，每天 1500 req",
  },
  {
    id: "openrouter-qwen",
    name: "OpenRouter · Qwen 2.5 72B",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "qwen/qwen-2.5-72b-instruct:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "中文表达自然，财务叙述流畅，与 OpenRouter 其他模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req（充值 $10 可升至 1000/天）",
  },
  {
    id: "openrouter-deepseek",
    name: "OpenRouter · DeepSeek R1",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "deepseek/deepseek-r1",
    free: false,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "推理能力强，指标解读更深入，响应较慢。免费版已下线，需 OpenRouter 充值余额",
    protocol: "openai",
    freeQuota: "付费：按 token 计费，需 OpenRouter 余额",
  },
  {
    id: "groq",
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "速度最快，适合兜底；分析深度略逊于 Gemini / Qwen",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req",
  },
  {
    id: "openrouter-free",
    name: "OpenRouter · Llama 3.3 70B",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenRouter 免费 Llama，与 Qwen / DeepSeek 共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "huggingface",
    name: "HuggingFace Inference",
    endpoint: "https://api-inference.huggingface.co/models",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    free: true,
    needsKey: true,
    signupUrl: "https://huggingface.co/settings/tokens",
    docsUrl: "https://huggingface.co/docs/api-inference",
    description: "HuggingFace 推理 API，免费但限速较严",
    protocol: "huggingface",
    freeQuota: "免费层：未严格公开，约 100 req/天",
  },
  {
    id: "together",
    name: "Together AI",
    endpoint: "https://api.together.xyz/v1/chat/completions",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    free: true,
    needsKey: true,
    signupUrl: "https://api.together.xyz/settings/api-keys",
    docsUrl: "https://docs.together.ai",
    description: "注册赠送 $5 免费额度，支持多种开源模型",
    protocol: "openai",
    freeQuota: "新用户 $5 免费额度",
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo AI Chat",
    endpoint: "https://duckduckgo.com/duckchat/v1/chat",
    model: "llama-3.3-70b",
    free: true,
    needsKey: false,
    signupUrl: "https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat",
    description: "非官方接口，无需 API Key，但可能不稳定或被反爬",
    protocol: "duckduckgo",
    freeQuota: "免费但无 SLA，可能限流",
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
