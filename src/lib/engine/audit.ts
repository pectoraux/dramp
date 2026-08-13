// Audit log service — every meaningful action produces an immutable, hash-chained event.
// hash = sha256(prevHash || timestamp || eventType || payloadJson)

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { AUDIT_ACTOR } from "./types";

export interface AuditEventInput {
  executionId?: string;
  intentId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorType?: string;
  actorId?: string;
}

function computeHash(
  prevHash: string,
  timestamp: Date,
  eventType: string,
  payloadJson: string,
): string {
  const data = `${prevHash}|${timestamp.toISOString()}|${eventType}|${payloadJson}`;
  return createHash("sha256").update(data).digest("hex");
}

// Simple in-process mutex to serialize audit appends and keep the hash chain
// linear (concurrent appends would otherwise both read the same `last` hash
// and fork the chain).
let auditChainLock: Promise<void> = Promise.resolve();

export async function appendAuditEvent(input: AuditEventInput) {
  const run = auditChainLock.then(async () => {
    // Fetch the latest event to chain from. We use a single global chain.
    const last = await db.auditEvent.findFirst({
      orderBy: { timestamp: "desc" },
      select: { hash: true, timestamp: true },
    });
    const prevHash = last?.hash ?? "0".repeat(64);
    const timestamp = new Date();
    const payloadJson = JSON.stringify(input.payload);
    const hash = computeHash(prevHash, timestamp, input.eventType, payloadJson);

    const evt = await db.auditEvent.create({
      data: {
        executionId: input.executionId ?? null,
        intentId: input.intentId ?? null,
        eventType: input.eventType,
        payloadJson,
        actorType: input.actorType ?? AUDIT_ACTOR.SYSTEM,
        actorId: input.actorId ?? null,
        prevHash,
        hash,
        timestamp, // store the exact timestamp used to compute the hash
      },
    });
    return evt;
  });
  // Chain the lock so the next append waits for this one.
  auditChainLock = run.then(() => undefined, () => undefined);
  return run;
}

// Verify the hash chain integrity for a set of events (used by failure tests / monitor).
export async function verifyAuditChain(events: { prevHash: string; hash: string; timestamp: Date; eventType: string; payloadJson: string }[]): Promise<{ valid: boolean; brokenAt?: number }> {
  let prev = "0".repeat(64);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.prevHash !== prev) return { valid: false, brokenAt: i };
    const expected = computeHash(prev, e.timestamp, e.eventType, e.payloadJson);
    if (expected !== e.hash) return { valid: false, brokenAt: i };
    prev = e.hash;
  }
  return { valid: true };
}

export async function getAuditTrailForExecution(executionId: string) {
  const events = await db.auditEvent.findMany({
    where: { OR: [{ executionId }, { intentId: { not: undefined } }] },
    orderBy: { timestamp: "asc" },
  });
  // Filter to those belonging to this execution's intent chain via executionId match.
  return events.filter((e) => e.executionId === executionId);
}

export async function getFullAuditTrail(limit = 200) {
  return db.auditEvent.findMany({
    orderBy: { timestamp: "asc" },
    take: limit,
  });
}
