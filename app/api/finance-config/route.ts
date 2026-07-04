import { NextRequest, NextResponse } from "next/server";
import {
  readFinanceConfig,
  setFmpApiKey,
  setAvApiKey,
  setTiingoApiKey,
  setFinnhubApiKey,
} from "@/lib/finance-config";

export const runtime = "nodejs";

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function buildResponse(config: {
  fmpApiKey: string;
  avApiKey: string;
  tiingoApiKey: string;
  finnhubApiKey: string;
  updatedAt: number;
}) {
  return {
    fmpApiKeyMasked: maskKey(config.fmpApiKey),
    hasFmpKey: config.fmpApiKey !== "",
    avApiKeyMasked: maskKey(config.avApiKey),
    hasAvKey: config.avApiKey !== "",
    tiingoApiKeyMasked: maskKey(config.tiingoApiKey),
    hasTiingoKey: config.tiingoApiKey !== "",
    finnhubApiKeyMasked: maskKey(config.finnhubApiKey),
    hasFinnhubKey: config.finnhubApiKey !== "",
    updatedAt: config.updatedAt,
  };
}

/** GET /api/finance-config：读取财务数据源配置（不返回明文 Key，只返回脱敏） */
export async function GET() {
  const config = await readFinanceConfig();
  return NextResponse.json(buildResponse(config));
}

interface PatchBody {
  fmpApiKey?: string;
  avApiKey?: string;
  tiingoApiKey?: string;
  finnhubApiKey?: string;
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
    if (body.tiingoApiKey !== undefined) {
      await setTiingoApiKey(body.tiingoApiKey);
    }
    if (body.finnhubApiKey !== undefined) {
      await setFinnhubApiKey(body.finnhubApiKey);
    }
    const config = await readFinanceConfig();
    return NextResponse.json({
      ok: true,
      ...buildResponse(config),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
