import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cancelExecution } from "@/lib/engine/execution";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("cancel-intent", id);

  const result = await runIdempotent<{ error?: string; cancelled?: boolean; reason?: string }>(key, "cancel-intent", { id }, async () => {
    const intent = await db.executionIntent.findUnique({
      where: { id },
      include: { executions: true },
    });
    if (!intent) return { status: 404, body: { error: "intent not found" } };
    const execution = intent.executions[0];
    if (!execution) return { status: 404, body: { error: "no execution" } };
    const r = await cancelExecution(execution.id, auth.id);
    return { status: 200, body: { cancelled: r.cancelled, reason: r.reason } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
