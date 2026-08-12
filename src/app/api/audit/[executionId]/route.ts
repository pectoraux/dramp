import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeAuditEvent } from "@/lib/engine/serialize";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ executionId: string }> }) {
  const { executionId } = await params;
  const events = await db.auditEvent.findMany({
    where: { executionId },
    orderBy: { timestamp: "asc" },
  });
  return NextResponse.json({ events: events.map(serializeAuditEvent) });
}
