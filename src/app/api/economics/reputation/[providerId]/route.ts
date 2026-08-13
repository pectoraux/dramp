import { NextRequest, NextResponse } from "next/server";
import { getProviderReputation } from "@/lib/economics/reputation";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { providerId } = await params;
  const rep = await getProviderReputation(providerId);
  return NextResponse.json(rep);
}
