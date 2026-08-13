import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeAuditEvent } from "@/lib/engine/serialize";
import { requireUser, isAuthed, requireExecutionOwnership } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ executionId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { executionId } = await params;

  // Ownership check.
  const owned = await requireExecutionOwnership(executionId, auth);
  if (!owned.ok) return owned.error;

  const events = await db.auditEvent.findMany({
    where: { executionId },
    orderBy: { timestamp: "asc" },
  });
  return NextResponse.json({ events: events.map(serializeAuditEvent) });
}
