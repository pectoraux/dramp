import { NextResponse } from "next/server";
import { getProviderFunnel } from "@/lib/economics/network-health";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const funnel = await getProviderFunnel();
  return NextResponse.json(funnel);
}
