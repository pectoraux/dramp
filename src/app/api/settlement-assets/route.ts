import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeSettlementAsset } from "@/lib/engine/serialize";
import { requireUser, isAuthed } from "@/lib/auth-guard";

// Settlement asset registry — public to authenticated users.
export async function GET() {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const assets = await db.settlementAsset.findMany({
    include: { incentiveCampaigns: { where: { status: "ACTIVE" } } },
  });
  // Count active offers using each asset.
  const offerCounts = await db.liquidityOffer.groupBy({
    by: ["settlementAssetId"],
    where: { active: true, settlementAssetId: { not: null } },
    _count: true,
  });
  const ocMap = new Map(offerCounts.map((o) => [o.settlementAssetId, o._count] as const));
  return NextResponse.json({
    assets: assets.map((a) => ({
      ...serializeSettlementAsset(a),
      activeOfferCount: ocMap.get(a.id) ?? 0,
      activeCampaignCount: a.incentiveCampaigns.length,
    })),
  });
}
