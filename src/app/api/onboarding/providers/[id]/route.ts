import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";
import { updateProviderLifecycle } from "@/lib/provider-api/onboarding";

// Get a provider's onboarding detail (admin).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;
  const provider = await db.liquidityProvider.findUnique({
    where: { id },
    include: { vault: true, offers: true, operators: true, apiKeys: true, webhookEndpoints: true },
  });
  if (!provider) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ provider });
}

// Update lifecycle (admin): REVIEW → APPROVED → ACTIVE → SUSPENDED.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;
  const body = await req.json();
  await updateProviderLifecycle(id, body.status, auth.id, body.note);
  return NextResponse.json({ id, status: body.status });
}
