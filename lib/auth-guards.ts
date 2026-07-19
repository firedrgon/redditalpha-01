import { NextResponse } from "next/server";
import { auth } from "@/auth";

export interface SessionUser {
  id: string;
  email?: string | null;
  name?: string | null;
  isAdmin: boolean;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isAdmin: Boolean(session.user.isAdmin),
  };
}

export async function requireUser() {
  const user = await getSessionUser();
  if (!user) {
    return {
      user: null,
      response: NextResponse.json({ error: "请先登录" }, { status: 401 }),
    };
  }

  return { user, response: null };
}

export async function requireAdmin() {
  const { user, response } = await requireUser();
  if (response) return { user: null, response };

  if (!user?.isAdmin) {
    return {
      user: null,
      response: NextResponse.json({ error: "仅管理员可访问" }, { status: 403 }),
    };
  }

  return { user, response: null };
}
