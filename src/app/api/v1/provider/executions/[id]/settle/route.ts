import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { appendAuditEvent } from "@/lib/engine/audit";
import { emitProviderEvent } from "@/lib/provider-api/webhooks";

// Confirm settlement of a leg (provider reports the settlement is done).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: legId } = await params;
  const auth = await requireProvider(req, "executions");
  if (!auth.ok) return auth.response;

  const leg = await db.leg.findUnique({ where: { id: legId } });
  if (!leg || leg.providerId !== auth.provider.providerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("provider-settle", legId);
  const result = await runIdempotent(key, "provider-settle", { legId }, async () => {
    await db.leg.update({
      where: { id: legId },
      data: { status: "CONFIRMED", confirmedAt: new Date(), actorId: auth.provider.keyId, actorNote: body.reference ?? `settled via API` },
    });
    await appendAuditEvent({
      executionId: leg.executionId ?? undefined,
      eventType: "execution_settled",
      payload: { legId, providerId: auth.provider.providerId, reference: body.reference },
      actorType: "PROVIDER",
      actorId: auth.provider.providerId,
    });
    await emitProviderEvent(auth.provider.providerId, "execution.updated", { legId, executionId: leg.executionId, status: "settled" });
    return { status: 200, body: { settled: true, legId, reference: body.reference } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
