import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeProvider } from "@/lib/engine/serialize";
import { requireOperatorOrAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperatorOrAdmin();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const provider = await db.liquidityProvider.findUnique({
    where: { id },
    include: {
      vault: true,
      offers: true,
      obligations: { include: { execution: true }, orderBy: { createdAt: "desc" }, take: 50 },
      legs: { include: { execution: true }, orderBy: { sequence: "asc" }, take: 50 },
    },
  });
  if (!provider) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ provider: serializeProvider(provider) });
}
