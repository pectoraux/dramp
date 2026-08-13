import { NextRequest, NextResponse } from "next/server";
import { sampleCommitment } from "@/lib/economics/commitments";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

// Sample a commitment (admin-only, triggers monitoring check).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;
  const result = await sampleCommitment(id);
  return NextResponse.json(result);
}
