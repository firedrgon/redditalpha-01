/**
 * 邮件通知投递（Resend）
 *
 * 使用 Resend REST API（fetch，无额外依赖）。仅在以下全部满足时真正发送：
 *   1. 配置了 RESEND_API_KEY
 *   2. 配置了 RESEND_FROM（已验证的发件域名，否则 Resend 会拒收）
 *   3. 调用方确认用户已开启 emailNotify（在 lib/notify.ts 中判断）
 *
 * 任何异常都被吃掉（仅打日志），绝不影响主流程（信号/通知写入）。
 */

const RESEND_API = "https://api.resend.com/emails";

export interface EmailSignalInput {
  ticker: string;
  tickerName?: string | null;
  signalType: "buy" | "sell";
  overall: string;
  oscillators: string;
  movingAverages: string;
  chipDesc?: string | null;
  phase: "enter" | "exit";
  state: "OUT" | "HOLD";
}

function signalLabelZh(v: string): string {
  const map: Record<string, string> = {
    strong_buy: "强烈买入",
    buy: "买入",
    neutral: "中性",
    sell: "卖出",
    strong_sell: "强烈卖出",
  };
  return map[v] ?? v;
}

export async function sendSignalEmail(to: string, input: EmailSignalInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    console.log(
      `[notify/email] 跳过：缺少 RESEND_API_KEY / RESEND_FROM（emailNotify 已开启但邮件服务未配置）`
    );
    return;
  }

  const actionLabel = input.phase === "enter" ? "建仓" : "平仓";
  const subject = `Reddit Alpha 信号提醒：${input.ticker} ${actionLabel}`;
  const tickerName = input.tickerName ? `（${input.tickerName}）` : "";
  const extra = input.chipDesc
    ? `<p>筹码状态：${escapeHtml(input.chipDesc.slice(0, 80))}</p>`
    : "";

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="color:#f97316;">${actionLabel}信号 · ${input.ticker}${tickerName}</h2>
    <p>状态变化：<b>${input.state}</b> → <b>${input.phase === "enter" ? "HOLD" : "OUT"}</b></p>
    <ul>
      <li>综合信号：<b>${signalLabelZh(input.overall)}</b></li>
      <li>振荡指标：${signalLabelZh(input.oscillators)}</li>
      <li>移动均线：${signalLabelZh(input.movingAverages)}</li>
    </ul>
    ${extra}
    <p style="color:#888;font-size:12px;margin-top:24px;">
      由 Reddit Alpha 自动推送。可在站内「通知」页关闭邮件提醒。
    </p>
  </div>`;

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[notify/email] Resend 返回 ${res.status}: ${txt.slice(0, 200)}`);
      return;
    }
    console.log(`[notify/email] 已发送邮件 -> ${to} (${input.ticker} ${actionLabel})`);
  } catch (err) {
    console.error(`[notify/email] 发送失败 -> ${to}:`, err instanceof Error ? err.message : err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
