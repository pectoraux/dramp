import { NextRequest, NextResponse } from "next/server";
import { findRoutes } from "@/lib/engine/routing";
import { db } from "@/lib/db";
import { requireUser, isAuthed } from "@/lib/auth-guard";

// Preview available routes for a corridor WITHOUT creating an intent.
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  try {
    const candidates = await findRoutes({
      sourceAmount: body.sourceAmount,
      sourceAsset: body.sourceAsset,
      sourceCountry: body.sourceCountry,
      destinationAsset: body.destinationAsset,
      destinationCountry: body.destinationCountry,
      riskTolerance: body.riskTolerance ?? "BALANCED",
      allowedSettlementAssets: body.allowedSettlementAssets ?? [],
      prohibitedSettlementAssets: body.prohibitedSettlementAssets ?? [],
    });

    const providerIds = new Set<string>();
    for (const c of candidates) for (const l of c.legs) providerIds.add(l.providerId);
    const providers = await db.liquidityProvider.findMany({ where: { id: { in: [...providerIds] } } });
    const pMap = new Map(providers.map((p) => [p.id, p] as const));

    return NextResponse.json({
      routes: candidates.map((c) => ({
        tag: c.tag,
        explanation: c.explanation,
        hardFilterRejection: c.hardFilterRejection,
        totalCost: c.totalCost.toString(),
        effectiveCost: c.effectiveCost.toString(),
        netOutput: c.netOutput.toString(),
        grossOutput: c.grossOutput.toString(),
        incentiveBps: c.incentiveBps,
        expectedExecutionSeconds: c.expectedExecutionSeconds,
        hopCount: c.hopCount,
        split: c.split,
        risk: c.risk,
        legs: c.legs.map((l) => ({
          sequence: l.sequence,
          role: l.role,
          providerId: l.providerId,
          providerName: pMap.get(l.providerId)?.name ?? "Unknown",
          providerType: pMap.get(l.providerId)?.providerType ?? "",
          trustModel: pMap.get(l.providerId)?.trustModel ?? "",
          amount: l.amount.toString(),
          sourceAsset: l.sourceAsset,
          destinationAsset: l.destinationAsset,
          sourceCountry: l.sourceCountry,
          destinationCountry: l.destinationCountry,
          channelType: l.channelType,
          feeBps: l.feeBps,
          incentiveBps: l.incentiveBps,
          rate: l.rate.toString(),
        })),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
