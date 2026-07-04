import { NextRequest, NextResponse } from "next/server";
import {
  readFinanceConfig,
  setFmpApiKey,
} from "@/lib/finance-config";

export const runtime = "nodejs";

/** GET /api/finance-config：读取财务数据源配置（不返回明文 Key，只返回脱敏） */
export async function GET() {
  const config = await readFinanceConfig();
  const key = config.fmpApiKey;
  const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : "";
  return NextResponse.json({
    fmpApiKeyMasked: masked,
    hasFmpKey: key !== "",
    updatedAt: config.updatedAt,
  });
}

interface PatchBody {
  fmpApiKey?: string;
}

/** PATCH /api/finance-config：更新 FMP API Key */
export async function PATCH(request: NextRequest) {
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "无效的 JSON 请求体" }, { status: 400 });
  }

  try {
    if (body.fmpApiKey !== undefined) {
      await setFmpApiKey(body.fmpApiKey);
    }
    const config = await readFinanceConfig();
    const key = config.fmpApiKey;
    const masked = key ? `${key.slice(0, 4)}****${key.slice(-4)}` : "";
    return NextResponse.json({
      ok: true,
      fmpApiKeyMasked: masked,
      hasFmpKey: key !== "",
      updatedAt: config.updatedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
