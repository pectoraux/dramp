import { NextResponse } from "next/server";
import { getProviderRiskMonitor } from "@/lib/provider-api/ops";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const providers = await getProviderRiskMonitor();
  return NextResponse.json({ providers });
}
