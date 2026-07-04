import { NextRequest, NextResponse } from "next/server";
import {
  readFinanceConfig,
  setFmpApiKey,
  setAvApiKey,
} from "@/lib/finance-config";

export const runtime = "nodejs";

/** GET /api/finance-config：读取财务数据源配置（不返回明文 Key，只返回脱敏） */
export async function GET() {
  const config = await readFinanceConfig();
  const fmpMasked = config.fmpApiKey ? `${config.fmpApiKey.slice(0, 4)}****${config.fmpApiKey.slice(-4)}` : "";
  const avMasked = config.avApiKey ? `${config.avApiKey.slice(0, 4)}****${config.avApiKey.slice(-4)}` : "";
  return NextResponse.json({
    fmpApiKeyMasked: fmpMasked,
    hasFmpKey: config.fmpApiKey !== "",
    avApiKeyMasked: avMasked,
    hasAvKey: config.avApiKey !== "",
    updatedAt: config.updatedAt,
  });
}

interface PatchBody {
  fmpApiKey?: string;
  avApiKey?: string;
}

/** PATCH /api/finance-config：更新 API Key */
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
    if (body.avApiKey !== undefined) {
      await setAvApiKey(body.avApiKey);
    }
    const config = await readFinanceConfig();
    const fmpMasked = config.fmpApiKey ? `${config.fmpApiKey.slice(0, 4)}****${config.fmpApiKey.slice(-4)}` : "";
    const avMasked = config.avApiKey ? `${config.avApiKey.slice(0, 4)}****${config.avApiKey.slice(-4)}` : "";
    return NextResponse.json({
      ok: true,
      fmpApiKeyMasked: fmpMasked,
      hasFmpKey: config.fmpApiKey !== "",
      avApiKeyMasked: avMasked,
      hasAvKey: config.avApiKey !== "",
      updatedAt: config.updatedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
