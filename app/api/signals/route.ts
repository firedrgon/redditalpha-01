import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { user, response } = await requireUser();
  if (response || !user) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ signals: [], error: "数据库不可用" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
  const offset = parseInt(searchParams.get("offset") || "0");

  try {
    const where: Record<string, unknown> = { userId: user.id };
    if (ticker) {
      where.ticker = ticker.toUpperCase();
    }

    const [signals, total] = await Promise.all([
      prisma.signalAlert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.signalAlert.count({ where }),
    ]);

    return NextResponse.json({
      signals,
      total,
      hasMore: offset + signals.length < total,
    });
  } catch (err) {
    console.error("[api/signals] 获取信号失败:", err);
    return NextResponse.json(
      { signals: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const { user, response } = await requireUser();
  if (response || !user) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "缺少 id 参数" }, { status: 400 });
  }

  try {
    const result = await prisma.signalAlert.deleteMany({
      where: { id, userId: user.id },
    });

    return NextResponse.json({ success: true, deleted: result.count });
  } catch (err) {
    console.error("[api/signals] 删除信号失败:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
