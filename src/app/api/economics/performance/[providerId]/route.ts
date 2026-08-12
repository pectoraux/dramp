import { NextRequest, NextResponse } from "next/server";
import { getProviderPerformance } from "@/lib/economics/performance";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { providerId } = await params;
  // Operators can see their own provider's performance; admins see all.
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId && !isAdmin(auth)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const perf = await getProviderPerformance(providerId);
  return NextResponse.json(perf);
}
