import { NextRequest, NextResponse } from "next/server";
import { getMarketplaceOffers } from "@/lib/provider-api/marketplace";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const url = new URL(req.url);
  const offers = await getMarketplaceOffers({
    sourceAsset: url.searchParams.get("sourceAsset") ?? undefined,
    destinationAsset: url.searchParams.get("destinationAsset") ?? undefined,
    sourceCountry: url.searchParams.get("sourceCountry") ?? undefined,
    destinationCountry: url.searchParams.get("destinationCountry") ?? undefined,
  });
  return NextResponse.json({ offers });
}
