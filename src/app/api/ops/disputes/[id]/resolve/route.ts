import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";
import { resolveDispute } from "@/lib/provider-api/disputes";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const body = await req.json();
  const result = await resolveDispute({
    disputeId: id,
    resolution: body.resolution,
    resolvedById: auth.id,
    compensationAmount: body.compensationAmount,
    slashedAmount: body.slashedAmount,
    note: body.note,
  });
  if (result.error) {
    return NextResponse.json({ resolved: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ resolved: true, slashed: result.slashed, slashedAmount: result.slashedAmount });
}
