import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

/**
 * 全站登录保护代理（Next.js 16 的 proxy 约定，替代已废弃的 middleware）。
 *
 * 用 authConfig（Edge-safe，无 Prisma/bcrypt）创建独立的 NextAuth 实例，
 * 复用 auth.config.ts 的 authorized 回调判断放行/拦截：
 *   - 公开路由（/login、/api/auth、/api/cron）直接放行
 *   - API 未登录 → 401 JSON
 *   - 页面未登录 → 重定向 /login?callbackUrl=...
 *
 * matcher 排除静态资源，避免拦截 CSS/JS/图片加载。
 */
export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    // 排除：Next.js 内部静态资源、favicon、public 下的静态文件、manifest
    "/((?!_next/static|_next/image|favicon.ico|icon\\.svg|manifest\\.json|.*\\.(?:png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map)$).*)",
  ],
};
