import { NextRequest, NextResponse } from "next/server";
import { getProviderStatement } from "@/lib/economics/provider-economics";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

export async function GET(req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { providerId } = await params;
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId && !isAdmin(auth)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? 30);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 86400000);
  const statement = await getProviderStatement(providerId, startDate, endDate);
  return NextResponse.json(statement);
}
