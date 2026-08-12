import { NextRequest, NextResponse } from "next/server";
import { createIntent } from "@/lib/engine/execution";
import { scheduleBetterLiquidity } from "@/lib/engine/ticker";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";
import { EXECUTION_POLICY } from "@/lib/engine/types";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const idempotencyKey = body.idempotencyKey ?? makeKey("create-intent", JSON.stringify(body));

  try {
    const result = await runIdempotent(idempotencyKey, "create-intent", body, async () => {
      const { intent, execution, routes } = await createIntent({
        userId: body.userId,
        userEmail: body.userEmail,
        userName: body.userName,
        sourceAmount: body.sourceAmount,
        sourceAsset: body.sourceAsset,
        sourceCountry: body.sourceCountry,
        destinationAsset: body.destinationAsset,
        destinationCountry: body.destinationCountry,
        riskTolerance: body.riskTolerance,
        executionPolicy: body.executionPolicy,
        maxWaitSeconds: body.maxWaitSeconds,
        cancellationPolicy: body.cancellationPolicy,
        minimumDestinationAmount: body.minimumDestinationAmount,
        maximumTotalCost: body.maximumTotalCost,
        targetRate: body.targetRate,
        allowedSettlementAssets: body.allowedSettlementAssets,
        prohibitedSettlementAssets: body.prohibitedSettlementAssets,
      });

      // For WAIT_FOR_BETTER, schedule a deterministic "better liquidity appears"
      // signal so the golden demo shows route re-evaluation + replacement.
      if (body.executionPolicy === EXECUTION_POLICY.WAIT_FOR_BETTER) {
        await scheduleBetterLiquidity(intent, 15).catch(() => {});
      }

      return { status: 200, body: { intentId: intent.id, executionId: execution.id, routes: routes.map(serializeRoute) } };
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "create-intent failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function serializeRoute(r: { id: string; tag: string; explanation: string; hardFilterRejection?: string; effectiveCost: { toString(): string }; netOutput: { toString(): string }; totalCost: { toString(): string }; expectedExecutionSeconds: number; hopCount: number; split: boolean; risk: { counterparty: number; settlementAsset: number; liquidity: number; operational: number; duration: number; composite: number }; legs: Array<{ providerId: string; sourceAsset: string; destinationAsset: string; channelType: string; role: string; feeBps: number; incentiveBps: number; amount: { toString(): string } }> }) {
  return {
    id: r.id,
    tag: r.tag,
    explanation: r.explanation,
    hardFilterRejection: r.hardFilterRejection,
    effectiveCost: r.effectiveCost.toString(),
    netOutput: r.netOutput.toString(),
    totalCost: r.totalCost.toString(),
    expectedExecutionSeconds: r.expectedExecutionSeconds,
    hopCount: r.hopCount,
    split: r.split,
    risk: r.risk,
    legs: r.legs.map((l) => ({
      providerId: l.providerId,
      sourceAsset: l.sourceAsset,
      destinationAsset: l.destinationAsset,
      channelType: l.channelType,
      role: l.role,
      feeBps: l.feeBps,
      incentiveBps: l.incentiveBps,
      amount: l.amount.toString(),
    })),
  };
}
