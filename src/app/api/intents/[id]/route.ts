import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeIntent, serializeExecution, serializeRoute, serializeObligation, serializeLeg } from "@/lib/engine/serialize";
import { getAuditTrailForExecution } from "@/lib/engine/audit";
import { getLedgerForExecution } from "@/lib/engine/ledger";
import { requireUser, isAuthed, requireIntentOwnership } from "@/lib/auth-guard";
import { advanceOneOnDemand } from "@/lib/engine/ticker";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;

  // Ownership check: only the intent owner (or an admin) may read this.
  const owned = await requireIntentOwnership(id, auth);
  if (!owned.ok) return owned.error;

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

  // On-demand advancement: progress the state machine on each poll so the demo
  // works on serverless (Vercel) without a persistent background ticker.
  if (execution) {
    await advanceOneOnDemand(execution.id);
  }

  let audit: any[] = [];
  let ledger: any[] = [];
  if (execution) {
    audit = await getAuditTrailForExecution(execution.id);
    ledger = await getLedgerForExecution(execution.id);
  }

  // Re-fetch execution after advancement to return fresh state.
  const freshExecution = execution
    ? await db.execution.findUnique({
        where: { id: execution.id },
        include: {
          routes: { include: { legs: { include: { provider: true, offer: true } } } },
          obligations: { include: { provider: true } },
          legs: { include: { provider: true, offer: true } },
        },
      })
    : null;

  return NextResponse.json({
    intent: serializeIntent(intent),
    execution: freshExecution ? serializeExecution(freshExecution) : null,
    routes: freshExecution?.routes?.map(serializeRoute) ?? [],
    obligations: freshExecution?.obligations?.map(serializeObligation) ?? [],
    legs: freshExecution?.legs?.map(serializeLeg) ?? [],
    audit,
    ledger,
  });
}
