import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireProvider } from "@/lib/provider-api/guard";

export async function GET(req: NextRequest) {
  const auth = await requireProvider(req, "obligations");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const obligations = await db.obligation.findMany({
    where: { providerId: auth.provider.providerId, ...(status ? { status } : {}) },
    include: { execution: { include: { intent: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({
    obligations: obligations.map((o) => ({
      id: o.id,
      executionId: o.executionId,
      amount: o.amount.toString(),
      asset: o.asset,
      status: o.status,
      dueAt: o.dueAt,
      createdAt: o.createdAt,
      fulfilledAt: o.fulfilledAt,
      corridor: `${o.execution.intent.sourceAsset}→${o.execution.intent.destinationAsset}`,
    })),
  });
}
