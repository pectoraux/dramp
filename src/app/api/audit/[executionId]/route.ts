import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeAuditEvent } from "@/lib/engine/serialize";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ executionId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { executionId } = await params;
  const events = await db.auditEvent.findMany({
    where: { executionId },
    orderBy: { timestamp: "asc" },
  });
  return NextResponse.json({ events: events.map(serializeAuditEvent) });
}
