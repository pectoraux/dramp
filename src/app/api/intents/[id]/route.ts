import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeIntent, serializeExecution, serializeRoute, serializeObligation, serializeLeg } from "@/lib/engine/serialize";
import { getAuditTrailForExecution } from "@/lib/engine/audit";
import { getLedgerForExecution } from "@/lib/engine/ledger";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const intent = await db.executionIntent.findUnique({
    where: { id },
    include: {
      executions: {
        include: {
          routes: { include: { legs: { include: { provider: true, offer: true } } } },
          obligations: { include: { provider: true } },
          legs: { include: { provider: true, offer: true } },
        },
        orderBy: { attemptNumber: "asc" },
      },
    },
  });
  if (!intent) return NextResponse.json({ error: "not found" }, { status: 404 });

  const execution = intent.executions[0];
  let audit: any[] = [];
  let ledger: any[] = [];
  if (execution) {
    audit = await getAuditTrailForExecution(execution.id);
    ledger = await getLedgerForExecution(execution.id);
  }

  return NextResponse.json({
    intent: serializeIntent(intent),
    execution: execution ? serializeExecution(execution) : null,
    routes: execution?.routes?.map(serializeRoute) ?? [],
    obligations: execution?.obligations?.map(serializeObligation) ?? [],
    legs: execution?.legs?.map(serializeLeg) ?? [],
    audit,
    ledger,
  });
}
