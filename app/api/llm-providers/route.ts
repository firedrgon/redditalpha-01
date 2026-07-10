import { NextRequest, NextResponse } from "next/server";
import {
  readConfig,
  setProviderKey,
  setProviderEnabled,
  setActiveProvider,
} from "@/lib/llm-config";
import { LLM_PROVIDERS } from "@/lib/llm-providers";
import { refreshProviderStatuses, testProvider } from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/llm-providers：列出所有 provider 及状态，按 激活→可用→不可用 排序 */
export async function GET() {
  const config = await readConfig();
  const list = LLM_PROVIDERS.map((p) => {
    const status = config.providers[p.id] ?? {
      id: p.id,
      apiKey: "",
      keySource: "none" as const,
      enabled: false,
      lastTested: null,
      working: null,
      lastError: null,
    };
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      model: p.model,
      protocol: p.protocol,
      free: p.free,
      needsKey: p.needsKey,
      signupUrl: p.signupUrl,
      docsUrl: p.docsUrl,
      freeQuota: p.freeQuota,
      apiKeyMasked: status.apiKey
        ? `${status.apiKey.slice(0, 4)}****${status.apiKey.slice(-4)}`
        : "",
      hasKey: status.apiKey !== "",
      keySource: status.keySource, // "env" | "local" | "none"
      envVarName: `LLM_API_KEY_${p.id.toUpperCase().replace(/-/g, "_")}`,
      enabled: status.enabled,
      working: status.working,
      lastTested: status.lastTested,
      lastError: status.lastError,
    };
  });

  // 排序：激活的 → 可用的(working=true) → 不可用的(working=false/null)
  // 同组内保持 LLM_PROVIDERS 声明顺序
  const rank = (p: (typeof list)[number]) => {
    if (config.activeProvider === p.id) return 0;
    if (p.working === true) return 1;
    return 2;
  };
  list.sort((a, b) => rank(a) - rank(b));

  return NextResponse.json({
    providers: list,
    activeProvider: config.activeProvider,
    updatedAt: config.updatedAt,
  });
}

interface PatchBody {
  action: "setKey" | "setEnabled" | "setActive";
  providerId?: string;
  apiKey?: string;
  enabled?: boolean;
}

/** PATCH /api/llm-providers：更新单个 provider 的 Key/启用状态/活跃 */
export async function PATCH(request: NextRequest) {
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "无效的 JSON 请求体" }, { status: 400 });
  }

  const { action, providerId, apiKey, enabled } = body;
  if (!providerId && action !== "setActive") {
    return NextResponse.json({ error: "缺少 providerId" }, { status: 400 });
  }

  try {
    let config;
    switch (action) {
      case "setKey":
        if (!providerId) throw new Error("缺少 providerId");
        config = await setProviderKey(providerId, apiKey ?? "");
        break;
      case "setEnabled":
        if (!providerId) throw new Error("缺少 providerId");
        if (typeof enabled !== "boolean")
          throw new Error("enabled 必须为 boolean");
        config = await setProviderEnabled(providerId, enabled);
        break;
      case "setActive":
        config = await setActiveProvider(providerId ?? null);
        break;
      default:
        return NextResponse.json({ error: `未知 action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

interface PostBody {
  /** 测试单个 provider，否则测试所有已启用的 */
  providerId?: string;
}

/** POST /api/llm-providers：测试 provider 可用性，结果写回本地配置文件 */
export async function POST(request: NextRequest) {
  let body: PostBody = {};
  try {
    body = (await request.json()) as PostBody;
  } catch {
    // 空 body 也允许：测试所有
  }

  if (body.providerId) {
    const result = await testProvider(body.providerId);
    // 测试结果已由 testProvider 内部写入；这里再读取一次确保返回最新
    return NextResponse.json({
      results: [{ id: body.providerId, name: body.providerId, ...result }],
    });
  }

  const { results } = await refreshProviderStatuses();
  return NextResponse.json({ results });
}
