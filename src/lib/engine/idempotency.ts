// Idempotency — every financial mutation requires an idempotency key.
// Repeated requests with the same key return the cached response and must NOT
// create duplicate economic effects.

import { db } from "@/lib/db";

export interface IdempotentResult<T> {
  status: number;
  body: T;
  cached: boolean;
}

export async function runIdempotent<T>(
  key: string,
  operation: string,
  requestPayload: Record<string, unknown>,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!key) throw new Error("idempotency key required");

  const existing = await db.idempotencyRecord.findUnique({ where: { key } });
  if (existing) {
    return {
      status: existing.responseStatus,
      body: existing.responseBody ? (JSON.parse(existing.responseBody) as T) : (null as T),
      cached: true,
    };
  }

  const result = await fn();

  await db.idempotencyRecord.create({
    data: {
      key,
      operation,
      requestPayload: JSON.stringify(requestPayload),
      responseStatus: result.status,
      responseBody: JSON.stringify(result.body),
    },
  });

  return { status: result.status, body: result.body, cached: false };
}

// Generate a stable idempotency key from operation + deterministic inputs.
export function makeKey(operation: string, ...parts: (string | number)[]): string {
  return `${operation}:${parts.join(":")}`;
}
