// Shared TypeScript types mirroring the dRamp API responses.

export interface RiskDimensions {
  counterparty: number;
  settlementAsset: number;
  liquidity: number;
  operational: number;
  duration: number;
  composite: number;
}

export interface PreviewLeg {
  sequence: number;
  role: string;
  providerId: string;
  providerName: string;
  providerType: string;
  trustModel: string;
  amount: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  channelType: string;
  feeBps: number;
  incentiveBps: number;
  rate: string;
}

export interface PreviewRoute {
  tag: string;
  explanation: string;
  hardFilterRejection?: string | null;
  totalCost: string;
  effectiveCost: string;
  netOutput: string;
  grossOutput: string;
  incentiveBps: number;
  expectedExecutionSeconds: number;
  hopCount: number;
  split: boolean;
  risk: RiskDimensions;
  legs: PreviewLeg[];
}

export interface RoutesPreviewResponse {
  routes: PreviewRoute[];
  error?: string;
}

export interface IntentSummary {
  id: string;
  sourceAmount: string;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  riskTolerance: string;
  executionPolicy: string;
  maxWaitSeconds: number;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
}

export interface ExecutionLeg {
  id: string;
  routeId?: string;
  executionId?: string;
  providerId: string;
  provider?: {
    id: string;
    name: string;
    providerType?: string;
    trustModel?: string;
  } | null;
  offerId?: string | null;
  offer?: {
    id: string;
    feeBps: number;
    incentiveBps: number;
    rate: string;
  } | null;
  sequence: number;
  role: string;
  amount: string;
  sourceAsset: string;
  destinationAsset: string;
  settlementAssetId?: string | null;
  channelType: string;
  status: string;
  commitmentStatus: string;
  actorId?: string | null;
  actorNote?: string | null;
  confirmedAt?: string | null;
}

export interface ExecutionObligation {
  id: string;
  executionId?: string;
  legId?: string;
  providerId: string;
  provider?: { id: string; name: string } | null;
  amount: string;
  asset: string;
  status: string;
  dueAt?: string | null;
  createdAt: string;
  fulfilledAt?: string | null;
}

export interface ExecutionCollateralLock {
  id?: string;
  status: string;
  asset: string;
  amount: string;
  providerId?: string;
}

export interface ExecutionReservation {
  id?: string;
  status: string;
  amount: string;
}

export interface ExecutionSelectedRoute {
  tag?: string;
  explanation?: string;
  legs?: Array<{
    provider?: { name: string; providerType?: string; trustModel?: string };
    providerName?: string;
    providerType?: string;
    trustModel?: string;
    amount?: string;
    sourceAsset?: string;
    destinationAsset?: string;
    channelType?: string;
    feeBps?: number;
    incentiveBps?: number;
    rate?: string;
    role?: string;
    sequence?: number;
  }>;
  risk?: RiskDimensions;
  netOutput?: string;
  effectiveCost?: string;
  totalCost?: string;
  expectedExecutionSeconds?: number;
  hopCount?: number;
}

export interface Execution {
  id: string;
  intentId: string;
  attemptNumber?: number;
  status: string;
  commitmentStatus: string;
  selectedRouteId?: string | null;
  selectedRoute?: ExecutionSelectedRoute | null;
  startedAt: string;
  completedAt?: string | null;
  failureReason?: string | null;
  waitedSeconds: number;
  intent?: IntentSummary | null;
  routes?: any[];
  obligations?: ExecutionObligation[];
  legs?: ExecutionLeg[];
  reservations?: ExecutionReservation[];
  collateralLocks?: ExecutionCollateralLock[];
}

export interface ExecutionsListResponse {
  executions: Execution[];
}

export interface ExecutionDetailResponse {
  execution: Execution;
  audit: AuditEvent[];
  /** Raw array of ledger entries (the executions/[id] endpoint inlines the array). */
  ledger: LedgerEntry[];
}

