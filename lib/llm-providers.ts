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
  /**
   * 是否需要用户在 UI 自定义模型标识。
   * 例如火山引擎豆包：API 的 model 必须是用户自己创建的推理接入点 Endpoint ID（ep- 开头），
   * 而非固定的模型名，因此需在设置页暴露「模型/接入点 ID」编辑框让用户填写。
   */
  customModel?: boolean;
  /**
   * 模型上下文窗口（token 数）。用于把 max_tokens 钳制在窗口内，
   * 避免 Groq 等小窗口模型因「prompt + max_tokens 超窗」返回 413。
   * 缺省时由 resolveMaxTokens 用保守默认值兜底。
   */
  contextWindow?: number;
  /**
   * 单次请求允许的最大「输出」token 数（由 TPM 限制倒推）。
   * Groq 免费档按 TPM（tokens per minute，含 input+output）限流，且单请求
   * input+output 不得超过 TPM，否则直接 413。部分模型 TPM 很小
   * （如 openai/gpt-oss-120b 仅 8000），即便上下文窗口 128K，单请求输出
   * 也必须压到 TPM − 输入估算 以下。设置此值后 resolveMaxTokens 会把它作为
   * 硬性输出上限（与上下文窗口上限取较小者），避免 413。
   * 缺省为不限（仅靠上下文窗口钳制）。
   */
  maxOutputTokens?: number;
  /**
   * 是否在设置页的模型列表中隐藏。
   * 用于收起在海外部署下不可用/不稳定的国产模型（智谱、通义、Kimi、豆包）。
   * 隐藏后仍保留配置与调用能力，仅不展示在 UI 列表；置 false 即可恢复显示。
   */
  hidden?: boolean;
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
] as const;

/** 智谱系列 provider 共享同一 API Key（LLM_API_KEY_ZHIPU / ZHIPU_API_KEY） */
export const ZHIPU_PROVIDER_IDS = [
  "zhipu-1",
  "zhipu-2",
] as const;

/**
 * 通义千问 / 阿里云百炼系列 provider 共享同一 API Key（LLM_API_KEY_QWEN / DASHSCOPE_API_KEY）。
 *
 * 端点默认走百炼【国际站】（dashscope-intl，新加坡），可在 Vercel 等海外节点直连。
 * 如需改用国内站（用自己的百炼免费额度，但 Vercel 海外会被 GFW 阻断超时），
 * 设环境变量 QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions 即可。
 */
export const QWEN_BASE_URL =
  process.env.QWEN_BASE_URL?.trim() ||
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

export const QWEN_PROVIDER_IDS = [
  "qwen-1",
  "qwen-2",
  "qwen-3",
  "qwen-4",
  "qwen-5",
  "qwen-6",
  "qwen-7",
] as const;

/** Kimi（月之暗面）系列 provider 共享同一 API Key（LLM_API_KEY_KIMI / MOONSHOT_API_KEY） */
export const KIMI_PROVIDER_IDS = ["kimi-1"] as const;

/** 豆包（火山引擎方舟）系列 provider 共享同一 API Key（LLM_API_KEY_DOUBAO / DOUBAO_API_KEY） */
export const DOUBAO_PROVIDER_IDS = ["doubao-1"] as const;

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
  "qwen-1",
  "deepseek-1",
  "groq-1",
  "groq-2",
  "openrouter-1",
] as const;

