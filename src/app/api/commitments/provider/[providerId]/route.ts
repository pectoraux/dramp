import { NextRequest, NextResponse } from "next/server";
import { getProviderCommitments } from "@/lib/economics/commitments";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { providerId } = await params;
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId && !isAdmin(auth)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const commitments = await getProviderCommitments(providerId);
  return NextResponse.json({ commitments });
}
