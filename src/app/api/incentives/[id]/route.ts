import { NextRequest, NextResponse } from "next/server";
import { getCampaignStats } from "@/lib/provider-api/incentives";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;
  const stats = await getCampaignStats(id);
  if (!stats) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(stats);
}
