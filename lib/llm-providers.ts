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
  /** 调用方式：openai（OpenAI 兼容协议）/ gemini / duckduckgo */
  protocol: "openai" | "gemini" | "duckduckgo";
  freeQuota: string;
}

/** OpenRouter 系列 provider 共享同一 API Key */
export const OPENROUTER_PROVIDER_IDS = [
  "openrouter-nemotron-ultra",
  "openrouter-qwen3",
  "openrouter-gpt-oss-120b",
  "openrouter-llama-3.3",
  "openrouter-hermes-405b",
  "openrouter-free",
] as const;

/** Gemini 系列 provider 共享同一 API Key */
export const GEMINI_PROVIDER_IDS = [
  "gemini",
  "gemini-2.0",
] as const;

/** SiliconFlow 系列 provider 共享同一 API Key */
export const SILICONFLOW_PROVIDER_IDS = [
  "siliconflow-qwen-72b",
  "siliconflow-deepseek-v3",
  "siliconflow-deepseek-r1",
] as const;

/**
 * SiliconFlow 已知免费模型 ID 列表（用于动态刷新时过滤）。
 * 来源：https://cloud.siliconflow.cn/models 的"免费"标签
 *
 * 注意：SiliconFlow 的免费模型仅限部分开源小模型；DeepSeek-V3 / DeepSeek-R1 /
 * Llama-405B 等大模型均为付费（注册送 ¥14，用完需充值），不在此列表中。
 * 由 /api/llm-providers/refresh-models 定时验证并更新可用性。
 */
export const SILICONFLOW_KNOWN_FREE_MODELS = [
  "Qwen/Qwen2.5-72B-Instruct",
  "Qwen/Qwen2.5-7B-Instruct",
  "Qwen/Qwen2.5-14B-Instruct",
  "Qwen/Qwen2.5-Coder-32B-Instruct",
  "Qwen/Qwen2.5-Coder-7B-Instruct",
  "meta-llama/Meta-Llama-3.1-8B-Instruct",
  "THUDM/glm-4-9b-chat",
  "internlm/internlm2_5-7b-chat",
] as const;

/**
 * 自动选择活跃 provider 时的优先级（配额 + 质量综合优先）。
 *
 * 排序原则：
 *   1. 高配额免费层优先（Gemini 1500/天、Groq 14400/天、SiliconFlow Qwen 免费）
 *   2. 低配额免费层（OpenRouter 50/天共享）作为深度分析补充
 *   3. SiliconFlow 付费模型（DeepSeek V3/R1）再次之，需消耗 ¥14 余额
 *   4. 无需 Key 的兜底（DuckDuckGo）最后
 */
export const PREFERRED_ACTIVE_ORDER = [
  "gemini",
  "gemini-2.0",
  "groq",
  "siliconflow-qwen-72b",
  "openrouter-nemotron-ultra",
  "openrouter-qwen3",
  "openrouter-gpt-oss-120b",
  "openrouter-hermes-405b",
  "openrouter-llama-3.3",
  "openrouter-free",
  "siliconflow-deepseek-v3",
  "siliconflow-deepseek-r1",
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
    id: "openrouter-nemotron-ultra",
    name: "OpenRouter · Nemotron 3 Ultra 550B",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "550B 参数，1M 上下文，推理能力强，适合深度财务分析。与 OpenRouter 其他模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req（充值 $10 可升至 1000/天）",
  },
  {
    id: "openrouter-qwen3",
    name: "OpenRouter · Qwen3 Coder 480B",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "qwen/qwen3-coder:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "480B 参数，1M 上下文，中文表达自然，通用分析能力强",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "openrouter-gpt-oss-120b",
    name: "OpenRouter · GPT-OSS 120B",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-oss-120b:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenAI 开源 120B 模型，131K 上下文，分析能力均衡",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "openrouter-hermes-405b",
    name: "OpenRouter · Hermes 3 405B",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "nousresearch/hermes-3-llama-3.1-405b:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "405B 参数大模型，131K 上下文，叙述能力强",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
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
    id: "siliconflow-qwen-72b",
    name: "SiliconFlow · Qwen2.5 72B",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Qwen/Qwen2.5-72B-Instruct",
    free: true,
    needsKey: true,
    signupUrl: "https://cloud.siliconflow.cn/account/ak",
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions",
    description: "国内访问最快，Qwen 2.5 72B 中文表达自然，适合财务分析。注册送 ¥14",
    protocol: "openai",
    freeQuota: "免费模型不消耗余额，付费模型按量计费（注册送 ¥14）",
  },
  {
    id: "siliconflow-deepseek-v3",
    name: "SiliconFlow · DeepSeek V3",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "deepseek-ai/DeepSeek-V3",
    free: false,
    needsKey: true,
    signupUrl: "https://cloud.siliconflow.cn/account/ak",
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions",
    description: "DeepSeek V3 通用能力强，国内访问快。付费模型，注册送 ¥14 余额",
    protocol: "openai",
    freeQuota: "付费：约 ¥0.5/百万 tokens（注册送 ¥14）",
  },
  {
    id: "siliconflow-deepseek-r1",
    name: "SiliconFlow · DeepSeek R1",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "deepseek-ai/DeepSeek-R1",
    free: false,
    needsKey: true,
    signupUrl: "https://cloud.siliconflow.cn/account/ak",
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions",
    description: "DeepSeek R1 推理模型，适合深度财务推理。付费模型，会输出 reasoning_content",
    protocol: "openai",
    freeQuota: "付费：约 ¥0.6/百万 tokens（注册送 ¥14）",
  },
  {
    id: "openrouter-llama-3.3",
    name: "OpenRouter · Llama 3.3 70B",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "Llama 3.3 70B，131K 上下文，速度稳定，适合兜底",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
  },
  {
    id: "openrouter-free",
    name: "OpenRouter · Free Router",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openrouter/free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "OpenRouter 自动路由到可用的免费模型，200K 上下文",
    protocol: "openai",
    freeQuota: "免费层：约 20 req/min，每天 50 req",
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
