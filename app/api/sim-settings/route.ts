import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { requireAdmin } from "@/lib/auth-guards";

export const runtime = "nodejs";

const KEY_CN = "simCapitalPerTradeCN";
const KEY_US = "simCapitalPerTradeUS";
const DEFAULT_CN = 10000;
const DEFAULT_US = 10000;

/** 读取某个本金配置（AppSetting 存纯数字字符串） */
async function readCapital(
  prisma: NonNullable<Awaited<ReturnType<typeof getPrisma>>>,
  key: string,
  fallback: number
): Promise<number> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** GET /api/sim-settings：读取美股/ A 股每笔虚拟本金（admin） */
export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ cn: DEFAULT_CN, us: DEFAULT_US });
  }

  const [cn, us] = await Promise.all([
    readCapital(prisma, KEY_CN, DEFAULT_CN),
    readCapital(prisma, KEY_US, DEFAULT_US),
  ]);

  return NextResponse.json({ cn, us });
}

interface PatchBody {
  cn?: number | string;
  us?: number | string;
}

/** PATCH /api/sim-settings：更新每笔虚拟本金（admin） */
export async function PATCH(request: NextRequest) {
  const { response } = await requireAdmin();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库未配置" }, { status: 500 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "无效的 JSON 请求体" }, { status: 400 });
  }

  const parsed: Record<string, number> = {};
  for (const [k, raw] of Object.entries(body)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json(
        { error: `本金必须为正数：${k}=${raw}` },
        { status: 400 }
      );
    }
    parsed[k] = n;
  }

  try {
    if (parsed.cn !== undefined) {
      await prisma.appSetting.upsert({
        where: { key: KEY_CN },
        create: { key: KEY_CN, value: String(parsed.cn) },
        update: { value: String(parsed.cn) },
      });
    }
    if (parsed.us !== undefined) {
      await prisma.appSetting.upsert({
        where: { key: KEY_US },
        create: { key: KEY_US, value: String(parsed.us) },
        update: { value: String(parsed.us) },
      });
    }
    const cn = await readCapital(prisma, KEY_CN, DEFAULT_CN);
    const us = await readCapital(prisma, KEY_US, DEFAULT_US);
    return NextResponse.json({ ok: true, cn, us });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
