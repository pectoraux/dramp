// Seed data for dRamp — establishes the marketplace used by the golden demo.
//
// Providers: 2 local fiat agents, 1 bank, 1 PSP, 1 CEX, 1 DEX, 1 stablecoin LP
// Settlement assets: established stablecoin (USDC), newer stablecoin (EURC),
//   internal settlement unit (SC), one volatile token (WETH)
// Offers: cheap / fast / safe / manual / incentivized / hard-constraint-failing
//
// HARD INVARIANT: the volatile token (WETH) is NEVER eligible collateral.
// This is enforced here and re-checked at every collateral lock.

import { db } from "@/lib/db";
import { Decimal } from "./money";
import {
  CAPABILITY,
  PROVIDER_TYPE,
  SETTLEMENT_ASSET_TYPE,
  TRUST_MODEL,
} from "./types";
import { assertCollateralEligible } from "./collateral";

export async function seedDatabase(opts: { reset?: boolean } = {}) {
  if (opts.reset) {
    // Wipe in dependency order.
    await db.ledgerEntry.deleteMany();
    await db.auditEvent.deleteMany();
    await db.collateralLock.deleteMany();
    await db.reservation.deleteMany();
    await db.obligation.deleteMany();
    await db.leg.deleteMany();
    await db.route.deleteMany();
    await db.execution.deleteMany();
    await db.executionIntent.deleteMany();
    await db.marketSignal.deleteMany();
    await db.idempotencyRecord.deleteMany();
    await db.vault.deleteMany();
    await db.liquidityOffer.deleteMany();
    await db.liquidityProvider.deleteMany();
    await db.settlementAsset.deleteMany();
    await db.user.deleteMany();
  }

  // Bail if already seeded (idempotent).
  const existing = await db.settlementAsset.count();
  if (existing > 0 && !opts.reset) {
    return { seeded: false, reason: "already seeded" };
  }

  // ---- Settlement assets -------------------------------------------------
  const usdc = await db.settlementAsset.create({
    data: {
      symbol: "USDC",
      issuer: "Circle",
      assetType: SETTLEMENT_ASSET_TYPE.STABLECOIN,
      network: "Ethereum",
      volatilityScore: 0.02,
      liquidityScore: 0.95,
      pegQuality: 0.99,
      redemptionModel: "regulated_issuer",
      incentiveRate: 0,
      settlementHaircut: 0.0,
      collateralHaircut: 0.05,
      isEligibleCollateral: true,
      maximumNetworkExposure: new Decimal(5000000),
      status: "ACTIVE",
    },
  });

  const eurc = await db.settlementAsset.create({
    data: {
      symbol: "EURC",
      issuer: "Circle EU",
      assetType: SETTLEMENT_ASSET_TYPE.STABLECOIN,
      network: "Ethereum",
      volatilityScore: 0.05,
      liquidityScore: 0.7,
      pegQuality: 0.95,
      redemptionModel: "regulated_issuer",
      incentiveRate: 20, // 20 bps subsidy
      incentiveSource: "issuer",
      settlementHaircut: 0.0,
      collateralHaircut: 0.1,
      isEligibleCollateral: true,
      maximumNetworkExposure: new Decimal(1000000),
      status: "ACTIVE",
    },
  });

  const sc = await db.settlementAsset.create({
    data: {
      symbol: "SC",
      issuer: "dRamp (internal)",
      assetType: SETTLEMENT_ASSET_TYPE.INTERNAL_SETTLEMENT_UNIT,
      network: "dRamp-ledger",
      volatilityScore: 0.0,
      liquidityScore: 0.9,
      pegQuality: 1.0,
      redemptionModel: "internal_credit",
      incentiveRate: 40, // 40 bps subsidy to encourage internal settlement
      incentiveSource: "dRamp",
      settlementHaircut: 0.0,
      collateralHaircut: 0.0,
      isEligibleCollateral: true,
      maximumNetworkExposure: new Decimal(2000000),
      status: "ACTIVE",
    },
  });

  const weth = await db.settlementAsset.create({
    data: {
      symbol: "WETH",
      issuer: "Wrapped Ether",
      assetType: SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN,
      network: "Ethereum",
      volatilityScore: 0.6,
      liquidityScore: 0.6,
      pegQuality: null,
      redemptionModel: "onchain_collateral",
      incentiveRate: 0,
      settlementHaircut: 0.0,
      collateralHaircut: 0.5, // irrelevant — can never be collateral
      isEligibleCollateral: false, // HARD INVARIANT
      maximumNetworkExposure: new Decimal(500000),
      status: "ACTIVE",
    },
  });

  // Verify the hard invariant on the volatile asset: WETH must NEVER be
  // eligible collateral. (The assertCollateralEligible guard throws when an
  // attempt is made to USE a volatile asset as collateral — that is enforced
  // at lock time. Here we only verify the seed config is correct.)
  if (weth.assetType === SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN && weth.isEligibleCollateral) {
    throw new Error("Hard invariant violated: WETH must not be eligible collateral");
  }

  // ---- Providers ---------------------------------------------------------

  const northbridge = await db.liquidityProvider.create({
    data: {
      name: "Northbridge Fiat",
      providerType: PROVIDER_TYPE.LOCAL_FIAT_AGENT,
      trustModel: TRUST_MODEL.COLLATERALIZED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.FIAT_OUT, CAPABILITY.CASH, CAPABILITY.BANK_TRANSFER]),
      countries: JSON.stringify(["US", "EU"]),
      reputationScore: 0.85,
      status: "ACTIVE",
    },
  });

  const sahel = await db.liquidityProvider.create({
    data: {
      name: "Sahel Pay",
      providerType: PROVIDER_TYPE.LOCAL_FIAT_AGENT,
      trustModel: TRUST_MODEL.COLLATERALIZED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.FIAT_OUT, CAPABILITY.MOBILE_MONEY]),
      countries: JSON.stringify(["US", "EU", "PH"]),
      reputationScore: 0.7,
      status: "ACTIVE",
    },
  });

  const apexBank = await db.liquidityProvider.create({
    data: {
      name: "Apex Bank",
      providerType: PROVIDER_TYPE.BANK,
      trustModel: TRUST_MODEL.INSTITUTIONALLY_TRUSTED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.FIAT_OUT, CAPABILITY.BANK_TRANSFER]),
      countries: JSON.stringify(["US", "EU"]),
      reputationScore: 0.95,
      status: "ACTIVE",
    },
  });

  const novapay = await db.liquidityProvider.create({
    data: {
      name: "NovaPay PSP",
      providerType: PROVIDER_TYPE.PSP,
      trustModel: TRUST_MODEL.PRE_FUNDED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.SETTLEMENT_IN, CAPABILITY.CARD]),
      countries: JSON.stringify(["US", "EU"]),
      reputationScore: 0.8,
      status: "ACTIVE",
    },
  });

  const centrex = await db.liquidityProvider.create({
    data: {
      name: "Centrex CEX",
      providerType: PROVIDER_TYPE.CEX,
      trustModel: TRUST_MODEL.PRE_FUNDED,
      capabilities: JSON.stringify([CAPABILITY.CEX_EXECUTION, CAPABILITY.SWAP, CAPABILITY.ONCHAIN_TRANSFER]),
      countries: JSON.stringify(["GLOBAL"]),
      reputationScore: 0.85,
      status: "ACTIVE",
    },
  });

  const fluidex = await db.liquidityProvider.create({
    data: {
      name: "Fluidex DEX",
      providerType: PROVIDER_TYPE.DEX,
      trustModel: TRUST_MODEL.NON_CUSTODIAL,
      capabilities: JSON.stringify([CAPABILITY.DEX_EXECUTION, CAPABILITY.ONCHAIN_SWAP]),
      countries: JSON.stringify(["GLOBAL"]),
      reputationScore: 0.75,
      status: "ACTIVE",
    },
  });

  const anchor = await db.liquidityProvider.create({
    data: {
      name: "Anchor Stable LP",
      providerType: PROVIDER_TYPE.STABLECOIN_LP,
      trustModel: TRUST_MODEL.COLLATERALIZED,
      capabilities: JSON.stringify([CAPABILITY.SETTLEMENT_IN, CAPABILITY.SETTLEMENT_OUT, CAPABILITY.ONCHAIN_TRANSFER, CAPABILITY.FIAT_IN]),
      countries: JSON.stringify(["GLOBAL", "US", "EU"]),
      reputationScore: 0.9,
      status: "ACTIVE",
    },
  });

  // ---- Vaults (only collateralized providers) ---------------------------

  const northbridgeVault = await createVault(northbridge.id, [
    { asset: "USDC", amount: 20000 },
  ]);
  const sahelVault = await createVault(sahel.id, [
    { asset: "USDC", amount: 15000 },
  ]);
  const anchorVault = await createVault(anchor.id, [
    { asset: "USDC", amount: 30000 },
    { asset: "SC", amount: 10000 },
  ]);

  // Link vault ids back to providers.
  await db.liquidityProvider.update({ where: { id: northbridge.id }, data: { vaultId: northbridgeVault.id } });
  await db.liquidityProvider.update({ where: { id: sahel.id }, data: { vaultId: sahelVault.id } });
  await db.liquidityProvider.update({ where: { id: anchor.id }, data: { vaultId: anchorVault.id } });

  // ---- Offers ------------------------------------------------------------

  const now = Date.now();
  const exp = () => new Date(now + 60 * 60_000);

  // Route 1 — SAFE / BEST (initial): NovaPay PSP -> Apex Bank, USDC, automatic
  await db.liquidityOffer.create({
    data: {
      providerId: novapay.id, capability: CAPABILITY.FIAT_IN,
      sourceAsset: "USD", destinationAsset: "USDC", sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: new Decimal(1.0), feeBps: 30, minimumAmount: 10, maximumAmount: 80000,
      availableCapacity: new Decimal(80000), settlementAssetId: usdc.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 45, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });
  await db.liquidityOffer.create({
    data: {
      providerId: apexBank.id, capability: CAPABILITY.FIAT_OUT,
      sourceAsset: "USDC", destinationAsset: "EUR", sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(0.92), feeBps: 20, minimumAmount: 10, maximumAmount: 100000,
      availableCapacity: new Decimal(100000), settlementAssetId: usdc.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 30, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });

  // Route 2 — CHEAP (incentivized SC, manual payout): Anchor LP -> Sahel Pay
  await db.liquidityOffer.create({
    data: {
      providerId: anchor.id, capability: CAPABILITY.SETTLEMENT_IN,
      sourceAsset: "USD", destinationAsset: "SC", sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: new Decimal(1.0), feeBps: 15, minimumAmount: 10, maximumAmount: 60000,
      availableCapacity: new Decimal(60000), settlementAssetId: sc.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 20, incentiveBps: 40, active: true, expiresAt: exp(),
    },
  });
  await db.liquidityOffer.create({
    data: {
      providerId: sahel.id, capability: CAPABILITY.FIAT_OUT,
      sourceAsset: "SC", destinationAsset: "EUR", sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(0.92), feeBps: 10, minimumAmount: 10, maximumAmount: 40000,
      availableCapacity: new Decimal(40000), settlementAssetId: sc.id,
      channelType: "MANUAL", expectedExecutionSeconds: 120, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });

  // Route 3 — FAST: NovaPay PSP -> Centrex CEX, automatic
  await db.liquidityOffer.create({
    data: {
      providerId: novapay.id, capability: CAPABILITY.FIAT_IN,
      sourceAsset: "USD", destinationAsset: "USDC", sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: new Decimal(1.0), feeBps: 35, minimumAmount: 10, maximumAmount: 50000,
      availableCapacity: new Decimal(50000), settlementAssetId: usdc.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 10, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });
  await db.liquidityOffer.create({
    data: {
      providerId: centrex.id, capability: CAPABILITY.CEX_EXECUTION,
      sourceAsset: "USDC", destinationAsset: "EUR", sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(0.92), feeBps: 25, minimumAmount: 10, maximumAmount: 70000,
      availableCapacity: new Decimal(70000), settlementAssetId: usdc.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 15, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });

  // Route 4 — MANUAL: Northbridge both hops (manual confirmation)
  await db.liquidityOffer.create({
    data: {
      providerId: northbridge.id, capability: CAPABILITY.FIAT_IN,
      sourceAsset: "USD", destinationAsset: "USDC", sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: new Decimal(1.0), feeBps: 25, minimumAmount: 10, maximumAmount: 30000,
      availableCapacity: new Decimal(30000), settlementAssetId: usdc.id,
      channelType: "MANUAL", expectedExecutionSeconds: 60, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });
  await db.liquidityOffer.create({
    data: {
      providerId: northbridge.id, capability: CAPABILITY.FIAT_OUT,
      sourceAsset: "USDC", destinationAsset: "EUR", sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(0.92), feeBps: 15, minimumAmount: 10, maximumAmount: 30000,
      availableCapacity: new Decimal(30000), settlementAssetId: usdc.id,
      channelType: "MANUAL", expectedExecutionSeconds: 90, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });

  // Route 5 — FAILS HARD CONSTRAINT (volatile WETH settlement asset).
  // Realistic rates: 1 USDC ≈ 0.0004 WETH (1 WETH ≈ $2500), 1 WETH ≈ 2300 EUR.
  await db.liquidityOffer.create({
    data: {
      providerId: fluidex.id, capability: CAPABILITY.ONCHAIN_SWAP,
      sourceAsset: "USDC", destinationAsset: "WETH", sourceCountry: "GLOBAL", destinationCountry: "GLOBAL",
      rate: new Decimal(0.0004), feeBps: 5, minimumAmount: 10, maximumAmount: 100000,
      availableCapacity: new Decimal(100000), settlementAssetId: weth.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 20, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });
  await db.liquidityOffer.create({
    data: {
      providerId: fluidex.id, capability: CAPABILITY.ONCHAIN_SWAP,
      sourceAsset: "WETH", destinationAsset: "EUR", sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(2300), feeBps: 8, minimumAmount: 0.0001, maximumAmount: 100,
      availableCapacity: new Decimal(100), settlementAssetId: weth.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 30, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });

  // EURC corridor (newer stablecoin, incentivized) — adds route diversity
  await db.liquidityOffer.create({
    data: {
      providerId: centrex.id, capability: CAPABILITY.SWAP,
      sourceAsset: "USDC", destinationAsset: "EURC", sourceCountry: "GLOBAL", destinationCountry: "GLOBAL",
      rate: new Decimal(0.92), feeBps: 12, minimumAmount: 10, maximumAmount: 80000,
      availableCapacity: new Decimal(80000), settlementAssetId: eurc.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 20, incentiveBps: 20, active: true, expiresAt: exp(),
    },
  });
  await db.liquidityOffer.create({
    data: {
      providerId: apexBank.id, capability: CAPABILITY.FIAT_OUT,
      sourceAsset: "EURC", destinationAsset: "EUR", sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(1.0), feeBps: 15, minimumAmount: 10, maximumAmount: 80000,
      availableCapacity: new Decimal(80000), settlementAssetId: eurc.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 25, incentiveBps: 0, active: true, expiresAt: exp(),
    },
  });

  // ---- Alice (demo user) -------------------------------------------------
  const alice = await db.user.create({
    data: { email: "alice@dramp.demo", name: "Alice" },
  });

  return {
    seeded: true,
    providers: 7,
    settlementAssets: 4,
    offers: 12,
    aliceId: alice.id,
    note: "Volatile asset WETH is NEVER eligible collateral (hard invariant enforced).",
  };
}

async function createVault(providerId: string, holdings: { asset: string; amount: number }[]) {
  // Compute usable collateral = Σ amount × (1 - collateral_haircut)
  let usable = new Decimal(0);
  for (const h of holdings) {
    const sa = await db.settlementAsset.findUnique({ where: { symbol: h.asset } });
    if (!sa) throw new Error(`Settlement asset ${h.asset} not found for vault`);
    // Hard invariant: volatile assets cannot be in a vault's usable collateral.
    assertCollateralEligible(sa);
    usable = usable.plus(new Decimal(h.amount).times(1 - sa.collateralHaircut));
  }
  const ratio = 1.5;
  const maxExposure = usable.dividedBy(ratio);
  return db.vault.create({
    data: {
      providerId,
      holdingsJson: JSON.stringify(holdings),
      usableCollateral: usable,
      lockedCollateral: new Decimal(0),
      collateralizationRatio: ratio,
      maxExposure,
    },
  });
}
