import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";
import { openDispute } from "@/lib/provider-api/disputes";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const disputes = await db.dispute.findMany({
    where: status ? { status } : {},
    include: { provider: true, execution: { include: { intent: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json({
    disputes: disputes.map((d) => ({
      id: d.id,
      executionId: d.executionId,
      providerId: d.providerId,
      providerName: d.provider.name,
      reason: d.reason,
      description: d.description,
      status: d.status,
      resolution: d.resolution,
      compensationAmount: d.compensationAmount?.toString(),
      slashedAmount: d.slashedAmount?.toString(),
      createdAt: d.createdAt,
      resolvedAt: d.resolvedAt,
      corridor: `${d.execution.intent.sourceAsset}→${d.execution.intent.destinationAsset}`,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const body = await req.json();
  const { id } = await openDispute({
    executionId: body.executionId,
    obligationId: body.obligationId,
    providerId: body.providerId,
    reason: body.reason,
    description: body.description,
    openedById: auth.id,
  });
  return NextResponse.json({ id });
}
