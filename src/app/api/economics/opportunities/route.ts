import { NextResponse } from "next/server";
import { getProviderOpportunities } from "@/lib/economics/market-intelligence";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const ops = await getProviderOpportunities();
  return NextResponse.json({ opportunities: ops });
}
