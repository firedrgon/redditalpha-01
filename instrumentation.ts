/**
 * Next.js Instrumentation Hook
 * 在服务端启动时执行一次：用于初始化 LLM provider 健康检查的定时任务。
 *
 * 定时收集保存在本地：每 24 小时检查一次所有启用的 LLM provider，
 * 把 working 状态写回 .llm-config.json，避免每次调用都重新探测。
 */

export async function register() {
  // 仅在 Node.js runtime（服务端）执行
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 小时
  const INITIAL_DELAY_MS = 30 * 1000; // 启动后 30 秒再开始

  // 动态导入，避免在 Edge 编译期被 bundle
  const { refreshProviderStatuses } = await import("./lib/llm");

  const trigger = async () => {
    try {
      const { results } = await refreshProviderStatuses();
      const okCount = results.filter((r) => r.ok).length;
      console.log(
        `[llm-providers] 定时健康检查完成：${okCount}/${results.length} 个 provider 可用`
      );
    } catch (err) {
      console.error("[llm-providers] 定时健康检查失败：", err);
    }
  };

  // 启动后延迟执行一次
  setTimeout(trigger, INITIAL_DELAY_MS);

  // 周期性执行
  setInterval(trigger, REFRESH_INTERVAL_MS);

  console.log(
    `[llm-providers] 已注册定时健康检查（每 ${REFRESH_INTERVAL_MS / 1000 / 60 / 60} 小时）`
  );
}
