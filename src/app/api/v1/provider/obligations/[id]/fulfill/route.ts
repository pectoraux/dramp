import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { appendAuditEvent } from "@/lib/engine/audit";

// Mark an obligation as fulfilled.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: obligationId } = await params;
  const auth = await requireProvider(req, "obligations");
  if (!auth.ok) return auth.response;

  const obligation = await db.obligation.findUnique({ where: { id: obligationId } });
  if (!obligation || obligation.providerId !== auth.provider.providerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("provider-fulfill", obligationId);
  const result = await runIdempotent(key, "provider-fulfill", { obligationId }, async () => {
    await db.obligation.update({ where: { id: obligationId }, data: { status: "FULFILLED", fulfilledAt: new Date() } });
    await appendAuditEvent({
      executionId: obligation.executionId,
      eventType: "obligation_fulfilled",
      payload: { obligationId, providerId: auth.provider.providerId, reference: body.reference },
      actorType: "PROVIDER",
      actorId: auth.provider.providerId,
    });
    return { status: 200, body: { fulfilled: true, obligationId } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