export interface IntentDetailResponse {
  intent: IntentSummary;
  execution: Execution;
  routes: any[];
  obligations: ExecutionObligation[];
  legs: ExecutionLeg[];
  audit: AuditEvent[];
  ledger: LedgerEntry[];
}

export interface ProviderVaultHolding {
  asset: string;
  amount: string;
}

export interface ProviderVault {
  id: string;
  providerId: string;
  holdings: ProviderVaultHolding[] | null;
  usableCollateral: string;
  lockedCollateral: string;
  collateralizationRatio: number;
  maxExposure: string;
}

export interface ProviderOffer {
  id: string;
  providerId: string;
  provider?: { name: string; providerType: string; trustModel: string } | null;
  capability: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  rate: string;
  feeBps: number;
  minimumAmount: string;
  maximumAmount: string;
  availableCapacity: string;
  reservedCapacity: string;
  settlementAssetId?: string | null;
  channelType: string;
  expectedExecutionSeconds: number;
  incentiveBps: number;
  active: boolean;
  expiresAt?: string | null;
}

export interface ProviderObligation {
  id: string;
  executionId?: string;
  legId?: string | null;
  providerId?: string;
  amount: string;
  asset: string;
  status: string;
  dueAt?: string | null;
  provider?: { name: string };
}

export interface Provider {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  capabilities: string[];
  countries: string[];
  reputationScore: number;
  tier?: string; // NEW | VERIFIED | TRUSTED | PREMIUM
  status: string;
  vaultId?: string | null;
  vault?: ProviderVault | null;
  offers: ProviderOffer[];
  obligations: ProviderObligation[];
  // Onboarding fields (optional — only included for operators/admins).
  jurisdiction?: string | null;
  contactEmail?: string | null;
  supportedAssets?: string[] | null;
  settlementMethods?: string[] | null;
  apiIntegrationStatus?: string | null;
  onboardingNote?: string | null;
}

export interface SettlementAsset {
  id: string;
  symbol: string;
  issuer: string;
  assetType: string;
  network: string;
  volatilityScore: number;
  liquidityScore: number;
  pegQuality: number;
  redemptionModel?: string;
  incentiveRate: number;
  incentiveSource?: string;
  settlementHaircut: number;
  collateralHaircut: number;
  isEligibleCollateral: boolean;
  maximumNetworkExposure?: string | null;
  status: string;
}

export interface ProvidersResponse {
  providers: Provider[];
  settlementAssets: SettlementAsset[];
}

export interface MonitorStats {
  providerCount: number;
  offerCount: number;
  tickerRunning: boolean;
  activeCount: number;
}

export interface MonitorResponse {
  activeExecutions: Execution[];
  recentIntents: IntentSummary[];
  stats: MonitorStats;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  executionId?: string | null;
  intentId?: string | null;
  eventType: string;
  payload: any;
  actorType: string;
  actorId?: string | null;
  prevHash: string;
  hash: string;
}

export interface AuditResponse {
  events: AuditEvent[];
  chainValid: { valid: boolean; brokenAt?: number | null };
}

export interface LedgerEntry {
  id?: string;
  timestamp: string;
  debitAccount: string;
  creditAccount: string;
  amount: string;
  asset: string;
  entryType: string;
  executionId?: string;
  obligationId?: string;
  description?: string;
}

export interface LedgerBalance {
  account: string;
  asset: string;
  balance: string;
}

export interface LedgerResponse {
  entries: LedgerEntry[];
  balances: LedgerBalance[];
}

export interface CreateIntentBody {
  sourceAmount: string | number;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  riskTolerance: string;
  executionPolicy: string;
  maxWaitSeconds: number;
  userEmail?: string;
  userName?: string;
}

export interface CreateIntentResponse {
  intentId: string;
  executionId: string;
  routes: any[];
  error?: string;
}

export interface SeedResponse {
  seeded: boolean;
  reason?: string;
  providers?: number;
  settlementAssets?: number;
  offers?: number;
  aliceId?: string;
  error?: string;
}

