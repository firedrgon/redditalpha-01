"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const sent = params.get("sent") === "1";
  const { status } = useSession();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已登录则直接回首页
  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError("请输入有效的邮箱地址");
      return;
    }
    setSubmitting(true);
    try {
      // Resend 邮件魔法链接：发送后 NextAuth 会重定向到 verifyRequest 页（/login?sent=1）
      const res = await signIn("resend", {
        email,
        redirect: false,
        callbackUrl: "/",
      });
      if (res?.error) {
        setError("发送失败，请稍后重试或检查邮件服务配置");
        setSubmitting(false);
      } else {
        router.push("/login?sent=1");
      }
    } catch {
      setError("发送失败，请稍后重试");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex-1 flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
        <h1 className="text-2xl font-bold text-zinc-100">登录 Reddit Alpha</h1>
        <p className="mt-2 text-sm text-zinc-400">
          输入邮箱，我们会发送一个一次性登录链接。无需密码。
        </p>

        {sent ? (
          <div className="mt-6 rounded-lg border border-emerald-700/50 bg-emerald-900/20 p-4 text-sm text-emerald-200">
            登录链接已发送到 <span className="font-semibold">{email || "你的邮箱"}</span>
            。请查收邮件并点击链接完成登录。
            <div className="mt-3">
              <button
                onClick={() => router.push("/login")}
                className="text-emerald-300 underline underline-offset-2"
              >
                重新输入邮箱
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label className="block text-sm text-zinc-300 mb-1">邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-orange-500"
                autoComplete="email"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-orange-500 px-4 py-2 font-semibold text-white transition hover:bg-orange-400 disabled:opacity-60"
            >
              {submitting ? "发送中..." : "发送登录链接"}
            </button>
          </form>
        )}

        <div className="mt-6 text-center">
          <a href="/" className="text-sm text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
            返回首页
          </a>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <LoginInner />
    </Suspense>
  );
}
