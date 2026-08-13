import { NextRequest, NextResponse } from "next/server";
import { submitProviderApplication } from "@/lib/provider-api/onboarding";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const body = await req.json();
  const { id } = await submitProviderApplication({
    name: body.name,
    providerType: body.providerType,
    trustModel: body.trustModel,
    capabilities: body.capabilities ?? [],
    countries: body.countries ?? [],
    jurisdiction: body.jurisdiction,
    contactEmail: body.contactEmail,
    supportedAssets: body.supportedAssets ?? [],
    settlementMethods: body.settlementMethods ?? [],
    reputationScore: body.reputationScore,
    note: body.note,
  });
  return NextResponse.json({ id, status: "APPLIED" });
}
