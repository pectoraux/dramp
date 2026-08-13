/**
 * dRamp collateral eligibility invariant — regression tests.
 *
 * Proves that asset TYPE (not the mutable isEligibleCollateral flag) is the
 * authoritative determinant of collateral eligibility:
 *   - VOLATILE_TOKEN is never eligible, regardless of the flag.
 *   - normalizeCollateralEligibility forces the flag false for volatile types.
 *   - assertCollateralEligible throws on volatile assets AND on flag/type
 *     inconsistency (volatile + flag=true = data integrity violation).
 *   - Non-volatile types (STABLECOIN, INTERNAL_SETTLEMENT_UNIT) remain
 *     eligible when the flag is true and status is ACTIVE.
 *
 * These are pure unit tests — no running server required.
 *
 * Usage: bun tests/collateral-invariant.test.ts
 */

import {
  isCollateralEligible,
  normalizeCollateralEligibility,
  isCollateralFlagConsistent,
  SETTLEMENT_ASSET_TYPE,
} from "../src/lib/engine/types";
import { assertCollateralEligible, CollateralInvariantError } from "../src/lib/engine/collateral";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertThrows(fn: () => void, ErrorClass: new (...args: any[]) => Error, label: string) {
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  assert(threw && caught instanceof ErrorClass, `${label} (expected ${ErrorClass.name})`);
}

function assertDoesNotThrow(fn: () => void, label: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(!threw, `${label} (should not throw)`);
}

// ---- isCollateralEligible: asset type is authoritative ------------------

console.log("== isCollateralEligible: asset type authoritative ==");

// Volatile token is NEVER eligible, regardless of the flag.
assert(
  isCollateralEligible(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, false, "ACTIVE") === false,
  "VOLATILE_TOKEN + flag=false + ACTIVE → false",
);
assert(
  isCollateralEligible(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, true, "ACTIVE") === false,
  "VOLATILE_TOKEN + flag=TRUE + ACTIVE → false (flag cannot override type)",
);
assert(
  isCollateralEligible(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, true, "INELIGIBLE") === false,
  "VOLATILE_TOKEN + flag=true + INELIGIBLE → false",
);

// Stablecoin: eligible when flag=true and status=ACTIVE.
assert(
  isCollateralEligible(SETTLEMENT_ASSET_TYPE.STABLECOIN, true, "ACTIVE") === true,
  "STABLECOIN + flag=true + ACTIVE → true",
);
// Stablecoin: not eligible when flag=false (operational delisting).
assert(
  isCollateralEligible(SETTLEMENT_ASSET_TYPE.STABLECOIN, false, "ACTIVE") === false,
  "STABLECOIN + flag=false + ACTIVE → false (flag restricts)",
);
// Stablecoin: not eligible when status != ACTIVE.
assert(
  isCollateralEligible(SETTLEMENT_ASSET_TYPE.STABLECOIN, true, "INELIGIBLE") === false,
  "STABLECOIN + flag=true + INELIGIBLE → false",
);

// Internal settlement unit: eligible when flag=true and status=ACTIVE.
assert(
  isCollateralEligible(SETTLEMENT_ASSET_TYPE.INTERNAL_SETTLEMENT_UNIT, true, "ACTIVE") === true,
  "INTERNAL_SETTLEMENT_UNIT + flag=true + ACTIVE → true",
);

// ---- normalizeCollateralEligibility: write-time enforcement ------------

console.log("\n== normalizeCollateralEligibility: write-time enforcement ==");

// Volatile token: normalizer always returns false, even if input is true.
assert(
  normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, false) === false,
  "normalize(VOLATILE_TOKEN, false) → false",
);
assert(
  normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, true) === false,
  "normalize(VOLATILE_TOKEN, TRUE) → false (forced false at write time)",
);

