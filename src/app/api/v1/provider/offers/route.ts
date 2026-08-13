import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { appendAuditEvent } from "@/lib/engine/audit";
import { emitProviderEvent } from "@/lib/provider-api/webhooks";

// List the provider's offers.
export async function GET(req: NextRequest) {
  const auth = await requireProvider(req, "offers");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const activeOnly = url.searchParams.get("active") === "true";
  const offers = await db.liquidityOffer.findMany({
    where: { providerId: auth.provider.providerId, ...(activeOnly ? { active: true } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ offers: offers.map(serializeOfferForProvider) });
}

// Create a new offer.
export async function POST(req: NextRequest) {
  const auth = await requireProvider(req, "offers");
  if (!auth.ok) return auth.response;
  const body = await req.json();
  const idempotencyKey = body.idempotencyKey ?? makeKey("provider-create-offer", auth.provider.providerId, JSON.stringify(body));

  const result = await runIdempotent(idempotencyKey, "provider-create-offer", body, async () => {
    const offer = await db.liquidityOffer.create({
      data: {
        providerId: auth.provider.providerId,
        capability: body.capability,
        sourceAsset: body.sourceAsset,
        destinationAsset: body.destinationAsset,
        sourceCountry: body.sourceCountry ?? "GLOBAL",
        destinationCountry: body.destinationCountry ?? "GLOBAL",
        rate: body.rate,
        feeBps: body.feeBps ?? 20,
        minimumAmount: body.minimumAmount ?? 10,
        maximumAmount: body.maximumAmount ?? 100000,
        availableCapacity: body.availableCapacity ?? 10000,
        settlementAssetId: body.settlementAssetId ?? null,
        channelType: body.channelType ?? "AUTOMATIC",
        expectedExecutionSeconds: body.expectedExecutionSeconds ?? 60,
        incentiveBps: body.incentiveBps ?? 0,
        active: body.active !== false,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : new Date(Date.now() + 3600_000),
      },
    });
    await appendAuditEvent({
      eventType: "offer_created",
      payload: { offerId: offer.id, providerId: auth.provider.providerId, corridor: `${offer.sourceAsset}→${offer.destinationAsset}` },
      actorType: "PROVIDER",
      actorId: auth.provider.providerId,
    });
    await emitProviderEvent(auth.provider.providerId, "offer.updated", { offerId: offer.id, action: "created" });
    return { status: 200, body: { offer: serializeOfferForProvider(offer) } };
  });
  return NextResponse.json(result.body, { status: result.status });
}

function serializeOfferForProvider(o: any) {
  return {
    id: o.id,
    capability: o.capability,
    sourceAsset: o.sourceAsset,
    destinationAsset: o.destinationAsset,
    sourceCountry: o.sourceCountry,
    destinationCountry: o.destinationCountry,
    rate: o.rate.toString(),
    feeBps: o.feeBps,
    minimumAmount: o.minimumAmount.toString(),
    maximumAmount: o.maximumAmount.toString(),
    availableCapacity: o.availableCapacity.toString(),
    reservedCapacity: o.reservedCapacity.toString(),
    settlementAssetId: o.settlementAssetId,
    channelType: o.channelType,
    expectedExecutionSeconds: o.expectedExecutionSeconds,
    incentiveBps: o.incentiveBps,
    active: o.active,
    expiresAt: o.expiresAt,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
