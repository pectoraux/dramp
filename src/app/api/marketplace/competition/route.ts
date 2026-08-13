import { NextRequest, NextResponse } from "next/server";
import { getProviderCompetition } from "@/lib/provider-api/marketplace";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const body = await req.json();
  const competition = await getProviderCompetition({
    sourceAsset: body.sourceAsset,
    sourceCountry: body.sourceCountry,
    destinationAsset: body.destinationAsset,
    destinationCountry: body.destinationCountry,
    sourceAmount: body.sourceAmount,
    riskTolerance: body.riskTolerance,
  });
  return NextResponse.json({ routes: competition });
}
