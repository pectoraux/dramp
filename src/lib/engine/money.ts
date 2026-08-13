// Decimal-safe monetary arithmetic for dRamp.
// All money flows through Decimal to avoid floating-point corruption.

import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export type Money = Decimal;

export function toMoney(v: Decimal | number | string): Decimal {
  return new Decimal(v);
}

export function moneyAdd(a: Decimal | number | string, b: Decimal | number | string): Decimal {
  return new Decimal(a).plus(new Decimal(b));
}

export function moneySub(a: Decimal | number | string, b: Decimal | number | string): Decimal {
  return new Decimal(a).minus(new Decimal(b));
}

export function moneyMul(a: Decimal | number | string, b: Decimal | number | string): Decimal {
  return new Decimal(a).times(new Decimal(b));
}

export function moneyDiv(a: Decimal | number | string, b: Decimal | number | string): Decimal {
  return new Decimal(a).dividedBy(new Decimal(b));
}

export function moneyGte(a: Decimal | number | string, b: Decimal | number | string): boolean {
  return new Decimal(a).gte(new Decimal(b));
}

export function moneyLte(a: Decimal | number | string, b: Decimal | number | string): boolean {
  return new Decimal(a).lte(new Decimal(b));
}

export function moneyGt(a: Decimal | number | string, b: Decimal | number | string): boolean {
  return new Decimal(a).gt(new Decimal(b));
}

export function moneyLt(a: Decimal | number | string, b: Decimal | number | string): boolean {
  return new Decimal(a).lt(new Decimal(b));
}

export function moneyMin(a: Decimal | number | string, b: Decimal | number | string): Decimal {
  return Decimal.min(new Decimal(a), new Decimal(b));
}

export function moneyMax(a: Decimal | number | string, b: Decimal | number | string): Decimal {
  return Decimal.max(new Decimal(a), new Decimal(b));
}

export function moneyZero(): Decimal {
  return new Decimal(0);
}

export function bpsToFactor(bps: number): Decimal {
  return new Decimal(bps).dividedBy(10000);
}

// Apply a fee in basis points to an amount. Returns the fee portion.
export function feeForAmount(amount: Decimal | number | string, feeBps: number): Decimal {
  return new Decimal(amount).times(bpsToFactor(feeBps));
}

// Apply an incentive in basis points (a rebate). Returns the incentive portion.
export function incentiveForAmount(amount: Decimal | number | string, incentiveBps: number): Decimal {
  return new Decimal(amount).times(bpsToFactor(incentiveBps));
}

// Round to a fixed number of decimals for display/storage.
export function roundMoney(v: Decimal | number | string, decimals = 6): Decimal {
  return new Decimal(v).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}

// Format for display (2 dp by default).
export function formatMoney(v: Decimal | number | string, decimals = 2): string {
  return new Decimal(v).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toString();
}
