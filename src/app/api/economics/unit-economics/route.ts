import { NextResponse } from "next/server";
import { getNetworkUnitEconomics } from "@/lib/economics/network-health";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const econ = await getNetworkUnitEconomics();
  return NextResponse.json(econ);
}
