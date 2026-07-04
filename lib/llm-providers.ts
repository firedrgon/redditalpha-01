/**
 * 免费 LLM 提供商清单（精选）
 *
 * 这些提供商均提供免费额度，部分需要注册获取 API Key。
 * 用户可在 .llm-config.json 或 LLM 设置 UI 中填入 API Key。
 *
 * 调用优先级（运行时按 enabled && hasKey 顺序选择）：
 *   1. 用户已配置 Key 且通过健康检查的提供商
 *   2. 任何已配置 Key 的可用提供商
 *   3. 不需要 Key 的提供商（如 DuckDuckGo，但非官方可能不稳定）
 */

export interface LLMProvider {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  free: boolean; // 是否有免费额度
  needsKey: boolean; // 是否必须 API Key
  signupUrl: string; // 注册/获取 Key 的地址
  docsUrl?: string;
  description: string;
  /** 调用方式：openai（OpenAI 兼容协议）/ gemini / huggingface / duckduckgo */
  protocol: "openai" | "gemini" | "huggingface" | "duckduckgo";
  /** 免费额度说明 */
  freeQuota: string;
}

/**
 * 精选的免费 LLM 提供商
 * 定期可在此列表更新（社区维护）
 */
export const LLM_PROVIDERS: LLMProvider[] = [
  {
    id: "groq",
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "超快推理速度，免费额度大方，支持 Llama 3.3 70B 等大模型",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "gemini-1.5-flash",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "Google 官方，gemini-1.5-flash 免费层稳定",
    protocol: "gemini",
    freeQuota: "免费层：15 req/min，每天 1500 req",
  },
  {
    id: "openrouter-free",
    name: "OpenRouter (免费模型)",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    description: "聚合多家模型，部分标记 :free 的模型可免费使用",
    protocol: "openai",
    freeQuota: "免费模型每天约 20-50 req（视模型而定）",
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
