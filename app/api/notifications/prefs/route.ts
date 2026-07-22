import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth-guards";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/prefs
 * 返回当前用户的通知偏好（emailNotify / webpushNotify）。
 */
export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, emailNotify: true, webpushNotify: true },
  });
  if (!dbUser) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  return NextResponse.json({
    email: dbUser.email,
    emailNotify: dbUser.emailNotify,
    webpushNotify: dbUser.webpushNotify,
  });
}

/**
 * POST /api/notifications/prefs
 * 更新通知偏好。body: { emailNotify?: boolean, webpushNotify?: boolean }
 * 关闭 webpushNotify 时一并清理该用户所有订阅（避免无效推送）。
 */
export async function POST(req: Request) {
  const { user, response } = await requireUser();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  let body: { emailNotify?: boolean; webpushNotify?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  const data: { emailNotify?: boolean; webpushNotify?: boolean } = {};
  if (typeof body.emailNotify === "boolean") data.emailNotify = body.emailNotify;
  if (typeof body.webpushNotify === "boolean") data.webpushNotify = body.webpushNotify;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: { emailNotify: true, webpushNotify: true },
  });

  // 关闭 Web Push → 清理订阅
  if (data.webpushNotify === false) {
    await prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
  }

  return NextResponse.json({ ok: true, ...updated });
}
