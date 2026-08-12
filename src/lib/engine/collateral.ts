// Collateral & exposure engine.
//
// HARD INVARIANT (non-negotiable): volatile assets can NEVER be collateral.
// This is enforced in assertCollateralEligible() and is called on every path
// that could lock collateral (API, seed, adapter, UI-backed operations).
//
// Concurrency: capacity reservations and collateral locks are performed inside
// a single Prisma interactive transaction with conditional re-checks, so two
// simultaneous executions cannot over-allocate one provider.

import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal, moneyAdd, moneySub, moneyGte, moneyLte, moneyGt, moneyLt, moneyMul, moneyMax } from "./money";
import {
  COLLATERAL_LOCK_STATUS,
  DEFAULT_COLLATERALIZATION_RATIO,
  RESERVATION_STATUS,
  SETTLEMENT_ASSET_TYPE,
  isCollateralEligible,
} from "./types";

type Tx = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// ---- Hard invariant guard ------------------------------------------------

export class CollateralInvariantError extends Error {}

export function assertCollateralEligible(asset: {
  assetType: string;
  isEligibleCollateral: boolean;
  status: string;
  symbol: string;
}) {
  if (asset.assetType === SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN) {
    throw new CollateralInvariantError(
      `Volatile asset ${asset.symbol} can never be collateral (assetType=VOLATILE_TOKEN).`,
    );
  }
  if (!isCollateralEligible(asset.assetType, asset.isEligibleCollateral, asset.status)) {
    throw new CollateralInvariantError(
      `Asset ${asset.symbol} is not eligible collateral (status=${asset.status}, eligible=${asset.isEligibleCollateral}).`,
    );
  }
}

// ---- Exposure math -------------------------------------------------------

// usable_collateral = Σ(market_value × (1 - collateral_haircut))
// max_exposure = usable_collateral / collateralization_ratio
export function computeMaxExposure(
  usableCollateral: Decimal | string | number,
  ratio: Decimal | string | number,
): Decimal {
  return new Decimal(usableCollateral).dividedBy(new Decimal(ratio));
}

// current exposure of a vault = locked collateral (active locks) + active obligations value.
// We use locked collateral as the binding measure since it is reserved atomically.
export async function currentExposure(vaultId: string, tx?: Tx): Promise<Decimal> {
  const client = tx ?? db;
  const agg = await client.collateralLock.aggregate({
    where: { vaultId, status: COLLATERAL_LOCK_STATUS.LOCKED },
    _sum: { amount: true },
  });
  return new Decimal(agg._sum.amount ?? 0);
}

// ---- Concurrency-safe collateral lock ------------------------------------

export interface LockCollateralInput {
  providerId: string;
  executionId: string;
  obligationId?: string;
  amount: Decimal | string | number;
  asset: string; // symbol of the collateral asset
  idempotencyKey: string;
  tx: Tx; // MUST be inside a transaction
}

export async function lockCollateral(input: LockCollateralInput) {
  const tx = input.tx;
  // Re-fetch the vault and the settlement asset inside the transaction.
  const vault = await tx.vault.findUnique({ where: { providerId: input.providerId } });
  if (!vault) {
    throw new Error(`Provider ${input.providerId} has no vault (trust model must be COLLATERALIZED).`);
  }
  // Re-fetch the asset to enforce the hard invariant at lock time.
  const asset = await tx.settlementAsset.findUnique({ where: { symbol: input.asset } });
  if (!asset) {
    throw new Error(`Collateral asset ${input.asset} not found.`);
  }
  assertCollateralEligible(asset);

  const exposure = await currentExposure(vault.id, tx);
  const newExposure = moneyAdd(exposure, input.amount);
  if (moneyGt(newExposure, vault.maxExposure)) {
    throw new Error(
      `Collateral breach: provider ${input.providerId} exposure ${newExposure.toString()} > max ${vault.maxExposure.toString()}.`,
    );
  }
  // Atomically increment locked collateral with a conditional update.
  const updated = await tx.vault.update({
    where: { id: vault.id, lockedCollateral: vault.lockedCollateral },
    data: { lockedCollateral: moneyAdd(vault.lockedCollateral, input.amount) },
  });
  const lock = await tx.collateralLock.create({
    data: {
      vaultId: vault.id,
      providerId: input.providerId,
      executionId: input.executionId,
      obligationId: input.obligationId ?? null,
      amount: new Decimal(input.amount),
      asset: input.asset,
      status: COLLATERAL_LOCK_STATUS.LOCKED,
    },
  });
  void updated;
  return { lock, vault: updated };
}

export async function releaseCollateralForExecution(
  executionId: string,
  tx: Tx,
) {
  const locks = await tx.collateralLock.findMany({
    where: { executionId, status: COLLATERAL_LOCK_STATUS.LOCKED },
  });
  for (const lk of locks) {
    await tx.collateralLock.update({
      where: { id: lk.id },
      data: { status: COLLATERAL_LOCK_STATUS.RELEASED },
    });
    const vault = await tx.vault.findUnique({ where: { id: lk.vaultId } });
    if (vault) {
      await tx.vault.update({
        where: { id: vault.id, lockedCollateral: vault.lockedCollateral },
        data: { lockedCollateral: moneySub(vault.lockedCollateral, lk.amount) },
      });
    }
  }
}

