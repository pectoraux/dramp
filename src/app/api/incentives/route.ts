import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createCampaign, getCampaignStats } from "@/lib/provider-api/incentives";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const campaigns = await db.settlementIncentiveCampaign.findMany({
    include: { settlementAsset: true, sponsorProvider: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      settlementAsset: c.settlementAsset.symbol,
      sponsor: c.sponsorProvider?.name ?? null,
      incentiveBps: c.incentiveBps,
      fundingSource: c.fundingSource,
      startDate: c.startDate,
      endDate: c.endDate,
      totalBudget: c.totalBudget.toString(),
      accrued: c.accrued.toString(),
      paid: c.paid.toString(),
      status: c.status,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const body = await req.json();
  const { id } = await createCampaign({
    settlementAssetId: body.settlementAssetId,
    sponsorProviderId: body.sponsorProviderId,
    name: body.name,
    incentiveBps: body.incentiveBps,
    fundingSource: body.fundingSource ?? "dramp",
    startDate: new Date(body.startDate),
    endDate: new Date(body.endDate),
    totalBudget: body.totalBudget,
    perTxnCap: body.perTxnCap,
    volumeCap: body.volumeCap,
    eligibleCorridors: body.eligibleCorridors,
    eligibleRiskLevels: body.eligibleRiskLevels,
    eligibleProviderTypes: body.eligibleProviderTypes,
  });
  return NextResponse.json({ id });
}
