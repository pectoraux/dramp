import { NextResponse } from "next/server";
import { getNetworkHealth } from "@/lib/economics/network-health";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const health = await getNetworkHealth();
  return NextResponse.json(health);
}
