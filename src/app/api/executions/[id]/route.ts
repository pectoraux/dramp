import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeExecution } from "@/lib/engine/serialize";
import { getAuditTrailForExecution } from "@/lib/engine/audit";
import { getLedgerForExecution } from "@/lib/engine/ledger";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const execution = await db.execution.findUnique({
    where: { id },
    include: {
      intent: true,
      routes: { include: { legs: { include: { provider: true, offer: true } } } },
      obligations: { include: { provider: true } },
      legs: { include: { provider: true, offer: true } },
      reservations: true,
      collateralLocks: true,
    },
  });
  if (!execution) return NextResponse.json({ error: "not found" }, { status: 404 });
  const audit = await getAuditTrailForExecution(id);
  const ledger = await getLedgerForExecution(id);
  return NextResponse.json({
    execution: serializeExecution(execution),
    audit,
    ledger,
  });
}
