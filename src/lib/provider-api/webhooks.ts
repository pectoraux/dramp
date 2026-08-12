// Webhook service — outbound notifications to external providers.
// Deliveries are retryable and idempotent. Each delivery is signed with HMAC-SHA256.
// In the prototype, actual HTTP delivery is simulated (recorded as DELIVERED)
// but the delivery records are real and queryable.
//
// SECURITY: webhook signing secrets are encrypted at rest (AES-256-GCM).
// The plaintext is shown ONCE at creation and never stored. At signing time,
// the secret is decrypted in memory to compute the HMAC.

import { db } from "@/lib/db";
import { createHmac } from "node:crypto";
import { appendAuditEvent } from "@/lib/engine/audit";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

const MAX_ATTEMPTS = 5;

// Enqueue a webhook delivery for all of a provider's active endpoints that
// subscribe to the event type.
export async function emitProviderEvent(providerId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  const endpoints = await db.webhookEndpoint.findMany({
    where: { providerId, status: "ACTIVE" },
  });
  for (const ep of endpoints) {
    const events = JSON.parse(ep.events) as string[];
    if (events.length > 0 && !events.includes(eventType) && !events.includes("*")) continue;
    const payloadJson = JSON.stringify(payload);
    // Decrypt the signing secret in memory (never stored plaintext).
    const secret = decryptSecret(ep.encryptedSecret);
    const signature = createHmac("sha256", secret).update(payloadJson).digest("hex");
    await db.webhookDelivery.create({
      data: {
        endpointId: ep.id,
        eventType,
        payloadJson,
        signature,
        status: "PENDING",
        attempts: 0,
      },
    });
  }
}

// Process pending deliveries (called by the ticker / on-demand).
// In the prototype we simulate successful delivery; real HTTP is not attempted
// to avoid external network calls from the sandbox.
export async function processPendingWebhooks(limit = 20): Promise<number> {
  const now = new Date();
  const pending = await db.webhookDelivery.findMany({
    where: {
      status: { in: ["PENDING", "RETRYING"] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
  let processed = 0;
  for (const d of pending) {
    if (d.attempts >= MAX_ATTEMPTS) {
      await db.webhookDelivery.update({ where: { id: d.id }, data: { status: "FAILED" } });
      continue;
    }
    // Simulate delivery (prototype).
    await db.webhookDelivery.update({
      where: { id: d.id },
      data: {
        status: "DELIVERED",
        attempts: d.attempts + 1,
        responseStatus: 200,
        responseBody: "OK",
        deliveredAt: new Date(),
        nextRetryAt: null,
      },
    });
    processed++;
  }
  return processed;
}

// Register a webhook endpoint for a provider.
// Returns the plaintext secret ONCE — the caller must store it securely.
export async function registerWebhook(providerId: string, url: string, events: string[]): Promise<{ id: string; secret: string }> {
  const { randomBytes } = await import("node:crypto");
  const secret = `whsec_${randomBytes(16).toString("hex")}`;
  const { encryptedSecret, encryptionKeyVersion } = encryptSecret(secret);
  const ep = await db.webhookEndpoint.create({
    data: { providerId, url, encryptedSecret, encryptionKeyVersion, events: JSON.stringify(events), status: "ACTIVE" },
  });
  await appendAuditEvent({
    eventType: "webhook_registered",
    payload: { providerId, endpointId: ep.id, url, events },
    actorType: "PROVIDER",
    actorId: providerId,
  });
  return { id: ep.id, secret };
}
