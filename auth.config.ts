import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe NextAuth 配置（供 middleware 在 Edge Runtime 使用）。
 * - 不含任何 Node.js 依赖（无 Prisma、无 bcrypt），可在 Edge Runtime 运行。
 * - auth.ts 继承此配置并补充 Credentials Provider（需要 Node.js）。
 *
 * authorized 回调实现全站登录保护：
 *   · 公开路由：/login、/api/auth/*（NextAuth 回调）、/api/cron/*（用 CRON_SECRET 鉴权）
 *   · API 未登录 → 401 JSON（不重定向，便于前端 fetch 处理）
 *   · 页面未登录 → 重定向到 /login（NextAuth 自动附加 callbackUrl）
 */
export const authConfig = {
  trustHost: true,
  secret:
    process.env.AUTH_SECRET || "development-placeholder-secret-not-for-prod",
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [], // 由 auth.ts 填充（Credentials Provider 需要 Node.js）
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user;
      const { pathname } = request.nextUrl;

      // 公开路由：登录/注册、NextAuth API、cron（独立 CRON_SECRET 鉴权）
      if (
        pathname.startsWith("/login") ||
        pathname.startsWith("/api/auth") ||
        pathname.startsWith("/api/cron") ||
        // 只读研究工具：A 股公司质地打分（接口 + 页面均公开）
        pathname.startsWith("/api/company-quality") ||
        pathname.startsWith("/stock-quality")
      ) {
        return true;
      }

      // API 路由未登录 → 401 JSON
      if (pathname.startsWith("/api/")) {
        if (!isLoggedIn) {
          return Response.json(
            { error: "未登录，请先登录后再访问" },
            { status: 401 }
          );
        }
        return true;
      }

      // 页面未登录 → 重定向到 /login（自动带 callbackUrl）
      if (!isLoggedIn) {
        return false;
      }
      return true;
    },
  },
} satisfies NextAuthConfig;
