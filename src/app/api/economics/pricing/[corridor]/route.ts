import { NextRequest, NextResponse } from "next/server";
import { getPricingIntelligence } from "@/lib/economics/market-intelligence";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ corridor: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { corridor } = await params;
  const [src, dst] = corridor.split("->");
  if (!src || !dst) return NextResponse.json({ error: "Use SRC->DST format" }, { status: 400 });
  const intel = await getPricingIntelligence(src, dst);
  return NextResponse.json(intel);
}
