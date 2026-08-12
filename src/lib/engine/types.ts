// dRamp domain vocabulary — canonical enums & constants.
// These mirror the spec exactly. Backend logic must validate against these.

export const RISK_TOLERANCE = {
  MAX_RELIABILITY: "MAX_RELIABILITY",
  BALANCED: "BALANCED",
  LOWEST_COST: "LOWEST_COST",
} as const;
export type RiskTolerance = (typeof RISK_TOLERANCE)[keyof typeof RISK_TOLERANCE];

export const EXECUTION_POLICY = {
  NOW: "NOW",
  WAIT_FOR_BETTER: "WAIT_FOR_BETTER",
} as const;
export type ExecutionPolicy = (typeof EXECUTION_POLICY)[keyof typeof EXECUTION_POLICY];

export const CANCELLATION_POLICY = {
  CANCEL_ANYTIME_WHILE_REVERSIBLE: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
  CANCEL_AFTER_TIMEOUT: "CANCEL_AFTER_TIMEOUT",
  AUTO_CANCEL_AT_EXPIRY: "AUTO_CANCEL_AT_EXPIRY",
  USER_MANAGED: "USER_MANAGED",
} as const;
export type CancellationPolicy =
  (typeof CANCELLATION_POLICY)[keyof typeof CANCELLATION_POLICY];

export const INTENT_STATUS = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
} as const;

// Canonical execution state machine
export const EXECUTION_STATUS = {
  INTENT_CREATED: "INTENT_CREATED",
  SEARCHING: "SEARCHING",
  ROUTE_FOUND: "ROUTE_FOUND",
  ROUTE_RESERVED: "ROUTE_RESERVED",
  ORIGIN_PENDING: "ORIGIN_PENDING",
  ORIGIN_CONFIRMED: "ORIGIN_CONFIRMED",
  TOKENIZED: "TOKENIZED",
  SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
  SETTLED: "SETTLED",
  DESTINATION_PENDING: "DESTINATION_PENDING",
  DESTINATION_CONFIRMED: "DESTINATION_CONFIRMED",
  COMPLETED: "COMPLETED",
  // failure branches
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
  DISPUTED: "DISPUTED",
  REFUNDED: "REFUNDED",
} as const;
export type ExecutionStatus = (typeof EXECUTION_STATUS)[keyof typeof EXECUTION_STATUS];

// Ordered happy-path states for progress display
export const HAPPY_PATH: string[] = [
  EXECUTION_STATUS.INTENT_CREATED,
  EXECUTION_STATUS.SEARCHING,
  EXECUTION_STATUS.ROUTE_FOUND,
  EXECUTION_STATUS.ROUTE_RESERVED,
  EXECUTION_STATUS.ORIGIN_PENDING,
  EXECUTION_STATUS.ORIGIN_CONFIRMED,
  EXECUTION_STATUS.TOKENIZED,
  EXECUTION_STATUS.SETTLEMENT_PENDING,
  EXECUTION_STATUS.SETTLED,
  EXECUTION_STATUS.DESTINATION_PENDING,
  EXECUTION_STATUS.DESTINATION_CONFIRMED,
  EXECUTION_STATUS.COMPLETED,
];

export const TERMINAL_STATES = new Set<string>([
  EXECUTION_STATUS.COMPLETED,
  EXECUTION_STATUS.EXPIRED,
  EXECUTION_STATUS.CANCELLED,
  EXECUTION_STATUS.FAILED,
  EXECUTION_STATUS.REFUNDED,
]);

export const COMMITMENT_STATUS = {
  REVERSIBLE: "REVERSIBLE",
  PARTIALLY_COMMITTED: "PARTIALLY_COMMITTED",
  IRREVERSIBLE: "IRREVERSIBLE",
} as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUS)[keyof typeof COMMITMENT_STATUS];

export const PROVIDER_TYPE = {
  LOCAL_FIAT_AGENT: "LOCAL_FIAT_AGENT",
  PSP: "PSP",
  BANK: "BANK",
  STABLECOIN_LP: "STABLECOIN_LP",
  CEX: "CEX",
  DEX: "DEX",
  TREASURY: "TREASURY",
  MARKET_MAKER: "MARKET_MAKER",
  SETTLEMENT_ASSET_SPONSOR: "SETTLEMENT_ASSET_SPONSOR",
  HYBRID: "HYBRID",
} as const;
export type ProviderType = (typeof PROVIDER_TYPE)[keyof typeof PROVIDER_TYPE];

export const TRUST_MODEL = {
  COLLATERALIZED: "COLLATERALIZED",
  INSTITUTIONALLY_TRUSTED: "INSTITUTIONALLY_TRUSTED",
  PRE_FUNDED: "PRE_FUNDED",
  EXTERNAL_ESCROW: "EXTERNAL_ESCROW",
  NON_CUSTODIAL: "NON_CUSTODIAL",
} as const;
export type TrustModel = (typeof TRUST_MODEL)[keyof typeof TRUST_MODEL];

export const CAPABILITY = {
  FIAT_IN: "FIAT_IN",
  FIAT_OUT: "FIAT_OUT",
  SETTLEMENT_IN: "SETTLEMENT_IN",
  SETTLEMENT_OUT: "SETTLEMENT_OUT",
  SWAP: "SWAP",
  FX: "FX",
  BANK_TRANSFER: "BANK_TRANSFER",
  MOBILE_MONEY: "MOBILE_MONEY",
  CASH: "CASH",
  CARD: "CARD",
  ONCHAIN_TRANSFER: "ONCHAIN_TRANSFER",
  ONCHAIN_SWAP: "ONCHAIN_SWAP",
  CEX_EXECUTION: "CEX_EXECUTION",
  DEX_EXECUTION: "DEX_EXECUTION",
} as const;
export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

