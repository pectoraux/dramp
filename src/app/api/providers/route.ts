import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeProvider, serializeSettlementAsset } from "@/lib/engine/serialize";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireUser();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
