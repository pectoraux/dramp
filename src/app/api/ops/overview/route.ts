import { NextResponse } from "next/server";
import { getNetworkOverview } from "@/lib/provider-api/ops";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const overview = await getNetworkOverview();
  return NextResponse.json(overview);
}