export const LLM_PROVIDERS: LLMProvider[] = [
  {
    id: "gemini-1",
    contextWindow: 1_048_576,
    name: "Google Gemini 3.5 Flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "gemini-3.5-flash",
    free: true,
    needsKey: true,
    signupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    description: "推荐主力：最新稳定 Flash（2026-05 发布），中文好、指令遵循强，适合结构化财务分析。与其他 Gemini 模型共用 Key",
    protocol: "gemini",
    freeQuota: "免费层：约 15 req/min，每天 1500 req",
  },
  {
    id: "gemini-2",
    contextWindow: 1_048_576,
    name: "Google Gemini 3.1 Flash Lite",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    model: "gemini-3.1-flash-lite",
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
    contextWindow: 128_000,
    name: "OpenRouter · Free Models Router",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openrouter/free",
    free: true,
    needsKey: true,
    signupUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground",
    description:
      "OpenRouter 官方 Free Models Router：自动从当前可用的免费模型中挑选最合适的（按是否支持工具调用/结构化输出等特性智能过滤），不会因某个模型下架而 404。与其他 OpenRouter 配置共用 Key",
    protocol: "openai",
    freeQuota: "免费层：路由到多个免费模型，整体配额远高于单一免费模型（充值 $10 后每日上限提升）",
  },
  {
    id: "deepseek-1",
    contextWindow: 64_000,
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
    contextWindow: 131_072,
    maxOutputTokens: 4000,
    name: "Groq · GPT-OSS 120B",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "OpenAI 开源 120B 推理模型，分析深度强、指令遵循好，131K 上下文。与其他 Groq 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req（Groq 系列共享配额）",
  },
  {
    id: "groq-2",
    contextWindow: 131_072,
    name: "Groq · Llama 3.3 70B",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    free: true,
    needsKey: true,
    signupUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
    description: "Meta Llama 3.3 70B，Groq 官方 Production 模型、免费档稳定可达，131K 上下文 + 32K 最大输出，通用分析质量高，适合财务研报。与其他 Groq 模型共用 Key",
    protocol: "openai",
    freeQuota: "免费层：30 req/min，每天 14400 req（Groq 系列共享配额）",
  },
  {
    id: "zhipu-1",
    contextWindow: 128_000,
    name: "智谱 GLM-4-Flash",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
    free: true,
    needsKey: true,
    signupUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    docsUrl: "https://open.bigmodel.cn/dev/howuse/introduction",
    description:
      "国产智谱 GLM-4-Flash：永久免费、中文强、128K 上下文，适合中文股票分析主力替补。与其他智谱配置共用 Key",
    protocol: "openai",
    freeQuota: "免费层：Flash 系列永久免费；注册送 2000 万 token（永久有效），QPS≈2",
    hidden: true,
  },
  {
    id: "zhipu-2",
    contextWindow: 128_000,
    name: "智谱 GLM-4.7-Flash",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.7-flash",
    free: true,
    needsKey: true,
    signupUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    docsUrl: "https://open.bigmodel.cn/dev/howuse/introduction",
    description:
      "智谱最新 GLM-4.7-Flash：免费、质量优于 GLM-4-Flash，128K 上下文，适合深度中文分析。与其他智谱配置共用 Key",
    protocol: "openai",
    freeQuota: "免费层：GLM-4.7-Flash 永久免费；注册送 2000 万 token（永久有效）",
    hidden: true,
  },
  {
    id: "qwen-1",
    contextWindow: 128_000,
    name: "阿里云百炼 · Qwen3.7-Flash (2026-07-15)",
    endpoint: QWEN_BASE_URL,
    model: "qwen3.7-flash-2026-07-15",
    free: true,
    needsKey: true,
    signupUrl: "https://www.alibabacloud.com/product/model-studio",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api",
    description:
      "百炼国际站 Qwen3.7-Flash 快照版：快、便宜，免费额度用尽会自动切换下一个 Qwen 模型再兜底其他家族。与其他通义配置共用 Key",
    protocol: "openai",
    freeQuota: "百炼国际站免费额度（各模型独立，耗尽即自动切换下一个 Qwen 模型）",
  },
  {
    id: "qwen-2",
    contextWindow: 128_000,
    name: "阿里云百炼 · Qwen3.7-Plus",
    endpoint: QWEN_BASE_URL,
    model: "qwen3.7-plus",
    free: true,
    needsKey: true,
    signupUrl: "https://www.alibabacloud.com/product/model-studio",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api",
    description:
      "百炼国际站 Qwen3.7-Plus：均衡型，质量优于 Flash，免费额度与其他 Qwen 模型相互独立。与其他通义配置共用 Key",
    protocol: "openai",
    freeQuota: "百炼国际站免费额度（各模型独立，耗尽即自动切换下一个 Qwen 模型）",
  },
  {
    id: "qwen-3",
    contextWindow: 128_000,
    name: "阿里云百炼 · Qwen3.7-Max",
    endpoint: QWEN_BASE_URL,
    model: "qwen3.7-max",
    free: true,
    needsKey: true,
    signupUrl: "https://www.alibabacloud.com/product/model-studio",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api",
    description:
      "百炼国际站 Qwen3.7-Max（最新稳定版）：旗舰质量，适合深度研报，免费额度独立。与其他通义配置共用 Key",
    protocol: "openai",
    freeQuota: "百炼国际站免费额度（各模型独立，耗尽即自动切换下一个 Qwen 模型）",
  },
  {
    id: "qwen-4",
    contextWindow: 128_000,
    name: "阿里云百炼 · Qwen3.7-Max (2026-05-17)",
    endpoint: QWEN_BASE_URL,
    model: "qwen3.7-max-2026-05-17",
    free: true,
    needsKey: true,
    signupUrl: "https://www.alibabacloud.com/product/model-studio",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api",
    description:
      "百炼国际站 Qwen3.7-Max 早期快照（2026-05-17）：Max 系列额度兜底替补。与其他通义配置共用 Key",
    protocol: "openai",
    freeQuota: "百炼国际站免费额度（各模型独立，耗尽即自动切换下一个 Qwen 模型）",
  },
  {
    id: "qwen-5",
    contextWindow: 128_000,
    name: "阿里云百炼 · Qwen3.7-Max (2026-05-20)",
    endpoint: QWEN_BASE_URL,
    model: "qwen3.7-max-2026-05-20",
    free: true,
    needsKey: true,
    signupUrl: "https://www.alibabacloud.com/product/model-studio",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api",
    description:
      "百炼国际站 Qwen3.7-Max 快照（2026-05-20）：Max 系列额度兜底替补。与其他通义配置共用 Key",
    protocol: "openai",
    freeQuota: "百炼国际站免费额度（各模型独立，耗尽即自动切换下一个 Qwen 模型）",
  },
  {
    id: "qwen-6",
    contextWindow: 128_000,
    name: "阿里云百炼 · Qwen3.7-Max (2026-06-08)",
    endpoint: QWEN_BASE_URL,
    model: "qwen3.7-max-2026-06-08",
    free: true,
    needsKey: true,
    signupUrl: "https://www.alibabacloud.com/product/model-studio",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api",
    description:
      "百炼国际站 Qwen3.7-Max 快照（2026-06-08）：Max 系列额度兜底替补。与其他通义配置共用 Key",
    protocol: "openai",
    freeQuota: "百炼国际站免费额度（各模型独立，耗尽即自动切换下一个 Qwen 模型）",
  },
  {
    id: "qwen-7",
    contextWindow: 128_000,
    name: "阿里云百炼 · Qwen3.7-Max-Preview",
    endpoint: QWEN_BASE_URL,
    model: "qwen3.7-max-preview",
    free: true,
    needsKey: true,
    signupUrl: "https://www.alibabacloud.com/product/model-studio",
    docsUrl:
      "https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api",
    description:
      "百炼国际站 Qwen3.7-Max-Preview（预览版）：最新能力尝鲜，免费额度独立。与其他通义配置共用 Key",
    protocol: "openai",
    freeQuota: "百炼国际站免费额度（各模型独立，耗尽即自动切换下一个 Qwen 模型）",
  },
  {
    id: "kimi-1",
    contextWindow: 128_000,
    name: "Kimi · Moonshot v1-128K",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-128k",
    free: true,
    needsKey: true,
    signupUrl: "https://platform.moonshot.cn",
    docsUrl: "https://platform.moonshot.cn/docs/api/overview",
    description:
      "月之暗面 Kimi：长文本强项（128K）、中文好、兼容 OpenAI。新用户送 ¥15 免费额度。与其他 Kimi 配置共用 Key",
    protocol: "openai",
    freeQuota: "免费额度：新用户送 ¥15 试用额度（rate-limited free tier）；moonshot-v1-128k 按量 ¥60/MTok",
    hidden: true,
  },
  {
    id: "doubao-1",
    contextWindow: 32_000,
    name: "豆包 · 火山引擎方舟",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    model: "doubao-pro-32k",
    free: true,
    needsKey: true,
    customModel: true,
    signupUrl: "https://console.volcengine.com/ark",
    docsUrl: "https://www.volcengine.com/docs/82379",
    description:
      "字节豆包大模型，中文强、便宜。⚠️ 需先在火山方舟创建推理接入点，再把下方「模型/接入点 ID」改为你的 Endpoint ID（ep- 开头）。与其他豆包配置共用 Key",
    protocol: "openai",
    freeQuota: "免费额度：注册送体验额度；doubao-pro-32k 按量计费，doubao-lite 更便宜",
    hidden: true,
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
