import { NextRequest, NextResponse } from "next/server";
import { cancelExecution } from "@/lib/engine/execution";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { requireUser, isAuthed, requireExecutionOwnership } from "@/lib/auth-guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;

  // Ownership check.
  const owned = await requireExecutionOwnership(id, auth);
  if (!owned.ok) return owned.error;

  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("cancel-execution", id);
  const result = await runIdempotent(key, "cancel-execution", { id }, async () => {
    const r = await cancelExecution(id, auth.id);
    return { status: 200, body: { cancelled: r.cancelled, reason: r.reason } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