export const PROVIDER_STATUS = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export const CHANNEL_TYPE = {
  AUTOMATIC: "AUTOMATIC",
  MANUAL: "MANUAL",
} as const;
export type ChannelType = (typeof CHANNEL_TYPE)[keyof typeof CHANNEL_TYPE];

export const SETTLEMENT_ASSET_TYPE = {
  STABLECOIN: "STABLECOIN",
  VOLATILE_TOKEN: "VOLATILE_TOKEN",
  INTERNAL_SETTLEMENT_UNIT: "INTERNAL_SETTLEMENT_UNIT",
} as const;
export type SettlementAssetType = (typeof SETTLEMENT_ASSET_TYPE)[keyof typeof SETTLEMENT_ASSET_TYPE];

export const LEG_ROLE = {
  SOURCE: "SOURCE",
  SETTLEMENT_HOP: "SETTLEMENT_HOP",
  DESTINATION: "DESTINATION",
} as const;
export type LegRole = (typeof LEG_ROLE)[keyof typeof LEG_ROLE];

export const LEG_STATUS = {
  PENDING: "PENDING",
  RESERVED: "RESERVED",
  IN_PROGRESS: "IN_PROGRESS",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export const ROUTE_STATUS = {
  CANDIDATE: "CANDIDATE",
  SELECTED: "SELECTED",
  RESERVED: "RESERVED",
  SUPERSEDED: "SUPERSEDED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
} as const;

export const ROUTE_TAG = {
  BEST: "BEST",
  CHEAPEST: "CHEAPEST",
  FASTEST: "FASTEST",
  SAFEST: "SAFEST",
  CANDIDATE: "CANDIDATE",
} as const;

export const OBLIGATION_STATUS = {
  CREATED: "CREATED",
  ACTIVE: "ACTIVE",
  FULFILLED: "FULFILLED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
  DISPUTED: "DISPUTED",
  SLASHED: "SLASHED",
} as const;
export type ObligationStatus = (typeof OBLIGATION_STATUS)[keyof typeof OBLIGATION_STATUS];

export const RESERVATION_STATUS = {
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  CONSUMED: "CONSUMED",
  EXPIRED: "EXPIRED",
} as const;

export const COLLATERAL_LOCK_STATUS = {
  LOCKED: "LOCKED",
  RELEASED: "RELEASED",
  SLASHED: "SLASHED",
} as const;

export const LEDGER_ENTRY_TYPE = {
  MINT: "MINT",
  BURN: "BURN",
  TRANSFER: "TRANSFER",
  LOCK: "LOCK",
  RELEASE: "RELEASE",
  SLASH: "SLASH",
  FEE: "FEE",
  INCENTIVE: "INCENTIVE",
  COMPENSATION: "COMPENSATION",
  REFUND: "REFUND",
} as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPE)[keyof typeof LEDGER_ENTRY_TYPE];

export const AUDIT_ACTOR = {
  SYSTEM: "SYSTEM",
  USER: "USER",
  PROVIDER: "PROVIDER",
} as const;

// Hard invariant: volatile assets can never be collateral.
//
// Asset TYPE is the authoritative determinant of collateral eligibility —
// not the mutable `isEligibleCollateral` flag. The flag can only RESTRICT
// eligibility (operational delisting of a stablecoin) but can never GRANT it
// for a type that is structurally ineligible (VOLATILE_TOKEN).
//
// Eligibility logic:
//   VOLATILE_TOKEN          → never eligible (type-based, immutable)
//   STABLECOIN / ISU        → eligible IF flag is true AND status is ACTIVE
//
// `normalizeCollateralEligibility` enforces the type→flag consistency at
// write time so the stored flag can never contradict the type.

export function isCollateralEligible(
  assetType: string,
  isEligibleCollateral: boolean,
  status: string,
): boolean {
  // Asset type is authoritative — volatile tokens are NEVER eligible,
  // regardless of the mutable flag.
  if (assetType === SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN) return false;
  if (status !== "ACTIVE") return false;
  // For non-volatile types, the flag may restrict (delist) but the type
  // is what makes them eligible candidates.
  return isEligibleCollateral;
}

// Enforce type→flag consistency at every write path. A VOLATILE_TOKEN must
// always have isEligibleCollateral=false; if a caller tries to set it true,
// this function silently corrects it so the stored data can never contradict
// the invariant. Returns the normalized flag value.
export function normalizeCollateralEligibility(
  assetType: string,
  isEligibleCollateral: boolean,
): boolean {
  if (assetType === SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN) return false;
  return isEligibleCollateral;
}

// Detect a data-integrity violation: a volatile asset whose stored
// isEligibleCollateral flag is true (the flag contradicts the type). This
// should never happen if normalizeCollateralEligibility was used at write
// time, but we check defensively at lock time.
export function isCollateralFlagConsistent(
  assetType: string,
  isEligibleCollateral: boolean,
): boolean {
  if (assetType === SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN && isEligibleCollateral) {
    return false; // inconsistent: volatile asset claims eligibility
  }
  return true;
}

// Default collateralization ratio (150%).
export const DEFAULT_COLLATERALIZATION_RATIO = 1.5;

// dRamp internal settlement unit symbol.
export const INTERNAL_SETTLEMENT_UNIT_SYMBOL = "SC";
