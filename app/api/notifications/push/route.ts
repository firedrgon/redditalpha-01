import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth-guards";
import { getVapidPublicKey } from "@/lib/notify/webpush";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/push
 * 返回 VAPID 公钥，供前端订阅时使用。
 */
export async function GET() {
  return NextResponse.json({ publicKey: getVapidPublicKey() });
}

interface SubscribeBody {
  subscription?: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
}

/**
 * POST /api/notifications/push
 * 保存（upsert）当前用户的 Web Push 订阅。
 */
export async function POST(req: Request) {
  const { user, response } = await requireUser();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  let body: SubscribeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json(
      { error: "订阅信息不完整（需要 endpoint + keys.p256dh + keys.auth）" },
      { status: 400 }
    );
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: {
      userId: user.id,
      endpoint: sub.endpoint,
      keys: JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
    },
    update: { keys: JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }) },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/notifications/push
 * 删除当前用户的某条订阅（用户取消授权或退出登录时）。
 */
export async function DELETE(req: Request) {
  const { user, response } = await requireUser();
  if (response) return response;

  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  let endpoint: string | undefined;
  try {
    const body = await req.json();
    endpoint = body?.endpoint;
  } catch {
    // 允许无 body
  }

  if (!endpoint) {
    return NextResponse.json({ error: "缺少 endpoint" }, { status: 400 });
  }

  await prisma.pushSubscription.deleteMany({
    where: { userId: user.id, endpoint },
  });

  return NextResponse.json({ ok: true });
}
