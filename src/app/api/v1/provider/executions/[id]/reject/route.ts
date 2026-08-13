import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { appendAuditEvent } from "@/lib/engine/audit";
import { emitProviderEvent } from "@/lib/provider-api/webhooks";

// Reject an execution leg.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: legId } = await params;
  const auth = await requireProvider(req, "executions");
  if (!auth.ok) return auth.response;

  const leg = await db.leg.findUnique({ where: { id: legId } });
  if (!leg || leg.providerId !== auth.provider.providerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("provider-reject", legId);
  const result = await runIdempotent(key, "provider-reject", { legId }, async () => {
    await db.leg.update({ where: { id: legId }, data: { status: "FAILED", actorId: auth.provider.keyId, actorNote: body.reason ?? "rejected via API" } });
    await appendAuditEvent({
      executionId: leg.executionId ?? undefined,
      eventType: "execution_rejected",
      payload: { legId, providerId: auth.provider.providerId, reason: body.reason ?? "rejected" },
      actorType: "PROVIDER",
      actorId: auth.provider.providerId,
    });
    await emitProviderEvent(auth.provider.providerId, "execution.rejected", { legId, executionId: leg.executionId, reason: body.reason });
    return { status: 200, body: { rejected: true, legId } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
