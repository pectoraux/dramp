import { NextRequest, NextResponse } from "next/server";
import { manualConfirmLeg } from "@/lib/engine/providers/adapter";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { requireOperatorOrAdmin, isAuthed } from "@/lib/auth-guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperatorOrAdmin();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("manual-confirm-leg", id);
  const result = await runIdempotent(key, "manual-confirm-leg", { id, body }, async () => {
    await manualConfirmLeg(id, auth.id, body.note ?? "manual confirmation");
    return { status: 200, body: { confirmed: true } };
  });
  return NextResponse.json(result.body, { status: result.status });
}
