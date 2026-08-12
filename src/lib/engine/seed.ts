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
  normalizeCollateralEligibility,
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
    await db.waitlistEntry.deleteMany();
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
      isEligibleCollateral: normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.STABLECOIN, true),
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
      isEligibleCollateral: normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.STABLECOIN, true),
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
      isEligibleCollateral: normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.INTERNAL_SETTLEMENT_UNIT, true),
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
      isEligibleCollateral: normalizeCollateralEligibility(SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN, false),
      maximumNetworkExposure: new Decimal(500000),
      status: "ACTIVE",
    },
  });

  // Verify the hard invariant on the volatile asset: WETH must NEVER be
  // eligible collateral. The asset TYPE is authoritative — even if the
  // mutable flag were somehow set true, normalizeCollateralEligibility
  // would have forced it false at write time, and assertCollateralEligible
  // would reject it at lock time. Here we verify the stored flag is
  // consistent with the type.
  if (weth.assetType === SETTLEMENT_ASSET_TYPE.VOLATILE_TOKEN && weth.isEligibleCollateral) {
    throw new Error("Hard invariant violated: WETH must not be eligible collateral");
  }

  // ---- Providers (Prompt 2 network: realistic mock providers) ------------
  // Onboarding fields populated so the Ops console + provider portal work.

  const northbridge = await db.liquidityProvider.create({
    data: {
      name: "Northbridge Bank",
      providerType: PROVIDER_TYPE.BANK,
      trustModel: TRUST_MODEL.COLLATERALIZED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.FIAT_OUT, CAPABILITY.BANK_TRANSFER]),
      countries: JSON.stringify(["US", "EU"]),
      reputationScore: 0.85,
      status: "ACTIVE",
      jurisdiction: "US",
      contactEmail: "ops@northbridge.example",
      supportedAssets: JSON.stringify(["USD", "EUR", "USDC"]),
      settlementMethods: JSON.stringify(["BANK_TRANSFER"]),
      apiIntegrationStatus: "CONNECTED",
    },
  });

  const sahel = await db.liquidityProvider.create({
    data: {
      name: "SwiftPay PSP",
      providerType: PROVIDER_TYPE.PSP,
      trustModel: TRUST_MODEL.PRE_FUNDED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.FIAT_OUT, CAPABILITY.MOBILE_MONEY]),
      countries: JSON.stringify(["US", "EU", "NG", "PH"]),
      reputationScore: 0.78,
      status: "ACTIVE",
      jurisdiction: "EU",
      contactEmail: "api@swift-pay.example",
      supportedAssets: JSON.stringify(["USD", "EUR", "NGN", "USDC"]),
      settlementMethods: JSON.stringify(["MOBILE_MONEY", "BANK_TRANSFER"]),
      apiIntegrationStatus: "CONNECTED",
    },
  });

  const apexBank = await db.liquidityProvider.create({
    data: {
      name: "Meridian Liquidity",
      providerType: PROVIDER_TYPE.STABLECOIN_LP,
      trustModel: TRUST_MODEL.COLLATERALIZED,
      capabilities: JSON.stringify([CAPABILITY.SETTLEMENT_IN, CAPABILITY.SETTLEMENT_OUT, CAPABILITY.ONCHAIN_TRANSFER, CAPABILITY.FIAT_IN]),
      countries: JSON.stringify(["GLOBAL", "US", "EU"]),
      reputationScore: 0.9,
      status: "ACTIVE",
      jurisdiction: "US",
      contactEmail: "treasury@meridian-lp.example",
      supportedAssets: JSON.stringify(["USDC", "EURC", "SC"]),
      settlementMethods: JSON.stringify(["ONCHAIN_TRANSFER"]),
      apiIntegrationStatus: "CONNECTED",
    },
  });

  const novapay = await db.liquidityProvider.create({
    data: {
      name: "Atlas Exchange",
      providerType: PROVIDER_TYPE.CEX,
      trustModel: TRUST_MODEL.PRE_FUNDED,
      capabilities: JSON.stringify([CAPABILITY.CEX_EXECUTION, CAPABILITY.SWAP, CAPABILITY.ONCHAIN_TRANSFER]),
      countries: JSON.stringify(["GLOBAL"]),
      reputationScore: 0.85,
      status: "ACTIVE",
      jurisdiction: "EU",
      contactEmail: "api@atlas-exchange.example",
      supportedAssets: JSON.stringify(["USDC", "EURC", "WETH"]),
      settlementMethods: JSON.stringify(["ONCHAIN_TRANSFER"]),
      apiIntegrationStatus: "CONNECTED",
    },
  });

  const centrex = await db.liquidityProvider.create({
    data: {
      name: "OpenSwap",
      providerType: PROVIDER_TYPE.DEX,
      trustModel: TRUST_MODEL.NON_CUSTODIAL,
      capabilities: JSON.stringify([CAPABILITY.DEX_EXECUTION, CAPABILITY.ONCHAIN_SWAP]),
      countries: JSON.stringify(["GLOBAL"]),
      reputationScore: 0.75,
      status: "ACTIVE",
      jurisdiction: "GLOBAL",
      contactEmail: "info@openswap.example",
      supportedAssets: JSON.stringify(["USDC", "EURC", "WETH"]),
      settlementMethods: JSON.stringify(["ONCHAIN_SWAP"]),
      apiIntegrationStatus: "CONNECTED",
    },
  });

  const fluidex = await db.liquidityProvider.create({
    data: {
      name: "Sahara Cash",
      providerType: PROVIDER_TYPE.LOCAL_FIAT_AGENT,
      trustModel: TRUST_MODEL.COLLATERALIZED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.FIAT_OUT, CAPABILITY.CASH, CAPABILITY.MOBILE_MONEY]),
      countries: JSON.stringify(["US", "EU", "NG"]),
      reputationScore: 0.7,
      status: "ACTIVE",
      jurisdiction: "NG",
      contactEmail: "ops@sahara-cash.example",
      supportedAssets: JSON.stringify(["USD", "EUR", "NGN"]),
      settlementMethods: JSON.stringify(["CASH", "MOBILE_MONEY"]),
      apiIntegrationStatus: "PENDING",
    },
  });

  const anchor = await db.liquidityProvider.create({
    data: {
      name: "Continental Treasury",
      providerType: PROVIDER_TYPE.TREASURY,
      trustModel: TRUST_MODEL.INSTITUTIONALLY_TRUSTED,
      capabilities: JSON.stringify([CAPABILITY.FIAT_IN, CAPABILITY.FIAT_OUT, CAPABILITY.SETTLEMENT_IN, CAPABILITY.SETTLEMENT_OUT, CAPABILITY.BANK_TRANSFER]),
      countries: JSON.stringify(["US", "EU", "NG"]),
      reputationScore: 0.95,
      status: "ACTIVE",
      jurisdiction: "US",
      contactEmail: "treasury@continental.example",
      supportedAssets: JSON.stringify(["USD", "EUR", "NGN", "USDC"]),
      settlementMethods: JSON.stringify(["BANK_TRANSFER"]),
      apiIntegrationStatus: "CONNECTED",
    },
  });

  // A pending provider application (for the Ops onboarding demo).
  await db.liquidityProvider.create({
    data: {
      name: "Pacific Rail FX",
      providerType: PROVIDER_TYPE.MARKET_MAKER,
      trustModel: TRUST_MODEL.COLLATERALIZED,
      capabilities: JSON.stringify([CAPABILITY.SWAP, CAPABILITY.FX]),
      countries: JSON.stringify(["US", "EU", "JP"]),
      reputationScore: 0.6,
      status: "APPLIED",
      jurisdiction: "JP",
      contactEmail: "apply@pacific-rail.example",
      supportedAssets: JSON.stringify(["USD", "EUR", "JPY", "USDC"]),
      settlementMethods: JSON.stringify(["BANK_TRANSFER"]),
      apiIntegrationStatus: "NONE",
      onboardingNote: "Market maker seeking to provide USD/JPY/EUR liquidity.",
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

  // ---- Admin + demo users + waitlist -------------------------------------
  // Real admin (non-demo): ekontetevi@gmail / Payswap123456
  const { hashPassword } = await import("@/lib/auth");
  const adminHash = await hashPassword("Payswap123456");
  const admin = await db.user.create({
    data: { email: "ekontetevi@gmail.com", name: "Admin", password: adminHash, role: "ADMIN", status: "ACTIVE", isDemo: false },
  });

  // Demo accounts (quick-login). Password: Demo1234!
  const demoHash = await hashPassword("Demo1234!");
  const alice = await db.user.create({
    data: { email: "alice@dramp.demo", name: "Alice", password: demoHash, role: "USER", status: "ACTIVE", isDemo: true },
  });
  // The demo operator is bound to Northbridge Fiat (a local fiat agent with
  // manual legs) so they can confirm/fail legs on that provider only.
  const operator = await db.user.create({
    data: { email: "operator@dramp.demo", name: "Provider Operator", password: demoHash, role: "PROVIDER_OPERATOR", status: "ACTIVE", isDemo: true, providerId: northbridge.id },
  });
  const demoAdmin = await db.user.create({
    data: { email: "admin@dramp.demo", name: "Demo Admin", password: demoHash, role: "ADMIN", status: "ACTIVE", isDemo: true },
  });

  // A couple of pending waitlist entries so the admin has something to review.
  await db.waitlistEntry.create({
    data: { email: "samuel.okafor@example.com", name: "Samuel Okafor", requestedRole: "USER", status: "PENDING", note: "Wants to send USD→NGN." },
  });
  await db.waitlistEntry.create({
    data: { email: "lucia.rivera@example.com", name: "Lucia Rivera", requestedRole: "PROVIDER_OPERATOR", status: "PENDING", note: "Fiat agent in Mexico." },
  });

  // ---- Prompt 2: incentive campaign + API key + webhook ------------------
  // An active EURC incentive campaign (40 bps, $5000 budget).
  await db.settlementIncentiveCampaign.create({
    data: {
      settlementAssetId: eurc.id,
      sponsorProviderId: null,
      name: "EURC Summer Settlement Incentive",
      incentiveBps: 40,
      fundingSource: "issuer",
      startDate: new Date(Date.now() - 86400000),
      endDate: new Date(Date.now() + 30 * 86400000),
      totalBudget: new Decimal(5000),
      perTxnCap: new Decimal(100),
      volumeCap: null,
      eligibleCorridors: null,
      eligibleRiskLevels: JSON.stringify(["BALANCED", "LOWEST_COST"]),
      eligibleProviderTypes: null,
      status: "ACTIVE",
      accrued: new Decimal(0),
      paid: new Decimal(0),
    },
  });
  // An active SC incentive campaign (smaller, to show competition).
  await db.settlementIncentiveCampaign.create({
    data: {
      settlementAssetId: sc.id,
      sponsorProviderId: apexBank.id,
      name: "SC Internal Settlement Reward",
      incentiveBps: 25,
      fundingSource: "sponsor",
      startDate: new Date(Date.now() - 86400000),
      endDate: new Date(Date.now() + 60 * 86400000),
      totalBudget: new Decimal(2000),
      perTxnCap: new Decimal(50),
      volumeCap: null,
      eligibleCorridors: null,
      eligibleRiskLevels: null,
      eligibleProviderTypes: null,
      status: "ACTIVE",
      accrued: new Decimal(0),
      paid: new Decimal(0),
    },
  });

  // API key for the demo operator's provider (Northbridge).
  const { createApiKey } = await import("@/lib/provider-api/auth");
  const apiKeyResult = await createApiKey(northbridge.id, "Northbridge API Key", ["offers", "executions", "obligations", "reconcile"]);

  // Webhook endpoint for Northbridge.
  await db.webhookEndpoint.create({
    data: {
      providerId: northbridge.id,
      url: "https://mock.northbridge.example/webhooks/dramp",
      secret: "whsec_demo_northbridge_001",
      events: JSON.stringify(["execution.accepted", "execution.rejected", "execution.completed", "obligation.created"]),
      status: "ACTIVE",
    },
  });

  return {
    seeded: true,
    providers: 8,
    settlementAssets: 4,
    offers: 13,
    incentiveCampaigns: 2,
    aliceId: alice.id,
    adminId: admin.id,
    operatorId: operator.id,
    demoAdminId: demoAdmin.id,
    demoCredentials: {
      alice: { email: "alice@dramp.demo", password: "Demo1234!", role: "USER" },
      operator: { email: "operator@dramp.demo", password: "Demo1234!", role: "PROVIDER_OPERATOR" },
      demoAdmin: { email: "admin@dramp.demo", password: "Demo1234!", role: "ADMIN" },
      realAdmin: { email: "ekontetevi@gmail.com", password: "Payswap123456", role: "ADMIN" },
    },
    providerApiKey: { keyId: apiKeyResult.keyId, secret: apiKeyResult.secret, note: "Use as Bearer pk_xxx:sk_xxx in the Open Liquidity API. Store securely." },
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
