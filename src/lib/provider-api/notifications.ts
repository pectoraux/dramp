// Notification service — in-app notifications driven by domain events.
// ARCHITECTURE RULE: notifications are derived from actual execution/audit
// events, never fabricated.

import { db } from "@/lib/db";

export async function notify(userId: string, type: string, title: string, body?: string, payload?: Record<string, unknown>) {
  return db.notification.create({
    data: {
      userId,
      type,
      title,
      body: body ?? null,
      payloadJson: payload ? JSON.stringify(payload) : null,
    },
  });
}

export async function getNotifications(userId: string, unreadOnly = false) {
  return db.notification.findMany({
    where: unreadOnly ? { userId, read: false } : { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function markNotificationRead(id: string, userId: string) {
  await db.notification.updateMany({ where: { id, userId }, data: { read: true } });
}
