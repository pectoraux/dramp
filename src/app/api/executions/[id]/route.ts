import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeExecution } from "@/lib/engine/serialize";
import { getAuditTrailForExecution } from "@/lib/engine/audit";
import { getLedgerForExecution } from "@/lib/engine/ledger";
import { requireUser, isAuthed, requireExecutionOwnership } from "@/lib/auth-guard";
import { advanceOneOnDemand } from "@/lib/engine/ticker";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;

  // Ownership check.
  const owned = await requireExecutionOwnership(id, auth);
  if (!owned.ok) return owned.error;

  await advanceOneOnDemand(id);

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
