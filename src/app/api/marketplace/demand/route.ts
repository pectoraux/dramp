import { NextResponse } from "next/server";
import { getPendingDemand } from "@/lib/provider-api/marketplace";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const demand = await getPendingDemand();
  return NextResponse.json({ demand });
}
