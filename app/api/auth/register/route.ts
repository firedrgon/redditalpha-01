import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth/password";
import {
  createUserWithPassword,
  getUserByEmail,
  promoteFirstAdminAndMigrateLegacyFavorites,
} from "@/lib/db/users";
import { getPrisma } from "@/lib/db/prisma";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const prisma = getPrisma();
  if (!prisma) {
    return NextResponse.json({ error: "数据库未配置，无法注册" }, { status: 503 });
  }

  let body: { email?: string; password?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const name = body.name?.trim() || null;

  if (!email || !password) {
    return NextResponse.json({ error: "邮箱和密码不能为空" }, { status: 400 });
  }
  if (!EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "密码至少 6 位" }, { status: 400 });
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 });
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await createUserWithPassword({ email, passwordHash, name });
    await promoteFirstAdminAndMigrateLegacyFavorites(user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[auth/register] 注册失败:", error);
    return NextResponse.json({ error: "注册失败，请稍后重试" }, { status: 500 });
  }
}
