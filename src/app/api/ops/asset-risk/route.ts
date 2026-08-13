import { NextResponse } from "next/server";
import { getSettlementAssetRiskMonitor } from "@/lib/provider-api/ops";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const assets = await getSettlementAssetRiskMonitor();
  return NextResponse.json({ assets });
}
