import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";

// List executions that involve this provider (via legs).
export async function GET(req: NextRequest) {
  const auth = await requireProvider(req, "executions");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  const legs = await db.leg.findMany({
    where: { providerId: auth.provider.providerId },
    select: { executionId: true },
    distinct: ["executionId"],
  });
  const executionIds = legs.map((l) => l.executionId).filter(Boolean) as string[];
  const executions = await db.execution.findMany({
    where: { id: { in: executionIds }, ...(status ? { status } : {}) },
    include: { intent: true, legs: { where: { providerId: auth.provider.providerId }, include: { offer: true } } },
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  return NextResponse.json({
    executions: executions.map((e) => ({
      id: e.id,
      status: e.status,
      commitmentStatus: e.commitmentStatus,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      intent: {
        sourceAsset: e.intent.sourceAsset,
        destinationAsset: e.intent.destinationAsset,
        sourceAmount: e.intent.sourceAmount.toString(),
      },
      legs: e.legs.map((l) => ({
        id: l.id,
        role: l.role,
        status: l.status,
        channelType: l.channelType,
        amount: l.amount.toString(),
        sourceAsset: l.sourceAsset,
        destinationAsset: l.destinationAsset,
      })),
    })),
  });
}
