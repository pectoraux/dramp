import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";
import { detectReconciliationItems, createReconciliationItem } from "@/lib/provider-api/disputes";

// Provider-scoped reconciliation: detect + report discrepancies.
export async function GET(req: NextRequest) {
  const auth = await requireProvider(req, "reconcile");
  if (!auth.ok) return auth.response;

  // Auto-detect stale obligations.
  const detected = await detectReconciliationItems(auth.provider.providerId);
  for (const d of detected) {
    const existing = await db.reconciliationItem.findFirst({
      where: { providerId: auth.provider.providerId, obligationId: d.obligationId, status: "DETECTED" },
    });
    if (!existing) await createReconciliationItem(d);
  }

  const items = await db.reconciliationItem.findMany({
    where: { providerId: auth.provider.providerId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json({
    items: items.map((i) => ({
      id: i.id,
      type: i.type,
      severity: i.severity,
      status: i.status,
      executionId: i.executionId,
      obligationId: i.obligationId,
      expectedAmount: i.expectedAmount?.toString(),
      reportedAmount: i.reportedAmount?.toString(),
      asset: i.asset,
      description: i.description,
      resolution: i.resolution,
      createdAt: i.createdAt,
    })),
  });
}

// Submit a reconciliation report (provider reports a balance/amount).
export async function POST(req: NextRequest) {
  const auth = await requireProvider(req, "reconcile");
  if (!auth.ok) return auth.response;
  const body = await req.json();
  const { id } = await createReconciliationItem({
    providerId: auth.provider.providerId,
    type: body.type ?? "BALANCE_DIFFERENCE",
    severity: body.severity,
    executionId: body.executionId,
    obligationId: body.obligationId,
    expectedAmount: body.expectedAmount,
    reportedAmount: body.reportedAmount,
    asset: body.asset,
    description: body.description,
  });
  return NextResponse.json({ id });
}
