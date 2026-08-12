import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";
import { resolveDispute } from "@/lib/provider-api/disputes";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const body = await req.json();
  await resolveDispute({
    disputeId: id,
    resolution: body.resolution,
    resolvedById: auth.id,
    compensationAmount: body.compensationAmount,
    slashedAmount: body.slashedAmount,
    note: body.note,
  });
  return NextResponse.json({ resolved: true });
}
