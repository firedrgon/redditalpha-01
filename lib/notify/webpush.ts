/**
 * Web Push 投递（VAPID，使用 web-push 包）
 *
 * 前置条件（环境变量）：
 *   VAPID_PUBLIC_KEY  —— 下发给浏览器订阅用（也可通过 /api/notifications/push GET 暴露）
 *   VAPID_PRIVATE_KEY —— 服务端签名用
 *   VAPID_SUBJECT     —— 联系方式，如 mailto:admin@example.com（可选，有默认值）
 *
 * 没有配置 VAPID 密钥时，所有函数静默跳过（不影响主流程）。
 */

import webpush from "web-push";

export function vapidConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY || "";
}

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!vapidConfigured()) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@redditalpha.app",
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string
  );
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  ticker: string;
  link?: string;
}

export interface StoredSubscription {
  endpoint: string;
  /** JSON 字符串: { p256dh, auth } */
  keys: string;
}

/**
 * 向一组订阅推送同一条消息。
 * 已失效的订阅（410/404）在调用方负责清理（见 API 层）。
 */
export async function sendWebPushToUser(
  subs: StoredSubscription[],
  payload: PushPayload
): Promise<{ success: number; failed: string[] }> {
  if (!ensureConfigured()) {
    console.log("[notify/webpush] 跳过：未配置 VAPID 密钥");
    return { success: 0, failed: [] };
  }
  if (subs.length === 0) return { success: 0, failed: [] };

  const data = JSON.stringify(payload);
  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: JSON.parse(sub.keys) },
          data
        );
        return { endpoint: sub.endpoint, ok: true as const };
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        return { endpoint: sub.endpoint, ok: false as const, status };
      }
    })
  );

  const success = results.filter((r) => r.ok).length;
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => (r as { endpoint: string; status?: number }).endpoint);

  if (failed.length) {
    console.log(`[notify/webpush] 推送完成 ${success}/${subs.length}，失效订阅 ${failed.length} 条`);
  } else {
    console.log(`[notify/webpush] 推送完成 ${success}/${subs.length}`);
  }
  return { success, failed };
}
