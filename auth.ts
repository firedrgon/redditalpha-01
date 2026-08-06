import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getPrisma } from "@/lib/db/prisma";
import bcrypt from "bcryptjs";
import { authConfig } from "./auth.config";

/**
 * 邮箱 + 密码注册/登录（Credentials Provider + JWT 会话）。
 * - 注册：用户在 /login/signup 填写邮箱+密码，服务端 /api/auth/register 用 bcrypt 哈希后写入 User.password。
 * - 登录：用户在 /login 填写邮箱+密码，NextAuth 调用 authorize() 校验 bcrypt 哈希。
 * - 不再依赖邮件（无 Resend / 魔法链接）。
 * - session 用 jwt 策略（Credentials Provider 要求 jwt，不能用 database 策略）。
 * - AUTH_SECRET 必须配置（生产环境），构建期用占位符避免 next build 报错。
 * - trustHost: true 在 Vercel 等托管环境必需。
 * - 全站登录保护由 auth.config.ts 的 authorized 回调 + middleware.ts 实现。
 * - 本文件运行在 Node.js 运行时（authorize 用到 Prisma），不可用于 Edge middleware。
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
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
        if (!user || !user.passwordHash) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
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
    ...authConfig.callbacks,
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
