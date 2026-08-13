import { NextRequest, NextResponse } from "next/server";
import { reportLegFailure } from "@/lib/engine/providers/adapter";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { requireUser, isAuthed, requireLegOwnership } from "@/lib/auth-guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;

  // Ownership check: operator must own the provider for this leg (admins bypass).
  const owned = await requireLegOwnership(id, auth);
  if (!owned.ok) return owned.error;

  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("fail-leg", id);
  const result = await runIdempotent(key, "fail-leg", { id, body }, async () => {
    await reportLegFailure(id, body.reason ?? "manual failure report");
    return { status: 200, body: { failed: true } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
