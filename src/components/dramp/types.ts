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
  status: string;
  vaultId?: string | null;
  vault?: ProviderVault | null;
  offers: ProviderOffer[];
  obligations: ProviderObligation[];
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
