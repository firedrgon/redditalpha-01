import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { getPrisma } from "@/lib/db/prisma";

const prisma = getPrisma();
const adapter = prisma ? PrismaAdapter(prisma) : undefined;

/**
 * 邮箱魔法链接登录（Resend）。
 * - 登录方式：用户在 /login 输入邮箱 → Resend 发送含一次性登录链接的邮件。
 * - 需要环境变量：RESEND_API_KEY（Resend API Key）、EMAIL_FROM（发件人，缺省用 Resend 测试发件域）。
 * - AUTH_SECRET 必须配置（生产环境），构建期用占位符避免 next build 报错。
 * - trustHost: true 在 Vercel 等托管环境必需（信任 Host 头生成回调地址）。
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  trustHost: true,
  secret: process.env.AUTH_SECRET || "development-placeholder-secret-not-for-prod",
  session: { strategy: "database" },
  pages: {
    signIn: "/login",
    verifyRequest: "/login?sent=1",
  },
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
    }),
  ],
});
