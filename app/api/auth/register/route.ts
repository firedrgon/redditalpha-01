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
      // 邮箱已存在：覆盖密码并接管该账号（支持「忘记密码」在注册页直接重设，
      // 无邮件验证的个人项目可接受；若日后需更强安全性可加原密码校验）。
      const hash = await bcrypt.hash(password, 10);
      await prisma.user.update({
        where: { email },
        data: { passwordHash: hash, emailVerified: new Date() },
      });
      return NextResponse.json(
        { ok: true, takenOver: true, user: { id: existing.id, email } },
        { status: 200 }
      );
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, passwordHash: hash, emailVerified: new Date() },
      select: { id: true, email: true },
    });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (err) {
    console.error("[register] 创建用户失败:", err);
    return NextResponse.json({ error: "注册失败，请稍后重试" }, { status: 500 });
  }
}