// Non-volatile: normalizer passes the flag through unchanged.
assert(
  normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.STABLECOIN, true) === true,
  "normalize(STABLECOIN, true) → true",
);
assert(
  normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.STABLECOIN, false) === false,
  "normalize(STABLECOIN, false) → false",
);
assert(
  normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.INTERNAL_SETTLEMENT_UNIT, true) === true,
  "normalize(INTERNAL_SETTLEMENT_UNIT, true) → true",
);

// ---- isCollateralFlagConsistent: data-integrity detection --------------

console.log("\n== isCollateralFlagConsistent: data-integrity detection ==");

assert(
  isCollateralFlagConsistent(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, true) === false,
  "VOLATILE_TOKEN + flag=true → INCONSISTENT (data integrity violation)",
);
assert(
  isCollateralFlagConsistent(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, false) === true,
  "VOLATILE_TOKEN + flag=false → consistent",
);
assert(
  isCollateralFlagConsistent(SETTLEMENT_ASSET_TYPE.STABLECOIN, true) === true,
  "STABLECOIN + flag=true → consistent",
);
assert(
  isCollateralFlagConsistent(SETTLEMENT_ASSET_TYPE.STABLECOIN, false) === true,
  "STABLECOIN + flag=false → consistent",
);

// ---- assertCollateralEligible: lock-time defense -----------------------

console.log("\n== assertCollateralEligible: lock-time defense ==");

// Volatile asset always throws, regardless of flag.
assertThrows(
  () => assertCollateralEligible({ assetType: SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, isEligibleCollateral: false, status: "ACTIVE", symbol: "WETH" }),
  CollateralInvariantError,
  "assert(VOLATILE_TOKEN, flag=false) throws",
);
assertThrows(
  () => assertCollateralEligible({ assetType: SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, isEligibleCollateral: true, status: "ACTIVE", symbol: "WETH" }),
  CollateralInvariantError,
  "assert(VOLATILE_TOKEN, flag=TRUE) throws (flag cannot override type)",
);

// Data-integrity violation: volatile asset with flag=true is detected.
// (This should never happen if normalizeCollateralEligibility was used, but
// we check defensively.)
assertThrows(
  () => assertCollateralEligible({ assetType: SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, isEligibleCollateral: true, status: "ACTIVE", symbol: "CORRUPT" }),
  CollateralInvariantError,
  "assert(VOLATILE_TOKEN, flag=true) throws data-integrity violation",
);

// Non-volatile eligible asset does NOT throw.
assertDoesNotThrow(
  () => assertCollateralEligible({ assetType: SETTLEMENT_ASSET_TYPE.STABLECOIN, isEligibleCollateral: true, status: "ACTIVE", symbol: "USDC" }),
  "assert(STABLECOIN, flag=true, ACTIVE) does not throw",
);
assertDoesNotThrow(
  () => assertCollateralEligible({ assetType: SETTLEMENT_ASSET_TYPE.INTERNAL_SETTLEMENT_UNIT, isEligibleCollateral: true, status: "ACTIVE", symbol: "SC" }),
  "assert(INTERNAL_SETTLEMENT_UNIT, flag=true, ACTIVE) does not throw",
);

// Non-volatile with flag=false throws (operational delisting).
assertThrows(
  () => assertCollateralEligible({ assetType: SETTLEMENT_ASSET_TYPE.STABLECOIN, isEligibleCollateral: false, status: "ACTIVE", symbol: "DEPEG" }),
  CollateralInvariantError,
  "assert(STABLECOIN, flag=false) throws (delisted)",
);

// Non-volatile with status=INELIGIBLE throws.
assertThrows(
  () => assertCollateralEligible({ assetType: SETTLEMENT_ASSET_TYPE.STABLECOIN, isEligibleCollateral: true, status: "INELIGIBLE", symbol: "DELISTED" }),
  CollateralInvariantError,
  "assert(STABLECOIN, status=INELIGIBLE) throws",
);

// ---- Summary -----------------------------------------------------------

console.log(`\n========================================`);
console.log(`  Collateral invariant: Passed: ${passed}  |  Failed: ${failed}`);
console.log(`========================================`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
