import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeProvider, serializeSettlementAsset, serializeOffer } from "@/lib/engine/serialize";

export async function GET() {
  const providers = await db.liquidityProvider.findMany({
    include: {
      vault: true,
      offers: { where: { active: true } },
      obligations: { where: { status: { in: ["CREATED", "ACTIVE"] } } },
    },
    orderBy: { name: "asc" },
  });
  const settlementAssets = await db.settlementAsset.findMany();
  return NextResponse.json({
    providers: providers.map(serializeProvider),
    settlementAssets: settlementAssets.map(serializeSettlementAsset),
  });
}