export async function slashCollateralForExecution(
  executionId: string,
  tx: Tx,
  compensationAccount: string,
) {
  const locks = await tx.collateralLock.findMany({
    where: { executionId, status: COLLATERAL_LOCK_STATUS.LOCKED },
  });
  for (const lk of locks) {
    await tx.collateralLock.update({
      where: { id: lk.id },
      data: { status: COLLATERAL_LOCK_STATUS.SLASHED },
    });
    // Slash: reduce usable collateral (the locked amount is forfeited).
    const vault = await tx.vault.findUnique({ where: { id: lk.vaultId } });
    if (vault) {
      await tx.vault.update({
        where: { id: vault.id },
        data: {
          usableCollateral: moneySub(vault.usableCollateral, lk.amount),
          lockedCollateral: moneySub(vault.lockedCollateral, lk.amount),
        },
      });
    }
    // Post a SLASH ledger entry moving funds to compensation account.
    await tx.ledgerEntry.create({
      data: {
        debitAccount: compensationAccount,
        creditAccount: `provider:${lk.providerId}:vault:${lk.asset}`,
        amount: lk.amount,
        asset: lk.asset,
        entryType: "SLASH",
        executionId,
        idempotencyKey: `slash:${lk.id}`,
        description: `Collateral slashed for failed execution ${executionId}`,
      },
    });
  }
}

// ---- Concurrency-safe capacity reservation -------------------------------

export interface ReserveCapacityInput {
  offerId: string;
  executionId: string;
  amount: Decimal | string | number;
  expiresAt: Date;
  idempotencyKey: string;
  tx: Tx;
}

export class CapacityExceededError extends Error {}

export async function reserveCapacity(input: ReserveCapacityInput) {
  const tx = input.tx;
  // Re-fetch the offer inside the transaction.
  const offer = await tx.liquidityOffer.findUnique({ where: { id: input.offerId } });
  if (!offer || !offer.active) {
    throw new Error(`Offer ${input.offerId} not available.`);
  }
  const available = moneySub(offer.availableCapacity, offer.reservedCapacity);
  if (moneyLt(available, input.amount)) {
    throw new CapacityExceededError(
      `Offer ${offer.id} capacity exceeded: need ${new Decimal(input.amount).toString()}, available ${available.toString()}.`,
    );
  }
  // Conditional update: only succeeds if reservedCapacity hasn't changed.
  const updated = await tx.liquidityOffer.update({
    where: { id: offer.id, reservedCapacity: offer.reservedCapacity },
    data: { reservedCapacity: moneyAdd(offer.reservedCapacity, input.amount) },
  });
  const reservation = await tx.reservation.create({
    data: {
      executionId: input.executionId,
      offerId: input.offerId,
      amount: new Decimal(input.amount),
      status: RESERVATION_STATUS.ACTIVE,
      expiresAt: input.expiresAt,
    },
  });
  void updated;
  return { reservation, offer: updated };
}

export async function releaseReservationsForExecution(executionId: string, tx: Tx) {
  const reservations = await tx.reservation.findMany({
    where: { executionId, status: RESERVATION_STATUS.ACTIVE },
  });
  for (const r of reservations) {
    await tx.reservation.update({
      where: { id: r.id },
      data: { status: RESERVATION_STATUS.RELEASED },
    });
    const offer = await tx.liquidityOffer.findUnique({ where: { id: r.offerId } });
    if (offer) {
      const newReserved = moneySub(offer.reservedCapacity, r.amount);
      await tx.liquidityOffer.update({
        where: { id: offer.id, reservedCapacity: offer.reservedCapacity },
        data: { reservedCapacity: moneyMax(newReserved, 0) },
      });
    }
  }
}

export async function consumeReservationsForExecution(executionId: string, tx: Tx) {
  const reservations = await tx.reservation.findMany({
    where: { executionId, status: RESERVATION_STATUS.ACTIVE },
  });
  for (const r of reservations) {
    await tx.reservation.update({
      where: { id: r.id },
      data: { status: RESERVATION_STATUS.CONSUMED },
    });
    // Consumed capacity is removed from available (it has been used).
    const offer = await tx.liquidityOffer.findUnique({ where: { id: r.offerId } });
    if (offer) {
      const newAvail = moneySub(offer.availableCapacity, r.amount);
      const newReserved = moneySub(offer.reservedCapacity, r.amount);
      await tx.liquidityOffer.update({
        where: { id: offer.id, reservedCapacity: offer.reservedCapacity },
        data: {
          availableCapacity: moneyMax(newAvail, 0),
          reservedCapacity: moneyMax(newReserved, 0),
        },
      });
    }
  }
}

// Recompute a vault's usable collateral from its holdings.
export function recomputeUsableCollateral(
  holdings: { assetId: string; amount: Decimal | string | number; marketValue: Decimal | string | number; collateralHaircut: number }[],
): Decimal {
  let usable = new Decimal(0);
  for (const h of holdings) {
    // Only stable / eligible assets contribute (enforced upstream).
    usable = moneyAdd(usable, moneyMul(h.marketValue, 1 - h.collateralHaircut));
  }
  return usable;
}

export function recomputeMaxExposure(usable: Decimal | string | number, ratio?: number): Decimal {
  return computeMaxExposure(usable, ratio ?? DEFAULT_COLLATERALIZATION_RATIO);
}

// Helper used by validation: would locking `amount` breach the vault?
export function wouldBreach(
  currentLocked: Decimal | string | number,
  amount: Decimal | string | number,
  maxExposure: Decimal | string | number,
): boolean {
  return moneyGt(moneyAdd(currentLocked, amount), maxExposure);
}

export function withinMax(v: Decimal, max: Decimal): boolean {
  return moneyLte(v, max);
}
