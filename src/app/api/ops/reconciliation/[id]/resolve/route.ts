import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";
import { resolveReconciliationItem } from "@/lib/provider-api/disputes";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const body = await req.json();
  await resolveReconciliationItem({
    itemId: id,
    status: body.status,
    resolution: body.resolution,
    resolvedById: auth.id,
  });
  return NextResponse.json({ resolved: true });
}
