import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { appendAuditEvent } from "@/lib/engine/audit";
import { emitProviderEvent } from "@/lib/provider-api/webhooks";

// Accept an execution leg assigned to this provider.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: legId } = await params;
  const auth = await requireProvider(req, "executions");
  if (!auth.ok) return auth.response;

  // Verify the leg belongs to this provider.
  const leg = await db.leg.findUnique({ where: { id: legId } });
  if (!leg || leg.providerId !== auth.provider.providerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("provider-accept", legId);
  const result = await runIdempotent(key, "provider-accept", { legId }, async () => {
    await db.leg.update({ where: { id: legId }, data: { status: "CONFIRMED", confirmedAt: new Date(), actorId: auth.provider.keyId, actorNote: "accepted via API" } });
    await appendAuditEvent({
      executionId: leg.executionId ?? undefined,
      eventType: "execution_accepted",
      payload: { legId, providerId: auth.provider.providerId },
      actorType: "PROVIDER",
      actorId: auth.provider.providerId,
    });
    await emitProviderEvent(auth.provider.providerId, "execution.accepted", { legId, executionId: leg.executionId });
    return { status: 200, body: { accepted: true, legId } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
