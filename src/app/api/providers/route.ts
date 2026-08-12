import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeProvider, serializeProviderPublic, serializeSettlementAsset } from "@/lib/engine/serialize";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;

  const providers = await db.liquidityProvider.findMany({
    include: {
      vault: true,
      offers: { where: { active: true } },
      obligations: { where: { status: { in: ["CREATED", "ACTIVE"] } } },
    },
    orderBy: { name: "asc" },
  });
  const settlementAssets = await db.settlementAsset.findMany();

  // Ordinary USERs get the public (redacted) view: no vault internals,
  // reserved capacity, or obligations. Admins and operators get the full view.
  const useFull = isAdmin(auth) || auth.role === "PROVIDER_OPERATOR";
  return NextResponse.json({
    providers: providers.map(useFull ? serializeProvider : serializeProviderPublic),
    settlementAssets: settlementAssets.map(serializeSettlementAsset),
  });
}
