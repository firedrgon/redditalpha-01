/**
 * 信号通知编排层
 *
 * 在 signals-runner 产生 buy/sell alert 时调用：
 *   1. 写入 Notification 行（站内通知中心数据源）
 *   2. 若用户开启 emailNotify 且有邮箱 → 发邮件（Resend）
 *   3. 若用户开启 webpushNotify 且有订阅 → 发 Web Push（VAPID）
 *
 * 全部异常内部消化，绝不抛回主流程（信号/alert 写入不受影响）。
 */

import { getPrisma } from "@/lib/db/prisma";
import { SIGNAL_LABELS } from "@/lib/technical";
import { sendSignalEmail } from "./notify/email";
import { sendWebPushToUser, type StoredSubscription } from "./notify/webpush";

type PrismaClient = NonNullable<Awaited<ReturnType<typeof getPrisma>>>;

export interface SignalNotificationInput {
  userId: string;
  ticker: string;
  tickerName?: string | null;
  signalType: "buy" | "sell";
  overall: string;
  oscillators: string;
  movingAverages: string;
  chipDesc?: string | null;
  state: "OUT" | "HOLD";
  phase: "enter" | "exit";
}

/**
 * 创建一条信号通知并投递到用户开启的渠道。
 * 返回新创建的 Notification 行（供测试/审计）。
 */
export async function createSignalNotification(
  prisma: PrismaClient,
  input: SignalNotificationInput
): Promise<{ id: string } | null> {
  const actionLabel = input.phase === "enter" ? "建仓" : "平仓";
  const title = `${input.ticker} ${actionLabel}信号`;
  const tickerName = input.tickerName ? `（${input.tickerName}）` : "";
  const body =
    `综合: ${SIGNAL_LABELS[input.overall as keyof typeof SIGNAL_LABELS] ?? input.overall}; ` +
    `振荡: ${SIGNAL_LABELS[input.oscillators as keyof typeof SIGNAL_LABELS] ?? input.oscillators}; ` +
    `均线: ${SIGNAL_LABELS[input.movingAverages as keyof typeof SIGNAL_LABELS] ?? input.movingAverages}` +
    (input.chipDesc ? `; 筹码: ${input.chipDesc.slice(0, 40)}` : "");

  // 1) 写站内通知
  let notifId: string;
  try {
    const created = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: `signal_${input.signalType}`,
        ticker: input.ticker,
        tickerName: input.tickerName ?? null,
        title,
        body,
        link: "/notifications",
        read: false,
      },
    });
    notifId = created.id;
    console.log(`[notify] 站内通知已写入: ${title} (${notifId})`);
  } catch (err) {
    console.error(`[notify] 写站内通知失败: ${title}`, err);
    return null;
  }

  // 2) 取用户偏好与订阅，投递外部渠道
  try {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        email: true,
        emailNotify: true,
        webpushNotify: true,
        pushSubscriptions: { select: { endpoint: true, keys: true } },
      },
    });
    if (!user) return { id: notifId };

    const payload = {
      title: `${actionLabel}信号 · ${input.ticker}${tickerName}`,
      body: `综合 ${SIGNAL_LABELS[input.overall as keyof typeof SIGNAL_LABELS] ?? input.overall}｜状态 ${input.state} → ${
        input.phase === "enter" ? "HOLD" : "OUT"
      }`,
      ticker: input.ticker,
      link: "/notifications",
    };

    if (user.emailNotify && user.email) {
      void sendSignalEmail(user.email, {
        ticker: input.ticker,
        tickerName: input.tickerName,
        signalType: input.signalType,
        overall: input.overall,
        oscillators: input.oscillators,
        movingAverages: input.movingAverages,
        chipDesc: input.chipDesc,
        phase: input.phase,
        state: input.state,
      });
    }

    if (user.webpushNotify && user.pushSubscriptions.length > 0) {
      const subs: StoredSubscription[] = user.pushSubscriptions.map((s) => ({
        endpoint: s.endpoint,
        keys: s.keys,
      }));
      void sendWebPushToUser(subs, payload).then((r) => {
        if (r.failed.length > 0) {
          // 清理失效订阅（410 Gone / 404 Not Found）
          void pruneSubscriptions(prisma, r.failed);
        }
      });
    }
  } catch (err) {
    console.error(`[notify] 投递外部渠道失败（不影响站内通知）:`, err);
  }

  return { id: notifId };
}

/** 删除已失效的 push 订阅（VAPID 返回 410/404） */
async function pruneSubscriptions(
  prisma: PrismaClient,
  endpoints: string[]
): Promise<void> {
  if (endpoints.length === 0) return;
  try {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: { in: endpoints } },
    });
    console.log(`[notify] 已清理 ${endpoints.length} 条失效 push 订阅`);
  } catch (err) {
    console.error(`[notify] 清理失效订阅失败:`, err);
  }
}
