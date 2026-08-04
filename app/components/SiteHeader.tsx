"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import AuthMenu from "./AuthMenu";

interface NavChild {
  href: string;
  label: string;
}
interface NavItem {
  href: string;
  label: string;
  children?: NavChild[];
}

const NAV: NavItem[] = [
  { href: "/", label: "首页" },
  { href: "/hot", label: "热榜" },
  { href: "/stock-report", label: "研报" },
  {
    href: "/etf-trend",
    label: "ETF主升浪",
    children: [
      { href: "/etf-trend?tab=pullback", label: "趋势回踩" },
      { href: "/etf-trend?tab=newPool", label: "新入池" },
    ],
  },
  { href: "/signals", label: "信号提醒" },
  { href: "/admin", label: "后台" },
];

function isActive(pathname: string, href: string) {
  // 去掉 query 后再比较（带 ?tab= 的子项也匹配父路由）
  const base = href.split("?")[0];
  if (base === "/") return pathname === "/";
  return pathname === base || pathname.startsWith(base + "/");
}

function DropdownItem({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 离开组件时关闭，避免游走后仍停留
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const active = isActive(pathname, item.href);

  const enter = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <li
      className="relative"
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <Link
        href={item.href}
        className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          active
            ? "text-orange-400"
            : "text-zinc-400 hover:text-zinc-100"
        }`}
      >
        {item.label}
        <svg
          viewBox="0 0 24 24"
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </Link>
      {open && item.children && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[8rem] rounded-lg border border-zinc-800 bg-zinc-900/95 p-1 shadow-xl backdrop-blur-md">
          {item.children.map((c) => {
            const childActive =
              isActive(pathname, c.href) && pathname === "/etf-trend";
            return (
              <Link
                key={c.href}
                href={c.href}
                className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                  childActive
                    ? "bg-orange-500/10 text-orange-400"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
                }`}
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      )}
    </li>
  );
}

export default function SiteHeader({ right }: { right?: ReactNode }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md">
      <div className="page-gutter flex h-14 items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-orange-500/15 text-orange-400">
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
                />
              </svg>
            </span>
            <span className="text-base font-semibold tracking-tight text-zinc-100">
              Reddit Alpha
            </span>
          </Link>

          <nav className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) =>
              item.children ? (
                <DropdownItem key={item.href} item={item} />
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive(pathname, item.href)
                      ? "text-orange-400"
                      : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {item.label}
                </Link>
              )
            )}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <AuthMenu />
          {right}
        </div>
      </div>
    </header>
  );
}
