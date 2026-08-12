import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeAuditEvent } from "@/lib/engine/serialize";
import { verifyAuditChain } from "@/lib/engine/audit";

export async function GET() {
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
