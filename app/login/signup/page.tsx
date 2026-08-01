"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError("请输入有效的邮箱地址");
      return;
    }
    if (password.length < 6) {
      setError("密码至少需要 6 位");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "注册失败，请稍后重试");
        setSubmitting(false);
        return;
      }
      // 注册成功 → 自动登录
      const loginRes = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl: "/",
      });
      if (loginRes?.error) {
        // 注册成功但自动登录失败：引导用户去登录页
        router.push("/login");
      } else {
        router.push("/");
      }
    } catch {
      setError("注册失败，请稍后重试");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex-1 flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
        <h1 className="text-2xl font-bold text-zinc-100">注册 Reddit Alpha</h1>
        <p className="mt-2 text-sm text-zinc-400">
          填写邮箱和密码即可创建账号。已有账号？{" "}
          <a href="/login" className="text-orange-400 underline underline-offset-2">
            去登录
          </a>
        </p>

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
          <div>
            <label className="block text-sm text-zinc-300 mb-1">密码（至少 6 位）</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-orange-500"
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-300 mb-1">确认密码</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-orange-500"
              autoComplete="new-password"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-orange-500 px-4 py-2 font-semibold text-white transition hover:bg-orange-400 disabled:opacity-60"
          >
            {submitting ? "注册中..." : "注册并登录"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <a href="/" className="text-sm text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
            返回首页
          </a>
        </div>
      </div>
    </main>
  );
}
