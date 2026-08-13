import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";
import { appendAuditEvent } from "@/lib/engine/audit";
import { emitProviderEvent } from "@/lib/provider-api/webhooks";

// Update an offer (rate, fee, capacity, channel, active status, expiry).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireProvider(req, "offers");
  if (!auth.ok) return auth.response;
  const body = await req.json();

  // Verify ownership.
  const offer = await db.liquidityOffer.findUnique({ where: { id } });
  if (!offer || offer.providerId !== auth.provider.providerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const updated = await db.liquidityOffer.update({
    where: { id },
    data: {
      ...(body.rate !== undefined && { rate: body.rate }),
      ...(body.feeBps !== undefined && { feeBps: body.feeBps }),
      ...(body.availableCapacity !== undefined && { availableCapacity: body.availableCapacity }),
      ...(body.maximumAmount !== undefined && { maximumAmount: body.maximumAmount }),
      ...(body.minimumAmount !== undefined && { minimumAmount: body.minimumAmount }),
      ...(body.channelType !== undefined && { channelType: body.channelType }),
      ...(body.expectedExecutionSeconds !== undefined && { expectedExecutionSeconds: body.expectedExecutionSeconds }),
      ...(body.incentiveBps !== undefined && { incentiveBps: body.incentiveBps }),
      ...(body.active !== undefined && { active: body.active }),
      ...(body.expiresAt !== undefined && { expiresAt: new Date(body.expiresAt) }),
      // Increment version on every economically-relevant mutation.
      version: { increment: 1 },
    },
  });

  const action = body.active === false ? "paused" : body.active === true ? "resumed" : "updated";
  await appendAuditEvent({
    eventType: "offer_updated",
    payload: { offerId: id, providerId: auth.provider.providerId, action, changes: body },
    actorType: "PROVIDER",
    actorId: auth.provider.providerId,
  });
  await emitProviderEvent(auth.provider.providerId, "offer.updated", { offerId: id, action });
  return NextResponse.json({ offer: { id: updated.id, active: updated.active } });
}

// Withdraw (deactivate) an offer.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireProvider(req, "offers");
  if (!auth.ok) return auth.response;

  const offer = await db.liquidityOffer.findUnique({ where: { id } });
  if (!offer || offer.providerId !== auth.provider.providerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await db.liquidityOffer.update({ where: { id }, data: { active: false, version: { increment: 1 } } });
  await appendAuditEvent({
    eventType: "offer_withdrawn",
    payload: { offerId: id, providerId: auth.provider.providerId },
    actorType: "PROVIDER",
    actorId: auth.provider.providerId,
  });
  await emitProviderEvent(auth.provider.providerId, "offer.updated", { offerId: id, action: "withdrawn" });
  return NextResponse.json({ withdrawn: true });
}
