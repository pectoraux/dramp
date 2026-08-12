import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeAuditEvent } from "@/lib/engine/serialize";
import { verifyAuditChain } from "@/lib/engine/audit";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

// The full audit trail is admin-only: it contains cross-user events with
// actorId, executionId, and payload for every user in the system.
export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
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
