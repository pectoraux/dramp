import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";
import { detectReconciliationItems, createReconciliationItem } from "@/lib/provider-api/disputes";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const url = new URL(req.url);
  const providerId = url.searchParams.get("providerId");
  const status = url.searchParams.get("status");

  // Auto-detect for all providers if no providerId specified.
  if (!providerId) {
    const providers = await db.liquidityProvider.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
    for (const p of providers) {
      const detected = await detectReconciliationItems(p.id);
      for (const d of detected) {
        const existing = await db.reconciliationItem.findFirst({ where: { providerId: p.id, obligationId: d.obligationId, status: "DETECTED" } });
        if (!existing) await createReconciliationItem(d);
      }
    }
  }

  const items = await db.reconciliationItem.findMany({
    where: { ...(providerId ? { providerId } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({
    items: items.map((i) => ({
      id: i.id,
      providerId: i.providerId,
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
      resolvedById: i.resolvedById,
      createdAt: i.createdAt,
      resolvedAt: i.resolvedAt,
    })),
  });
}