export interface SeedStatusResponse {
  seeded: boolean;
  needsBootstrap?: boolean;
  settlementAssets: number;
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------
export interface MarketplaceOfferProvider {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  reputationScore: number;
}

export interface MarketplaceOffer {
  id: string;
  provider: MarketplaceOfferProvider;
  capability: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  rate: string;
  feeBps: number;
  incentiveBps: number;
  capacityBucket: string; // "none" | "low" | "medium" | "high" | "deep"
  channelType: string;
  expectedExecutionSeconds: number;
  settlementAssetId?: string | null;
  expiresAt?: string | null;
  riskIndicator: number;
}

export interface MarketplaceResponse {
  offers: MarketplaceOffer[];
}

export interface PendingDemand {
  id: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  amountBucket: string; // "<500" | "500-2k" | "2k-10k" | "10k-50k" | "50k+"
  riskTolerance: string;
  executionPolicy: string;
  remainingWaitSeconds: number;
  elapsedSeconds: number;
}

export interface PendingDemandResponse {
  demand: PendingDemand[];
}

export interface CompetitionLeg {
  providerName: string;
  sourceAsset: string;
  destinationAsset: string;
  channelType: string;
  feeBps: number;
  incentiveBps: number;
}

export interface CompetitionRoute {
  tag: string;
  providerName: string;
  providerType: string;
  trustModel: string;
  effectiveCost: string;
  netOutput: string;
  expectedExecutionSeconds: number;
  hopCount: number;
  risk: RiskDimensions;
  explanation: string;
  legs: CompetitionLeg[];
}

export interface CompetitionResponse {
  routes: CompetitionRoute[];
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------
export interface OpsOverview {
  totalVolume: number | string;
  completedCount: number;
  activeExecutionCount: number;
  activeProviders: number;
  availableLiquidity: string;
  reservedLiquidity: string;
  aggregateExposure: string;
  aggregateCollateral: string;
  unsettledObligations: string;
  incentiveBudget: string;
  incentiveAccrued: string;
  incentivePaid: string;
}

export interface OpsQueueItem {
  executionId: string;
  intentId: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  amount: string;
  riskTolerance: string;
  executionPolicy: string;
  elapsedSeconds: number;
  remainingWaitSeconds: number;
  referenceRouteId?: string | null;
}

export interface OpsQueueResponse {
  queue: OpsQueueItem[];
}

export interface OpsCorridorDemand {
  corridor: string;
  count: number;
  totalAmount: number;
}

export interface OpsProviderNearCapacity {
  providerName: string;
  providerType: string;
  corridor: string;
  available: string;
  reserved: string;
  utilization: number;
}

export interface OpsManualBottleneck {
  providerName: string;
  corridor: string;
  expectedExecutionSeconds: number;
}

export interface OpsBottlenecks {
  corridorDemand: OpsCorridorDemand[];
  providersNearCapacity: OpsProviderNearCapacity[];
  manualBottlenecks: OpsManualBottleneck[];
}

export interface OpsProviderRisk {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  reputationScore: number;
  status: string;
  counterpartyRisk: number;
  exposure: string;
  maxExposure: string;
  utilization: number;
  activeOffers: number;
  activeObligations: number;
  flagged: boolean;
}

export interface OpsProviderRiskResponse {
  providers: OpsProviderRisk[];
}

export interface OpsAssetRisk {
  id: string;
  symbol: string;
  assetType: string;
  volatilityScore: number;
  liquidityScore: number;
  pegQuality: number;
  incentiveRate: number;
  riskScore: number;
  status: string;
  isEligibleCollateral: boolean;
  dependentOfferCount: number;
  providerCount: number;
}

export interface OpsAssetRiskResponse {
  assets: OpsAssetRisk[];
}

export interface OpsConcentrationItem {
  type?: string;
  country?: string;
  asset?: string;
  count?: number;
  amount?: string;
  share?: number;
}

export interface OpsConcentration {
  offersByProviderType: OpsConcentrationItem[];
  offersByCountry: OpsConcentrationItem[];
  collateralByAsset: OpsConcentrationItem[];
  totalActiveProviders: number;
  totalActiveOffers: number;
}

export interface OpsDispute {
  id: string;
  executionId: string;
  providerId: string;
  providerName: string;
  reason: string;
  description?: string | null;
  status: string;
  resolution?: string | null;
  compensationAmount?: string | null;
  slashedAmount?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  corridor: string;
}

export interface OpsDisputesResponse {
  disputes: OpsDispute[];
}

export interface OpsReconciliationItem {
  id: string;
  providerId: string;
  type: string;
  severity: string;
  status: string;
  executionId?: string | null;
  obligationId?: string | null;
  expectedAmount?: string | null;
  reportedAmount?: string | null;
  asset?: string | null;
  description?: string | null;
  resolution?: string | null;
  resolvedById?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface OpsReconciliationResponse {
  items: OpsReconciliationItem[];
}

export interface IncentiveCampaign {
  id: string;
  name: string;
  settlementAsset: string;
  sponsor: string | null;
  incentiveBps: number;
  fundingSource: string;
  startDate: string;
  endDate: string;
  totalBudget: string;
  accrued: string;
  paid: string;
  status: string;
}

export interface IncentivesResponse {
  campaigns: IncentiveCampaign[];
}

// ---------------------------------------------------------------------------
// Provider API management
// ---------------------------------------------------------------------------
export interface ApiKey {
  id: string;
  keyId: string;
  label: string;
  scopes: string[];
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiKeysResponse {
  keys: ApiKey[];
}

export interface CreateApiKeyResponse {
  keyId: string;
  secret: string;
  apiKeyId: string;
  note: string;
}

export interface WebhookDelivery {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  deliveredAt: string | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  status: string;
  createdAt: string;
  recentDeliveries: WebhookDelivery[];
}

export interface WebhooksResponse {
  endpoints: WebhookEndpoint[];
}

export interface CreateWebhookResponse {
  id: string;
  secret: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
export interface OnboardingProvider {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  capabilities?: string[] | string;
  countries?: string[] | string;
  reputationScore: number;
  status: string;
  jurisdiction?: string | null;
  contactEmail?: string | null;
  supportedAssets?: string[] | string | null;
  settlementMethods?: string[] | string | null;
  apiIntegrationStatus?: string | null;
  onboardingNote?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  vault?: any | null;
  offers?: any[];
  operators?: any[];
}

export interface OnboardingProvidersResponse {
  providers: OnboardingProvider[];
}

// ---------------------------------------------------------------------------
// Economics — reputation
// ---------------------------------------------------------------------------
export interface ReputationComponents {
  reliability: number;       // 0..100
  speed: number;             // 0..100
  liquidityQuality: number;  // 0..100
  pricing: number;           // 0..100
  disputes: number;          // 0..100
  operational: number;       // 0..100
  history: number;           // 0..100
  overall: number;           // 0..100
  sampleSize: number;
  decayNote: string;
}

export interface ReputationResult {
  providerId: string;
  components: ReputationComponents;
  tier: string;        // NEW | VERIFIED | TRUSTED | PREMIUM
  tierReason: string;
}

// ---------------------------------------------------------------------------
// Economics — provider economics, statements, win/loss
// ---------------------------------------------------------------------------
export interface ProviderEarnings {
  executionFees: string;
  incentives: string;
  rebates: string;
  penalties: string;
  slashing: string;
  compensation: string;
  netEarnings: string;
}

export interface ProviderCapital {
  committed: string;
  deployed: string;
  reserved: string;
  idle: string;
  vaultUsable: string;
  vaultLocked: string;
  maxExposure: string;
}

export interface ProviderPerformance {
  totalExecutions: number;
  completed: number;
  completionRate: number;
}

export interface ProviderEfficiency {
  earningsPerLiquidity: string;
  capitalTurnover: number;
  note: string;
}

export interface ProviderEconomicsResponse {
  earnings: ProviderEarnings;
  capital: ProviderCapital;
  performance: ProviderPerformance;
  efficiency: ProviderEfficiency;
}

export interface StatementEntry {
  timestamp: string;
  type: string;
  asset: string;
  amount: string;
  signedAmount: string;
  direction: "credit" | "debit";
  executionId?: string | null;
  description?: string | null;
}

export interface StatementSummary {
  executionFees: string;
  incentives: string;
  slashing: string;
  compensation: string;
  refunds: string;
  netChange: string;
  entryCount: number;
}

export interface ProviderStatementResponse {
  providerId: string;
  period: { start: string; end: string };
  entries: StatementEntry[];
  summary: StatementSummary;
}

export interface QuoteWinLossResponse {
  totalQuotes: number;
  wins: number;
  losses: number;
  winRate: number;
  lossReasons: Record<string, number>;
  recentResults: Array<{
    corridor: string;
    result: string;
    ourFeeBps: number | null;
    winnerFeeBps: number | null;
    reasonLost: string | null;
    createdAt: string;
  }>;
}

// ---------------------------------------------------------------------------
// Economics — market intelligence (public)
// ---------------------------------------------------------------------------
export interface OpportunityItem {
  corridor: string;
  demandAmount: number | string;
  supplyAmount: number | string;
  gap: number | string;
  gapPct: number;
  estimatedSpreadBps: number;
  opportunity: "HIGH" | "MEDIUM" | "LOW" | string;
  note: string;
}

export interface OpportunitiesResponse {
  opportunities: OpportunityItem[];
}

export interface PricingOffer {
  provider: string;
  providerType: string;
  tier: string | null;
  reputation: number;
  feeBps: number;
  rate: string;
  availableCapacity: string;
  channelType: string;
  expectedExecutionSeconds: number;
}

export interface PricingFill {
  amount: string;
  feeBps: number | null;
  completedAt: string | null;
}

export interface PricingIntelligenceResponse {
  corridor: string;
  offerCount: number;
  cheapestFeeBps?: number;
  medianFeeBps?: number;
  mostExpensiveFeeBps?: number;
  fastestExecutionSeconds?: number;
  fastestProvider?: string;
  offers?: PricingOffer[];
  recentFills?: PricingFill[];
  message?: string;
}

// ---------------------------------------------------------------------------
// Economics — network health / unit economics / funnel (admin)
// ---------------------------------------------------------------------------
export interface NetworkHealthResponse {
  liquidityDepth: number;
  routeCompetition: number;
  providerReliability: number;
  executionSuccess: number;
  averageWait: number;
  riskConcentration: number;
  overall: number;
  components: Record<string, number>;
}

export interface UnitEconomicsCorridor {
  corridor: string;
  volume: string;
  count: number;
  fees: string;
  avgTakeRateBps: number;
}

export interface UnitEconomicsResponse {
  totalVolume: number | string;
  completedCount: number;
  totalFees: string;
  avgCostBps: number;
  corridors: UnitEconomicsCorridor[];
}

export interface AcquisitionFunnelResponse {
  applied: number;
  approved: number;
  connected: number;
  publishedOffer: number;
  receivedExecution: number;
  completedExecution: number;
  repeatProvider: number;
  conversionRates: {
    appliedToApproved: number;
    approvedToConnected: number;
    connectedToPublished: number;
    publishedToFirstExecution: number;
    firstToRepeat: number;
  };
}

// ---------------------------------------------------------------------------
// Commitments (operator + admin)
// ---------------------------------------------------------------------------
export interface CommitmentItem {
  id: string;
  providerId?: string;
  providerName?: string;
  corridor: string;
  minimumLiquidity: string;
  targetExecutionSeconds: number;
  status: string;
  reliability: number;
  samples: number;
  avgAvailable: string;
  endDate: string;
}

export interface CommitmentsResponse {
  commitments: CommitmentItem[];
}

export interface CommitmentSampleResponse {
  met: boolean;
  available: string | number;
}
