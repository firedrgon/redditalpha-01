import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getPrisma } from "@/lib/db/prisma";
import bcrypt from "bcryptjs";

/**
 * 邮箱 + 密码注册/登录（Credentials Provider + JWT 会话）。
 * - 注册：用户在 /login/signup 填写邮箱+密码，服务端 /api/auth/register 用 bcrypt 哈希后写入 User.password。
 * - 登录：用户在 /login 填写邮箱+密码，NextAuth 调用 authorize() 校验 bcrypt 哈希。
 * - 不再依赖邮件（无 Resend / 魔法链接）。
 * - session 用 jwt 策略（Credentials Provider 要求 jwt，不能用 database 策略）。
 * - AUTH_SECRET 必须配置（生产环境），构建期用占位符避免 next build 报错。
 * - trustHost: true 在 Vercel 等托管环境必需。
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET || "development-placeholder-secret-not-for-prod",
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "邮箱密码",
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" },
      },
      async authorize(credentials) {
        const email = (credentials?.email as string | undefined)?.trim().toLowerCase();
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const prisma = getPrisma();
        if (!prisma) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        // 没有密码字段的用户（例如仅第三方登录）不允许用密码登录
        if (!user || !user.password) return null;

        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.id = (user as { id?: string }).id;
      return token;
    },
    async session({ session, token }) {
      if (token.id && session.user) {
        (session.user as { id?: string }).id = token.id as string;
      }
      return session;
    },
  },
});
