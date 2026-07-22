import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth-guards";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications?limit=30
 * 返回当前用户的通知列表 + 未读计数。
 */
export async function GET(req: Request) {
  const { user, response } = await requireUser();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "30", 10) || 30, 1), 100);

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({ where: { userId: user.id, read: false } }),
  ]);

  return NextResponse.json({ notifications, unreadCount });
}

/**
 * POST /api/notifications
 *  - { id }            → 标记单条为已读
 *  - { action: "read-all" } → 标记全部为已读
 */
export async function POST(req: Request) {
  const { user, response } = await requireUser();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  let body: { id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  if (body.action === "read-all") {
    await prisma.notification.updateMany({
      where: { userId: user.id, read: false },
      data: { read: true },
    });
    const unreadCount = 0;
    return NextResponse.json({ ok: true, unreadCount });
  }

  if (body.id) {
    await prisma.notification.updateMany({
      where: { userId: user.id, id: body.id },
      data: { read: true },
    });
    const unreadCount = await prisma.notification.count({
      where: { userId: user.id, read: false },
    });
    return NextResponse.json({ ok: true, unreadCount });
  }

  return NextResponse.json({ error: "缺少 id 或 action" }, { status: 400 });
}
