// LiquidityCommitmentService — provider liquidity commitments + monitoring.
//
// ARCHITECTURE RULE: commitments are separate from offers. An offer says "I
// currently have this price/capacity." A commitment says "I promise to maintain
// this service level." Commitment reliability affects reputation and routing.

import { db } from "@/lib/db";
import { Decimal, moneyGte, moneyLte } from "@/lib/engine/money";
import { appendAuditEvent } from "@/lib/engine/audit";

export interface CommitmentInput {
  providerId: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  minimumLiquidity: Decimal | string | number;
  maximumLiquidity?: Decimal | string | number;
  targetExecutionSeconds: number;
  operatingHoursStart?: number;
  operatingHoursEnd?: number;
  endDate: Date;
}

export async function createCommitment(input: CommitmentInput): Promise<{ id: string }> {
  const c = await db.liquidityCommitment.create({
    data: {
      providerId: input.providerId,
      sourceAsset: input.sourceAsset,
      destinationAsset: input.destinationAsset,
      sourceCountry: input.sourceCountry,
      destinationCountry: input.destinationCountry,
      minimumLiquidity: new Decimal(input.minimumLiquidity),
      maximumLiquidity: input.maximumLiquidity ? new Decimal(input.maximumLiquidity) : null,
      targetExecutionSeconds: input.targetExecutionSeconds,
      operatingHoursStart: input.operatingHoursStart ?? null,
      operatingHoursEnd: input.operatingHoursEnd ?? null,
      startDate: new Date(),
      endDate: input.endDate,
      status: "ACTIVE",
    },
  });
  await appendAuditEvent({
    eventType: "commitment_created",
    payload: { commitmentId: c.id, providerId: input.providerId, corridor: `${input.sourceAsset}→${input.destinationAsset}`, min: input.minimumLiquidity.toString() },
    actorType: "PROVIDER",
    actorId: input.providerId,
  });
  return { id: c.id };
}

// Sample a commitment: check if the provider's current available capacity
// meets the committed minimum. Called periodically (on-demand / ticker).
export async function sampleCommitment(commitmentId: string): Promise<{ met: boolean; available: Decimal }> {
  const c = await db.liquidityCommitment.findUnique({ where: { id: commitmentId } });
  if (!c || c.status !== "ACTIVE") return { met: false, available: new Decimal(0) };

  // Sum available capacity across the provider's active offers on this corridor.
  const offers = await db.liquidityOffer.findMany({
    where: {
      providerId: c.providerId,
      active: true,
      sourceAsset: c.sourceAsset,
      destinationAsset: c.destinationAsset,
      sourceCountry: c.sourceCountry,
      destinationCountry: c.destinationCountry,
    },
    select: { availableCapacity: true, reservedCapacity: true },
  });
  const available = offers.reduce(
    (s, o) => s.plus(new Decimal(o.availableCapacity).minus(new Decimal(o.reservedCapacity))),
    new Decimal(0),
  );
  const met = moneyGte(available, c.minimumLiquidity);

  // Update reliability tracking.
  const newSamples = c.samples + 1;
  const newSamplesMet = c.samplesMet + (met ? 1 : 0);
  const newAvg = new Decimal(c.avgAvailable).plus(available).dividedBy(2); // running average
  const newReliability = newSamples > 0 ? newSamplesMet / newSamples : 0;

  const newStatus = !met && newSamples > 5 && newReliability < 0.5 ? "BREACHED" : c.status;

  await db.liquidityCommitment.update({
    where: { id: commitmentId },
    data: {
      samples: newSamples,
      samplesMet: newSamplesMet,
      avgAvailable: newAvg,
      reliabilityPct: newReliability,
      status: newStatus,
    },
  });

  return { met, available };
}

// Sample all active commitments (called by the ticker / on-demand).
export async function sampleAllCommitments(limit = 50): Promise<number> {
  const commitments = await db.liquidityCommitment.findMany({
    where: { status: "ACTIVE" },
    take: limit,
  });
  let sampled = 0;
  for (const c of commitments) {
    try {
      await sampleCommitment(c.id);
      sampled++;
    } catch (err) {
      console.error(`[dRamp economics] commitment sample error for ${c.id}:`, err);
    }
  }
  return sampled;
}

// Get a provider's commitments.
export async function getProviderCommitments(providerId: string) {
  const commitments = await db.liquidityCommitment.findMany({
    where: { providerId },
    orderBy: { createdAt: "desc" },
  });
  return commitments.map((c) => ({
    id: c.id,
    corridor: `${c.sourceAsset}:${c.sourceCountry} → ${c.destinationAsset}:${c.destinationCountry}`,
    minimumLiquidity: c.minimumLiquidity.toString(),
    maximumLiquidity: c.maximumLiquidity?.toString(),
    targetExecutionSeconds: c.targetExecutionSeconds,
    operatingHours: c.operatingHoursStart != null ? `${c.operatingHoursStart}:00-${c.operatingHoursEnd}:00` : null,
    startDate: c.startDate,
    endDate: c.endDate,
    status: c.status,
    reliability: Math.round(c.reliabilityPct * 100) / 100,
    samples: c.samples,
    avgAvailable: c.avgAvailable.toString(),
  }));
}

// Get commitment reliability summary for the routing engine.
// Returns a map: providerId → best commitment reliability (0..1).
export async function getCommitmentReliabilityMap(): Promise<Map<string, number>> {
  const commitments = await db.liquidityCommitment.findMany({
    where: { status: "ACTIVE", samples: { gte: 3 } },
    select: { providerId: true, reliabilityPct: true },
  });
  const map = new Map<string, number>();
  for (const c of commitments) {
    const existing = map.get(c.providerId) ?? 0;
    if (c.reliabilityPct > existing) map.set(c.providerId, c.reliabilityPct);
  }
  return map;
}
