import { NextRequest, NextResponse } from "next/server";
import { getProviderEconomics } from "@/lib/economics/provider-economics";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { providerId } = await params;
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId && !isAdmin(auth)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const econ = await getProviderEconomics(providerId);
  return NextResponse.json(econ);
}
