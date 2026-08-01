import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 6;

export async function POST(request: NextRequest) {
  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库不可用，无法注册" }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "请输入有效的邮箱地址" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: `密码至少需要 ${MIN_PASSWORD} 位` },
      { status: 400 }
    );
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // 历史账号（早期无密码创建，如 Resend 魔法链接登录）没有密码字段，
      // 允许在注册页设置密码并接管该账号，避免「既不能注册设密、又不能密码登录」的死锁。
      if (!existing.password) {
        const hash = await bcrypt.hash(password, 10);
        await prisma.user.update({
          where: { email },
          data: { password: hash, emailVerified: new Date() },
        });
        return NextResponse.json(
          { ok: true, takenOver: true, user: { id: existing.id, email } },
          { status: 200 }
        );
      }
      return NextResponse.json({ error: "该邮箱已注册，请直接登录" }, { status: 409 });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hash, emailVerified: new Date() },
      select: { id: true, email: true },
    });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (err) {
    console.error("[register] 创建用户失败:", err);
    return NextResponse.json({ error: "注册失败，请稍后重试" }, { status: 500 });
  }
}
