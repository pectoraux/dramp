import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeAuditEvent } from "@/lib/engine/serialize";
import { verifyAuditChain } from "@/lib/engine/audit";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireUser();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const events = await db.auditEvent.findMany({
    orderBy: { timestamp: "asc" },
    take: 300,
  });
  const chainValid = await verifyAuditChain(events);
  return NextResponse.json({
    events: events.map(serializeAuditEvent),
    chainValid,
  });
}
