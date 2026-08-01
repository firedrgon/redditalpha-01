"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import GlobalSignalBell from "./GlobalSignalBell";
import UserBell from "./UserBell";

/**
 * 顶部右侧的账户区：
 *  - 登录态：用户专属通知中心（UserBell）+ 邮箱 + 退出
 *  - 未登录：全局信号铃铛（GlobalSignalBell，无需登录）+ 登录入口
 *  - 加载中：先显示全局铃铛，避免闪烁
 */
export default function AuthMenu() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <GlobalSignalBell />;
  }

  if (!session) {
    return (
      <>
        <GlobalSignalBell />
        <Link
          href="/login"
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-orange-500 hover:text-white"
        >
          登录
        </Link>
      </>
    );
  }

  return (
    <>
      <UserBell />
      <div className="flex items-center gap-2">
        <span className="hidden max-w-[140px] truncate text-xs text-zinc-400 sm:inline">
          {session.user?.email}
        </span>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-500 hover:text-white"
        >
          退出
        </button>
      </div>
    </>
  );
}
