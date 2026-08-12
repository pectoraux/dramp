import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeProvider, serializeProviderPublic } from "@/lib/engine/serialize";
import { requireUser, isAuthed, requireProviderOwnership } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
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

  // Operators see the full view ONLY for their own provider; admins see all.
  // Everyone else (ordinary USERs) gets the public redacted view.
  const owned = await requireProviderOwnership(id, auth);
  const fullAccess = owned.ok; // admin or the operator bound to this provider

  return NextResponse.json({
    provider: fullAccess ? serializeProvider(provider) : serializeProviderPublic(provider),
  });
}
