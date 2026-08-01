import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  ticker: string | null;
  read: boolean;
  createdAt: number;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ notifications: [], unreadCount: 0 });
  }

  const { searchParams } = new URL(request.url);
  const unreadOnly = searchParams.get("unread") === "1";

  try {
    const unreadCount = await prisma.notification.count({
      where: { userId: user.id, read: false },
    });

    if (unreadOnly) {
      return NextResponse.json({ count: unreadCount });
    }

    const rows = await prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    const notifications: NotificationView[] = rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      url: n.url,
      ticker: n.ticker,
      read: n.read,
      createdAt: n.createdAt.getTime(),
    }));

    return NextResponse.json({ notifications, unreadCount });
  } catch (err) {
    console.error("[notifications] GET failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ success: false }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    all?: boolean;
  };

  try {
    if (body.all) {
      await prisma.notification.updateMany({
        where: { userId: user.id, read: false },
        data: { read: true },
      });
      return NextResponse.json({ success: true });
    }

    if (body.id) {
      await prisma.notification.update({
        where: { id: body.id },
        data: { read: true },
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "缺少 id 或 all" }, { status: 400 });
  } catch (err) {
    console.error("[notifications] PATCH failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
