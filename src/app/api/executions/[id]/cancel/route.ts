import { NextRequest, NextResponse } from "next/server";
import { cancelExecution } from "@/lib/engine/execution";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const key = body.idempotencyKey ?? makeKey("cancel-execution", id);
  const result = await runIdempotent(key, "cancel-execution", { id }, async () => {
    const r = await cancelExecution(id, body.actorId);
    return { status: 200, body: r };
  });
  return NextResponse.json(result.body, { status: result.status });
}
