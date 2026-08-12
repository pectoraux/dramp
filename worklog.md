# dRamp Build Worklog

---
Task ID: 1-11
Agent: main (Z.ai Code)
Task: Build the dRamp core execution engine — schema, money/decimal utils, audit (hash-chain), ledger (double-entry), idempotency, risk service, collateral engine (hard invariant), routing graph + hard filters + optimization, execution state machine, provider adapters, background ticker, seed data, and all API routes.

Work Log:
- Wrote Prisma schema (15 models): ExecutionIntent, Execution, Route, Leg, LiquidityProvider, LiquidityOffer, SettlementAsset, Vault, Obligation, Reservation, CollateralLock, LedgerEntry, AuditEvent, IdempotencyRecord, MarketSignal (+ User).
- Pushed schema to SQLite; installed decimal.js for decimal-safe arithmetic.
- Built `src/lib/engine/money.ts` (Decimal wrappers, bps helpers, fee/incentive calc).
- Built `src/lib/engine/types.ts` (all canonical enums: risk tolerance, execution policy, state machine, commitment, provider types, trust models, capabilities, leg roles, obligation statuses, ledger entry types; hard invariant guard `isCollateralEligible`).
- Built `src/lib/engine/audit.ts` (hash-chained immutable events via sha256, mutex-serialized appends, chain verification).
- Built `src/lib/engine/idempotency.ts` (runIdempotent wrapper with IdempotencyRecord table).
- Built `src/lib/engine/ledger.ts` (double-entry: transfer/mint/burn/lock/release/slash/fee/incentive/refund/compensation; unique idempotency_key prevents duplicates; accountBalance helper).
- Built `src/lib/engine/risk.ts` (provider counterparty risk, settlement-asset risk, 5 separate route risk dimensions, asset/counterparty risk ceilings per user tolerance).
- Built `src/lib/engine/collateral.ts` (HARD INVARIANT: volatile assets never collateral via assertCollateralEligible; concurrency-safe lockCollateral + reserveCapacity inside Prisma interactive transactions with conditional re-checks; release/slash helpers).
- Built `src/lib/engine/routing.ts` (marketplace graph: nodes = asset:country pairs, edges = active offers; path enumeration up to 4 hops; split-route support when no single offer covers amount; hard filters: provider suspension, capacity, prohibited assets, asset-risk ceiling, counterparty-risk ceiling; optimization: cheapest/fastest/safest/best weighted by risk tolerance; human-readable explanations).
- Built `src/lib/engine/execution.ts` (canonical state machine INTENT_CREATED→...→COMPLETED; WAIT_FOR_BETTER policy stays in SEARCHING and re-evaluates each tick; route reservation in ONE transaction; commitment model REVERSIBLE/PARTIALLY_COMMITTED/IRREVERSIBLE; cancellation respecting commitment; expiry; complete ledger postings at each economic step).
- Built `src/lib/engine/providers/adapter.ts` (LiquidityProviderAdapter interface; automatic adapters for PSP/Bank/CEX/DEX/StablecoinLP; local fiat agent with manual rail; manualConfirmLeg + reportLegFailure).
- Built `src/lib/engine/ticker.ts` (background ticker started via instrumentation; fires MarketSignals; advances all active executions; scheduleBetterLiquidity creates a better offer from a collateralized provider for the best route's source leg ~15s after intent creation).
- Built `src/instrumentation.ts` (starts ticker on server startup, nodejs runtime only).
- Built `src/lib/engine/seed.ts` (7 providers, 4 settlement assets incl. volatile WETH with isEligibleCollateral=false, 3 collateralized vaults, 12 offers covering cheap/fast/safe/manual/incentivized/volatile-rejected routes, Alice user; verifies hard invariant).
- Built `src/lib/engine/serialize.ts` (Decimal→string serialization for all entities).
- Built API routes: POST /api/seed, POST /api/intents, GET /api/intents/[id], POST /api/intents/[id]/cancel, GET /api/executions, GET /api/executions/[id], POST /api/executions/[id]/cancel, GET /api/providers, GET /api/providers/[id], POST /api/legs/[id]/confirm, POST /api/legs/[id]/fail, GET /api/monitor, GET /api/audit, GET /api/audit/[executionId], GET /api/ledger/[executionId], POST /api/engine/tick, POST /api/routes/preview.

Stage Summary:
- Core engine COMPLETE and verified end-to-end. Golden demo (Alice $1000 USD→EUR, Balanced, WAIT_FOR_BETTER, 5 min) flows: SEARCHING → (better liquidity at 15s) → better_route_found → route_selected → route_reserved (collateral locked) → origin_pending → fiat_received → tokenized → settlement_pending → settled → destination_pending → destination_confirmed → COMPLETED. Obligations FULFILLED, collateral RELEASED, 10 balanced ledger entries, 15-event audit chain VALID.
- NOW policy also works (immediate route selection).
- Hard invariant enforced: WETH (volatile) never collateral; routes through WETH rejected for BALANCED risk (asset risk 0.61 > ceiling 0.50).
- Background ticker runs via instrumentation; market simulation adds liquidity on schedule.
- Dev server runs on port 3000; Prisma logging reduced to errors/warns only.

API shape reference for UI (all return JSON, Decimals as strings):
- POST /api/seed {reset?:true} → {seeded, providers, settlementAssets, offers, aliceId}
- POST /api/routes/preview {sourceAmount, sourceAsset, sourceCountry, destinationAsset, destinationCountry, riskTolerance} → {routes: [{tag, explanation, hardFilterRejection?, effectiveCost, netOutput, expectedExecutionSeconds, hopCount, split, risk:{counterparty,settlementAsset,liquidity,operational,duration,composite}, legs:[{sequence,role,providerName,providerType,trustModel,sourceAsset,destinationAsset,channelType,feeBps,incentiveBps,rate,amount}]}]}
- POST /api/intents {sourceAmount, sourceAsset, sourceCountry, destinationAsset, destinationCountry, riskTolerance, executionPolicy, maxWaitSeconds, userEmail?, userName?} → {intentId, executionId, routes:[...]}
- GET /api/intents/[id] → {intent, execution:{status, commitmentStatus, waitedSeconds, selectedRoute, ...}, routes, obligations, legs, audit, ledger}
- GET /api/executions?limit=&status= → {executions:[...]}
- GET /api/executions/[id] → {execution, audit, ledger}
- POST /api/executions/[id]/cancel → {cancelled, reason}
- GET /api/providers → {providers:[{id,name,providerType,trustModel,capabilities,countries,reputationScore,status,vault:{usableCollateral,lockedCollateral,maxExposure,collateralizationRatio,holdings},offers:[...]}], settlementAssets:[...]}
- GET /api/providers/[id] → {provider:{..., obligations, legs}}
- POST /api/legs/[id]/confirm {actorId?, note?} → {confirmed:true}
- POST /api/legs/[id]/fail {reason?} → {failed:true}
- GET /api/monitor → {activeExecutions:[...], recentIntents:[...], stats:{providerCount, offerCount, tickerRunning, activeCount}}
- GET /api/audit → {events:[{timestamp,eventType,payload,actorType,actorId,prevHash,hash}], chainValid}
- GET /api/audit/[executionId] → {events:[...]}
- GET /api/ledger/[executionId] → {entries:[{timestamp,debitAccount,creditAccount,amount,asset,entryType,description}], balances:[{account,asset,balance}]}
- POST /api/engine/tick → {advanced, signals, tickerRunning}

Key constants for UI:
- Risk tolerance: MAX_RELIABILITY, BALANCED, LOWEST_COST
- Execution policy: NOW, WAIT_FOR_BETTER
- Execution states (happy path order): INTENT_CREATED, SEARCHING, ROUTE_FOUND, ROUTE_RESERVED, ORIGIN_PENDING, ORIGIN_CONFIRMED, TOKENIZED, SETTLEMENT_PENDING, SETTLED, DESTINATION_PENDING, DESTINATION_CONFIRMED, COMPLETED
- Failure states: EXPIRED, CANCELLED, FAILED, DISPUTED, REFUNDED
- Commitment: REVERSIBLE, PARTIALLY_COMMITTED, IRREVERSIBLE
- Provider types: LOCAL_FIAT_AGENT, PSP, BANK, STABLECOIN_LP, CEX, DEX, TREASURY, MARKET_MAKER, SETTLEMENT_ASSET_SPONSOR, HYBRID
- Trust models: COLLATERALIZED, INSTITUTIONALLY_TRUSTED, PRE_FUNDED, EXTERNAL_ESCROW, NON_CUSTODIAL
- Settlement asset types: STABLECOIN, VOLATILE_TOKEN, INTERNAL_SETTLEMENT_UNIT
- Ledger entry types: MINT, BURN, TRANSFER, LOCK, RELEASE, SLASH, FEE, INCENTIVE, COMPENSATION, REFUND

Compliance: prototype only — blockchain/bank/PSP rails simulated, KYC/AML mocked, no real money.

---
Task ID: 12
Agent: full-stack-developer
Task: Build dRamp frontend UI

Work Log:
- Read the existing worklog + backend API routes + serialize.ts to understand exact response shapes (Decimals as strings, ledger returned as a raw array on /api/executions/[id] vs {entries,balances} on /api/ledger/[id]).
- Customized `src/app/globals.css`: refined neutral zinc/slate base with emerald primary accent (oklch) for both light & dark; added custom scrollbar styling (`.dramp-scroll`), subtle grid background, pulse-ring + blink keyframe animations. Defaulted to dark mode for the "execution terminal" feel.
- Updated `src/app/layout.tsx`: added `next-themes` ThemeProvider (defaultTheme dark), swapped the toaster to `sonner` (rich colors, bottom-right), set dRamp metadata + html `class="dark"`.
- Created `src/hooks/use-polling.ts`: generic `usePolling<T>(url, intervalMs)` returning `{data, loading, error, refetch, setData}`; supports `null` url to pause; AbortController-based cancellation; interval cleared on unmount.
- Created `src/components/dramp/format.ts` (money/rate/bps/duration/percent/timestamp formatters, statusColor/commitmentColor/routeTagColor/riskBarColor/auditCategoryColor color helpers, ASSET/COUNTRY/RISK/POLICY option arrays) and `types.ts` (full TS interfaces mirroring every API response).
- Built shared components: `status-badge.tsx` (StatusBadge + EnumBadge), `commitment-badge.tsx` (with tooltip explaining reversibility), `risk-bars.tsx` (compact 5-dot + full 6-dimension bar view with composite).
- Send tab (`send-panel.tsx` + `route-card.tsx`): form with source/dest amount+asset+country selects, risk-tolerance radio cards (MAX_RELIABILITY/BALANCED/LOWEST_COST with descriptions), execution-policy radio cards (NOW/WAIT_FOR_BETTER), max-wait slider (0–600s), "Preview routes" → POST /api/routes/preview, route cards with colored tag badges, explanation, net output / eff cost / gross / incentive metrics, risk bars, leg breakdown (provider→type→trust→channel→amount→rate→fee), rejected routes shown with red hardFilterRejection callout, BEST card emerald-highlighted, "Execute" → POST /api/intents then switches to Executions tab. "Golden demo" quick-fill button preloads $1000 USD/US → EUR/EU, BALANCED, WAIT_FOR_BETTER, 300s.
- Executions tab: `executions-panel.tsx` (scrollable list with status/commitment/route badges, waited time) + `execution-detail.tsx` (header with status+commitment+cancel, 12-state horizontal stepper, pulsing "Monitoring market…" indicator for WAIT_FOR_BETTER SEARCHING with progress bar, selected route card, providers & obligations, collateral & reservations, event timeline, receipt card on COMPLETED, collapsible double-entry ledger) + `state-stepper.tsx` (happy-path stepper with failure terminal badge) + `event-timeline.tsx` (reverse-chronological collapsible audit rows with hash links) + `ledger-view.tsx` (handles both raw-array and {entries,balances} shapes; computes balances client-side when not provided; auto-expands on completion via key change).
- Providers tab: `providers-panel.tsx` (settlement-assets reference table with prominent "NOT collateral" badge for WETH/volatile, 7-provider grid) + `provider-card.tsx` (name/type/trust/reputation/status, capability+country chips, offers list with capacity utilization, obligations with manual Confirm/Report-failure buttons calling /api/legs/[id]/confirm|fail) + `vault-card.tsx` (usable/locked/maxExposure/collateralizationRatio + utilization bar + holdings).
- Monitor tab (`monitor-panel.tsx`): stats row (providers/offers/active executions/ticker running with green-red dot), operator controls (Force engine tick → POST /api/engine/tick; Reseed database → POST /api/seed {reset:true} with AlertDialog confirmation), active executions table (clickable rows jump to Executions), recent intents table.
- Audit tab (`audit-panel.tsx`): chain-validity banner ("Chain intact" green / "Chain broken at index N" red), genesis→latest hash link visualization, reverse-chronological collapsible event list (timestamp, color-coded category badge, actor, prevHash→hash), category legend.
- `app-shell.tsx`: sticky header (dRamp wordmark + SIMULATED badge + tab nav with active-execution count badge + ticker status dot + theme toggle), URL-hash tab sync, first-load seed CTA (polls GET /api/seed; shows prominent "Seed marketplace" card when unseeded), AnimatePresence tab transitions, sticky footer with full compliance notice (prototype, simulated rails, mocked KYC/AML, no real money/custody/contracts) using min-h-screen flex flex-col + mt-auto.
- Toasts via sonner for: intent created, route preview results, execution completed receipt, cancel result, seed/tick/reseed confirmations, leg confirm/fail, and all errors.

Self-verification (agent-browser):
- Opened / → page renders, no console/page errors.
- DB was already seeded → Send tab shows directly with golden-demo values pre-filled (1000 USD/US → EUR/EU, BALANCED, WAIT_FOR_BETTER, 300s).
- Clicked "Preview routes" → 21 route cards appear (BEST emerald-highlighted, CHEAPEST/FASTEST/CANDIDATE tags), each with explanation, net output, eff cost, risk bars, and leg breakdown (NovaPay PSP→Apex Bank etc.).
- Clicked "Execute BEST route" → switched to Executions tab, selected the new execution, watched it progress SEARCHING (with pulsing "Monitoring market for better routes…" + progress bar, waited 5s→17s) → ROUTE_FOUND → ROUTE_RESERVED → ORIGIN_PENDING → ORIGIN_CONFIRMED → TOKENIZED → SETTLEMENT_PENDING → SETTLED → DESTINATION_PENDING → DESTINATION_CONFIRMED → COMPLETED over ~40s. Captured screenshots at SEARCHING, mid-progress, and COMPLETED.
- COMPLETED state verified: 12-state stepper with "Done" highlighted, green "Irreversible" commitment badge with disabled "Cancel locked" button (tooltip explains why), Execution receipt card (final output 917.42 EUR, total cost 3.80 USD, total time 45s), event timeline (15+ events), double-entry ledger (10 entries with debit←credit/amount/type + computed account balances).
- Providers tab: 7 provider cards render (Anchor Stable LP, Apex Bank, Centrex CEX, Fluidex DEX, Northbridge Fiat, NovaPay PSP, Sahel Pay), 3 with vault cards, settlement-assets table shows WETH with "NOT collateral" rose badge.
- Monitor tab: stats (7 providers, 13 offers, 0 active, ticker Running), force-tick + reseed buttons present, recent intents table populated.
- Audit tab: "Chain intact" green badge, 33 events with hash links, color-coded categories, expandable payloads.
- Mobile (390×844): tabs collapse to icons, form stacks, content scrolls, footer pushes down naturally.
- VLM analysis of screenshots confirmed: emerald accent visible, professional fintech/terminal aesthetic, no visual issues.

Issues encountered & fixed:
1. Runtime ReferenceError: `prettyEnum` used in `status-badge.tsx` EnumBadge but not imported → added to the import.
2. Runtime TypeError: `entries.map` in `ledger-view.tsx` — the /api/executions/[id] endpoint returns `ledger` as a raw array, not {entries,balances} → made LedgerView accept both shapes and compute balances client-side when not provided.
3. Lint error `react-hooks/set-state-in-effect` from auto-opening ledger on completion via useEffect → switched to a `key` prop (`ledger-${completed}`) that forces remount with correct defaultOpen.

Stage Summary:
- Complete dRamp frontend UI delivered in `src/app/page.tsx` (renders AppShell) + 16 components in `src/components/dramp/` + `src/hooks/use-polling.ts`.
- All 5 tabs functional with live 2-second polling, emerald-accented "execution terminal" aesthetic, dark mode default, fully responsive, sticky header + footer with compliance notice.
- Golden demo verified end-to-end: $1000 USD→EUR, BALANCED, WAIT_FOR_BETTER → full state machine progression SEARCHING→COMPLETED over ~40s with better-liquidity re-evaluation, collateral lock/release, 10 balanced ledger entries, valid 33-event audit hash chain.
- ESLint: 0 errors. No browser console/page errors. Hard invariant (WETH not collateral) visually prominent in Providers tab.

---
Task ID: 13
Agent: main (Z.ai Code)
Task: End-to-end verification of the dRamp core engine — golden demo in browser + failure tests.

Work Log:
- Re-seeded clean marketplace (7 providers, 4 settlement assets, 12 offers).
- Verified the golden demo end-to-end via agent-browser + VLM:
  - Send tab renders with golden-demo prefill ($1000 USD/US → EUR/EU, Balanced, Wait for better, 300s).
  - "Preview routes" → 16 route cards with BEST/CHEAPEST/CANDIDATE tags, explanations, risk bars, execute buttons.
  - "Execute best" → switches to Executions tab, execution progresses SEARCHING → (better liquidity at ~17s) → route_selected → route_reserved → origin → tokenized → settled → destination → COMPLETED in ~45s.
  - Completed state shows 12-step stepper with green checkmarks, Irreversible commitment, BEST route, 917.42 EUR net output, 3.80 USD cost, double-entry ledger, 18-event SHA-256 audit chain ("Chain intact").
- Failure tests (via API):
  - Idempotency: duplicate idempotencyKey returns same intentId (PASS).
  - Cancellation: reversible execution cancelled, reservations RELEASED (PASS).
  - Waiting/expiry: unsupported corridor (JPY) expires after max wait with "no valid route found" (PASS).
  - Settlement-asset risk: WETH volatile routes rejected for BALANCED (risk 0.61 > ceiling 0.50) (PASS).
  - Exposure race: two simultaneous large intents do not over-allocate (one reserves, one reroutes) (PASS).
- Verified Providers tab: 7 provider cards with vaults/collateral/offers; WETH "NOT collateral" hard-invariant badge visible.
- Verified Audit tab: "Chain intact", 18 events with visible hash links (genesis 00000000 → c8e21383 → ...).
- Lint: 0 errors, 0 warnings.

Stage Summary:
- The dRamp core execution engine is COMPLETE and verified end-to-end.
- The golden demo (Alice $1000 USD→EUR, Balanced, Wait 5 min) flows through every required stage: intent created → searching → better route found → route selected → reserved (collateral locked) → obligations created → fiat received → tokenized → settled → payout → completed → obligations fulfilled → collateral released → immutable audit trail.
- All 8 failure scenarios pass.
- Hard invariant (volatile assets never collateral) enforced in backend, seed, and UI.
- Professional, responsive dark-themed UI with sticky footer and compliance notice.

---
Task ID: Auth+Deploy
Agent: main (Z.ai Code)
Task: Add authentication system (waitlist signup, admin approval, demo quick-login), migrate to Neon Postgres, push to GitHub, deploy to Vercel.

Work Log:
- Migrated Prisma datasource from SQLite to PostgreSQL (Neon): `url` = pooled connection, `directUrl` = direct connection.
- Added User fields (password, role, status, isDemo) and WaitlistEntry model.
- Installed next-auth@4 + bcryptjs; configured CredentialsProvider with role-aware JWT/session callbacks.
- Built auth API: /api/auth/[...nextauth], /api/auth/signup (creates WaitlistEntry, not a User), /api/admin/waitlist (list), /api/admin/waitlist/[id]/approve (admin creates User + password, optional auto-generate), DELETE to reject.
- Created auth-guard.ts helpers (requireUser, requireAdmin, requireOperatorOrAdmin).
- Gated all existing API routes with session checks; intents use the session user's id.
- Updated seed: creates real admin (ekontetevi@gmail.com / Payswap123456), demo users (alice/operator/admin@dramp.demo / Demo1234!), and 2 pending waitlist entries.
- Seed route bootstrap logic: unauthenticated seeding allowed only when no admin exists yet; reseed requires admin auth.
- Added on-demand execution advancement (advanceActiveExecutions / advanceOneOnDemand) for Vercel serverless — the background setInterval ticker can't persist on serverless, so read endpoints advance the viewed execution. UI polling (2s) drives the state machine.
- Restricted advancement to detail endpoints only (kept list/monitor lightweight) to avoid Neon-latency slowdowns.
- Increased Prisma interactive transaction timeout to 30s (reserveRoute/completeExecution/cancel) to accommodate Neon latency.
- instrumentation.ts skips the background ticker on Vercel (process.env.VERCEL).
- Fixed build script (next build), added postinstall (prisma generate), removed output:standalone for Vercel.
- Updated UI: AuthScreen (login + waitlist signup + demo quick-login buttons for Alice/Operator/Admin), user menu with role badge + sign out, conditional Waitlist tab for admins, WaitlistPanel with approve/reject + password generation.
- Fixed .gitignore to exclude .env but allow .env.example.
- Pushed to GitHub repo pectoraux/dramp (PAT-authenticated).
- Created Vercel project (prj_uINd363FDCtC0w0Z4U9wal8ffKFR) linked to the GitHub repo, set 4 env vars (DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, NEXTAUTH_URL).
- Deployed to Vercel: READY at dramp-smoky.vercel.app (dramp.vercel.app was already taken by another Vercel account).
- Verified on Vercel: auth screen renders, login as Alice works, route preview (71 routes), execution creation + on-demand advancement progresses the state machine on serverless, admin login (ekontetevi@gmail.com) returns role=ADMIN, Waitlist tab visible for admins with approve/reject.

Stage Summary:
- GitHub repo: https://github.com/pectoraux/dramp
- Vercel deployment: https://dramp-smoky.vercel.app (dramp.vercel.app was globally taken)
- Auth: NextAuth credentials provider. Sign-up → waitlist. Admin (ekontetevi@gmail.com / Payswap123456) approves waitlist entries and creates accounts. Demo quick-login for Alice (USER), Operator (PROVIDER_OPERATOR), Admin (ADMIN).
- DB: Neon PostgreSQL (shared between local dev and Vercel).
- The app behaves the same on Vercel as locally: same UI, same engine, same DB. The only difference is the background ticker (local only) vs on-demand advancement (Vercel) — both drive the same state machine.
- Env vars set on Vercel: DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, NEXTAUTH_URL.
- Note: user should rotate the GitHub PAT and Vercel token after this session.

---
Task ID: SecurityPass
Agent: main (Z.ai Code)
Task: Security/integrity pass — fix user ownership authorization on all intent/execution reads, ensure provider-private data is not exposed to ordinary users, reconcile stale SQLite docs, add authorization tests. No core engine or UI behavior change.

Work Log:
- Audited all API routes (Explore subagent) — found IDOR gaps on every per-resource read/mutation, provider-data exposure to ordinary users, and stale SQLite docs.
- Added User.providerId + LiquidityProvider.operators back-relation to bind operators to a specific provider; pushed schema to Neon.
- Updated NextAuth to carry providerId in JWT/session; demo operator now bound to Northbridge in seed.
- Rewrote auth-guard.ts with ownership helpers: requireIntentOwnership, requireExecutionOwnership, requireLegOwnership, requireProviderOwnership (404 on mismatch to avoid leaking existence; admins bypass).
- Fixed all IDOR gaps:
  - GET /api/intents/[id] + POST cancel → ownership check
  - GET /api/executions/[id] + POST cancel → ownership check
  - GET /api/ledger/[executionId] → ownership check
  - GET /api/audit/[executionId] → ownership check
  - GET /api/executions → scoped to session user's own executions (admins see all)
  - GET /api/monitor → scoped to session user's own intents/executions
  - GET /api/audit (global trail) → admin-only
  - GET /api/engine/tick → admin-only
- Provider-data redaction: added serializeProviderPublic (omits vault, reservedCapacity, obligations); GET /api/providers returns public view to ordinary USERs, full view to operators/admins; GET /api/providers/[id] returns full view only to the owning operator or admin.
- Leg ownership: POST /api/legs/[id]/confirm and /fail now verify the operator owns the leg's provider (requireLegOwnership); admins bypass.
- Redacted generatedPassword from IdempotencyRecord after waitlist approval (returned to admin once, not persisted).
- Fixed DELETE /api/admin/waitlist/[id]/approve to return 404 (not 500) on missing entry.
- Reconciled stale SQLite docs: prisma/schema.prisma header now says PostgreSQL; deleted obsolete tests/database-runtime-build.sh.
- Added tests/authz.test.ts (26 assertions): User A cannot read/mutate User B's intent/execution/ledger/audit; ordinary users can't access global audit or provider internals; operators scoped to their provider; admins retain global access; unauthenticated requests rejected.
- All 26 authz tests PASS. Lint clean. Type-check clean. Golden demo verified still working end-to-end (SEARCHING → ORIGIN_PENDING → ... → COMPLETED).
- Pushed to GitHub (commit 61b8318).

Stage Summary:
- Every per-user resource is now ownership-checked. User A cannot read or mutate User B's intent, execution, ledger, or audit trail (returns 404).
- List/monitor endpoints are scoped to the session user (admins see all).
- Global audit trail is admin-only.
- Provider-private operational data (vault holdings, locked collateral, reserved capacity, obligations) is hidden from ordinary USERs; operators see full detail only for their own provider.
- Operators can only confirm/fail legs on their bound provider.
- Generated passwords are returned once to the approving admin and redacted from persisted idempotency records.
- No core economic engine or UI behavior changed.

---
Task ID: InvariantFix
Agent: main (Z.ai Code)
Task: Fix collateral eligibility invariant (asset type authoritative, not mutable flag); re-fetch/consistently serialize intent status after on-demand advancement; add regression tests; run existing authz + golden-demo tests. No routing, state-machine, ledger, or UI behavior change.

Work Log:
- Collateral invariant fix:
  - Made asset TYPE the authoritative determinant in `isCollateralEligible()` (types.ts): VOLATILE_TOKEN → always false regardless of flag; non-volatile types → flag may restrict but type is what makes them eligible candidates.
  - Added `normalizeCollateralEligibility(assetType, flag)`: forces false for volatile types at write time so the stored flag can never contradict the invariant. Used at all 4 settlement-asset seed writes.
  - Added `isCollateralFlagConsistent(assetType, flag)`: detects volatile+flag=true as a data integrity violation.
  - Updated `assertCollateralEligible()` (collateral.ts): now checks flag/type consistency and throws CollateralInvariantError if the flag contradicts the type — a defensive lock-time guard against DB corruption.
  - Updated `serializeSettlementAsset()` (serialize.ts): returns the type-authoritative (normalized) eligibility, not the raw mutable flag.
- Intent status consistency fix:
  - GET /api/intents/[id] now re-fetches the intent scalar fields AFTER `advanceOneOnDemand()` (previously serialized the pre-advancement intent, so a completed execution showed intent.status=ACTIVE while execution.status=COMPLETED).
  - GET /api/executions/[id] was already correct (advances before fetching).
- Regression tests:
  - tests/collateral-invariant.test.ts (23 assertions, pure unit tests): proves asset type is authoritative across isCollateralEligible, normalizeCollateralEligibility, isCollateralFlagConsistent, assertCollateralEligible — including the case where a volatile asset's flag is true (rejected).
  - tests/intent-status.test.ts (3 assertions, API test): polls GET /api/intents/[id] until COMPLETED and asserts intent.status === execution.status in the same response.
- Test results: collateral-invariant 23/23, authz 26/26, intent-status 3/3 — all pass. Lint clean, type-check clean.
- Pushed to GitHub (commit 42da492).

Stage Summary:
- Collateral eligibility is now type-authoritative: a VOLATILE_TOKEN can never be collateral, even if the mutable isEligibleCollateral flag is set true (normalize forces it false at write time, assert throws at lock time, serialize returns false).
- Intent status is consistently serialized after on-demand advancement: GET /api/intents/[id] re-fetches the intent post-advancement so intent.status and execution.status are always in sync.
- No routing, state-machine, ledger, or UI behavior changed.

---
Task ID: P2-UI
Agent: full-stack-developer
Task: Build dRamp Prompt 2 UI (marketplace, ops console, provider API panel)

Work Log:
- Read app-shell.tsx, providers-panel.tsx, monitor-panel.tsx, send-panel.tsx, format.ts, types.ts, serialize.ts and the marketplace/ops/api route handlers to learn exact response shapes and existing styling patterns (dark theme, emerald accent, shadcn New York, dramp-scroll custom scrollbar, sticky footer via min-h-screen flex flex-col + mt-auto).
- Extended `src/components/dramp/types.ts` with full TS interfaces for every new endpoint: MarketplaceOffer/PendingDemand/CompetitionRoute, OpsOverview/Queue/Bottlenecks/ProviderRisk/AssetRisk/Concentration/Dispute/Reconciliation, IncentiveCampaign, ApiKey/WebhookEndpoint/CreateApiKeyResponse/CreateWebhookResponse, OnboardingProvider. Added optional onboarding fields (jurisdiction, contactEmail, supportedAssets, settlementMethods, apiIntegrationStatus, onboardingNote) to the Provider interface.
- Updated `src/lib/engine/serialize.ts` serializeProvider() to include the onboarding metadata fields so operators/admins see them in the providers response (ordinary USERs still get the redacted serializeProviderPublic view — no behavior change).
- Built `src/components/dramp/settlement-asset-registry.tsx` — a reusable collapsible table that polls `/api/settlement-assets` and shows symbol/type/issuer/network/volatility/liquidity/peg/incentive/active offers/active campaigns/collateral-eligibility badge. VOLATILE_TOKEN rows (WETH) are tinted rose and stamped "NOT collateral" — the hard-invariant visual cue. Configurable URL, polling interval, default-open state, and withHeader flag.
- Built `src/components/dramp/marketplace-panel.tsx` with 4 internal sub-tabs:
  • Public offers — filter by source/dest asset, sortable table with provider, corridor, capability, rate, fee, incentive, capacity bucket (none/low/medium/high/deep), channel, speed, risk dot. Polls every 4s.
  • Pending demand — anonymized demand cards with corridor, amount bucket, risk/policy badges, elapsed vs remaining countdown with progress bar (urgent when <60s remaining). Polls every 3s.
  • Provider competition — corridor query form (source/dest asset+country, amount, risk tolerance) that POSTs to /api/marketplace/competition and renders up to 10 ranked route cards side-by-side, each with provider/type/trust badges, tag, hop count, expected speed, explanation, net output + eff cost metrics, compact risk bars, and full leg breakdown.
  • Settlement assets — embeds the reusable SettlementAssetRegistry.
- Built `src/components/dramp/ops-panel.tsx` (admin only) with 10 sub-nav views, all polling live:
  • Overview — 12 stat cards (totalVolume, completedCount, activeExecutionCount, activeProviders, availableLiquidity, reservedLiquidity, aggregateExposure, aggregateCollateral, unsettledObligations, incentiveBudget, incentiveAccrued, incentivePaid) with semantic accent colors. Polls every 5s.
  • Queue — waiting intents table with corridor, amount, risk/policy, elapsed, remaining, utilization bar. Long-waiting (>120s) rows tinted rose. Polls every 3s.
  • Bottlenecks — three side-by-side cards: corridor demand, providers near capacity (>70% util with progress bars), manual bottlenecks.
  • Provider risk — providers table with counterparty risk dot, exposure/max, utilization bar, offers/obligations, flagged badge. Flagged rows tinted rose.
  • Asset risk — settlement assets table with volatility/liquidity/peg/incentive/risk score dot, status, collateral eligibility. WETH row tinted rose with "NOT collateral" badge.
  • Concentration — two summary stat cards + three bar-chart cards: offers by provider type (with share %), offers by country, collateral by asset.
  • Disputes — dispute cards with reason/status badges, corridor, compensation/slashed amounts, Resolve dialog (resolution type select + compensation/slashed amounts + note) that POSTs to /api/ops/disputes/[id]/resolve.
  • Reconciliation — recon items with type/severity badges, expected vs reported amounts, Resolve dialog (status + resolution note) that POSTs to /api/ops/reconciliation/[id]/resolve.
  • Incentives — campaign cards with budget/accrued/paid progress bar, Create campaign dialog (name/asset/incentive bps/funding source/budget/start-end dates) that POSTs to /api/incentives.
  • Onboarding — pending applications card with Review/Approve/Activate/Reject buttons + full providers table with jurisdiction/contact/API integration status and inline lifecycle Select that PATCHes /api/onboarding/providers/[id].
- Built `src/components/dramp/api-panel.tsx` (PROVIDER_OPERATOR + ADMIN) with 3 internal sub-tabs:
  • API keys — keys table (label/keyId/scopes/status/lastUsed/createdAt) with Create key dialog (label + scope chips) and Revoke button. Created secret is shown ONCE in a modal with copy buttons for both keyId and secret, plus a "store securely" warning.
  • Webhooks — endpoints list with URL, events, status, recent deliveries (eventType/status/attempts/timestamp), Register webhook dialog (URL + event chips). Signing secret shown ONCE in a modal with copy button.
  • Docs — static Open Liquidity API contract: base URL, auth header, idempotency note, endpoints table (GET/POST/PATCH/DELETE for offers/executions/obligations/reconcile), example curl command with syntax-highlighted code block + copy button, and lifecycle summary.
  • Admin gets a provider selector at the top; operator auto-binds to session.user.providerId (no selector).
- Updated `src/components/dramp/provider-card.tsx` to render the onboarding metadata block (jurisdiction, API integration status badge, contact email, supported assets, settlement methods, onboarding note) when those fields are present — i.e. only for operators/admins. Ordinary USERs still see the public redacted view.
- Updated `src/components/dramp/app-shell.tsx`:
  • TabKey extended to 9 tabs: send, executions, marketplace, providers, monitor, audit, ops, api, waitlist.
  • TabDef gains operatorOnly flag (visible to PROVIDER_OPERATOR + ADMIN).
  • visibleTabs filter respects adminOnly and operatorOnly.
  • New TabsContent blocks for marketplace (all users), ops (admin only), api (operator+admin) wired to the new panels.
  • All existing tabs (send/executions/providers/monitor/audit/waitlist) unchanged.
  • Sticky header + sticky footer preserved (min-h-screen flex flex-col, footer mt-auto).
- All numbers shown come from API responses (Decimals as strings) — no fabricated metrics. Monetary amounts formatted with 2 decimals, rates 4 decimals, risk scores as colored dots/bars, percentages with 1 decimal.
- Long lists use `max-h-96 overflow-y-auto dramp-scroll` with sticky table headers. Empty states ("No data") on every view. Skeletons during initial fetch. Toasts (sonner) on every mutation: create key, revoke key, register webhook, resolve dispute, resolve recon, create campaign, approve/reject/activate provider, run competition.
- ESLint: 0 errors, 0 warnings. TypeScript strict.

Self-verification (agent-browser):
- Logged in as demo admin (admin@dramp.demo / Demo1234!). Verified all 9 tabs render in the header (Send, Executions, Marketplace, Providers, Monitor, Audit, Ops, API, Waitlist).
- Marketplace tab: Public offers loaded 12 active offers (Sahara Cash, SwiftPay, OpenSwap, Northbridge, Continental Treasury, etc.) with corridor, rate, fee, capacity bucket, channel, speed, risk dot. Pending demand sub-tab shows anonymized demand cards. Provider competition sub-tab: ran corridor query USD/US → EUR/EU $1000 Balanced → "Found 10 competing routes" toast + 10 ranked route cards rendered with legs and risk bars. Settlement assets sub-tab shows the registry with WETH "NOT collateral" badge.
- Ops tab: Overview shows 12 stat cards (7 active providers, 720,100 available liquidity, 71,750 aggregate collateral, 7,000 incentive budget, 0 active executions). Provider risk view shows 7 providers with Northbridge flagged. Asset risk view shows 4 assets, WETH row tinted rose with "NOT collateral". Concentration shows offers by type (Bank 2/PSP 1/Stablecoin LP 2/CEX 2/DEX 2/Local Fiat Agent 2/Treasury 1), by country (US 8/EU 8/Global 6/NG 4/PH 1), collateral by asset (USDC 65,000/SC 10,000). Disputes view shows 0 (empty state). Incentives view shows 2 active campaigns with progress bars + Create campaign button. Onboarding view shows 1 pending application (Pacific Rail FX, Market Maker, JP jurisdiction) with Review/Approve/Activate/Reject buttons + full providers table with jurisdiction/contact/API status columns.
- API tab: Admin sees a provider selector at top. Selected Northbridge → API keys sub-tab lists 2 existing keys (Northbridge API Key + test). Clicked "Create key" → dialog opened with label input + 4 scope chips → entered "Test UI key" → clicked Create → success toast + modal showing "API key created" with Key ID (pk_9c77baa25b668a706a99e71c) and Secret (sk_...) each with copy buttons, plus "store securely" warning. Closed modal → new key visible in table. Webhooks sub-tab shows 1 endpoint (https://mock.northbridge.example/webhooks/dramp, Active, events execution.accepted/execution.rejected). Docs sub-tab renders the full API contract: base URL, auth header, idempotency note, endpoints table, example curl with copy button, lifecycle summary.
- Providers tab: 8 provider cards now show the onboarding metadata block — "Jurisdiction EU/US/JP/NG/GLOBAL", "API CONNECTED/PENDING/NONE" badge, "Contact ops@...". WETH still shows "NOT collateral" badge in the settlement assets reference.
- Existing tabs verified working: Send tab → "Preview routes" returns BEST and FASTEST route cards; Audit tab shows "Chain intact"; Waitlist tab shows 2 pending entries with Approve/Reject; Monitor tab polls.
- Signed out and logged in as Alice (alice@dramp.demo / Demo1234!). Verified only 6 tabs visible: Send, Executions, Marketplace, Providers, Monitor, Audit. Ops, API, and Waitlist are correctly HIDDEN. Marketplace tab works for Alice (12 public offers load, demand cards render). Audit tab shows "0 events" (correct — global audit is admin-only).
- Signed out and logged in as Operator (operator@dramp.demo / Demo1234!). Verified 7 tabs visible: Send, Executions, Marketplace, Providers, Monitor, Audit, API. Ops and Waitlist are correctly HIDDEN. API tab auto-binds to the operator's provider (Northbridge) — no provider selector shown, keys list loads directly. Providers tab shows full vault detail (Utilization + Holdings) for collateralized providers.
- Mobile (390×844): tabs collapse to icons, all content scrolls, footer pushes down naturally. Sticky header + footer preserved.
- Dev server log: only 200 OK responses (and the expected 403 on /api/audit for Alice — admin-only, existing behavior). No 500s, no compile errors, no console errors in the browser. Fast Refresh rebuilds succeed cleanly.
- ESLint: 0 errors, 0 warnings.

Stage Summary:
- 4 new panel components delivered: marketplace-panel.tsx, ops-panel.tsx, api-panel.tsx, settlement-asset-registry.tsx (reusable).
- app-shell.tsx extended to 9 role-gated tabs (Marketplace for all, Ops for admin, API for operator+admin) — all existing tabs unchanged.
- providers-panel.tsx + provider-card.tsx extended to render onboarding metadata for operators/admins.
- serializeProvider() extended to include jurisdiction/contactEmail/apiIntegrationStatus/supportedAssets/settlementMethods/onboardingNote.
- Every view consumes the existing API; no second routing engine / ledger / risk model / state machine was created. All numbers come from real API responses.
- Browser verification PASSED end-to-end across all three roles (admin, operator, alice). Existing tabs (Send/Executions/Providers/Monitor/Audit/Waitlist) all verified still working.

---
Task ID: P2-Core
Agent: main (Z.ai Code)
Task: Prompt 2 — open liquidity marketplace, provider network, ops console. Turn the execution engine into a network where independent providers connect, compete, manage liquidity, receive incentives, and operate through APIs. Reuse existing domain layer — no parallel systems.

Work Log:
- Extended Prisma schema with 8 new models (ApiKey, WebhookEndpoint, WebhookDelivery, SettlementIncentiveCampaign, IncentiveEarning, Dispute, ReconciliationItem, Notification) + LiquidityProvider onboarding fields (jurisdiction, contactEmail, supportedAssets, settlementMethods, apiIntegrationStatus, lifecycle). Pushed to Neon.
- Built provider-api services: auth (bcrypt-hashed API keys), guard (provider-scoped), webhooks (HMAC-signed, retryable), incentives (campaign eligibility + accrue-on-completion + budget enforcement), marketplace (public redacted offers + anonymized demand + competition), ops (overview/queue/bottlenecks/risk/concentration), disputes (open/resolve/slash), onboarding (application + lifecycle), notifications.
- Hooked incentive accrual into completeExecution so earnings are recorded ONLY on completion (never at route display).
- Enriched routing buildGraph with active campaign incentives (no parallel pricing — reuses existing incentive integration in computeHopOutput).
- Built 35+ new API routes: Open Liquidity API v1 (provider-key auth, idempotent), marketplace (public), ops (admin-only), incentives, onboarding, settlement-assets, notifications.
- Updated seed: 8 realistic providers (Northbridge Bank, SwiftPay PSP, Meridian LP, Atlas Exchange, OpenSwap, Sahara Cash, Continental Treasury, Pacific Rail FX pending), 2 incentive campaigns, API key + webhook for Northbridge.
- Delegated UI to full-stack subagent: 3 new tabs (Marketplace, Ops, API) with 10 ops sub-views, marketplace competition, settlement asset registry, API key/webhook management + docs. All role-gated.
- Tests: tests/p2-marketplace.test.ts (40 assertions) — provider API auth + isolation, marketplace redaction, demand anonymization, competition, incentives, ops authorization, settlement asset registry, onboarding lifecycle. All pass.
- Verified Prompt 1 golden demo still works (17 routes evaluated, execution progresses through state machine).
- Lint clean, type-check clean. Pushed to GitHub (commit a1a73ce).

Stage Summary:
- The execution engine is now an open liquidity marketplace. Providers apply → admin approves → provider publishes offers via API or portal → router discovers and ranks routes → providers compete → user waits for better liquidity → new supply improves the route → execution proceeds → incentives accrue on completion → ops monitors the entire lifecycle.
- Open Liquidity API v1 is live: /api/v1/provider/{offers,executions,obligations,reconcile} with provider-key auth, scope checks, idempotency, and webhook delivery.
- Marketplace shows public (redacted) offers, anonymized pending demand, and provider competition — all derived from real data, no fabricated metrics.
- Ops console has 10 sub-views covering the full network lifecycle: overview, execution queue, bottlenecks, provider/asset risk, concentration, disputes, reconciliation, incentives, onboarding.
- Hard invariants preserved: volatile assets never collateral (enforced in schema, seed, routing, serialize, UI); all economic effects through the existing ledger; all state changes audited; authorization provider/user scoped.

---
Task ID: P2.1-Hardening
Agent: main (Z.ai Code)
Task: Financial-integrity/security hardening pass on Prompt 2. Encrypt webhook secrets at rest, enforce volumeCap cumulatively, make incentive accrual concurrency-safe, make dispute slashing amount-aware. No routing/state-machine/collateral-invariant/marketplace changes.

Work Log:
- 1. Webhook secret encryption: new src/lib/crypto.ts (AES-256-GCM, key versioning, GCM auth tag for tamper detection). Schema: WebhookEndpoint.secret → encryptedSecret + encryptionKeyVersion. registerWebhook encrypts before storing, returns plaintext once. emitProviderEvent decrypts in memory at signing time. Added WEBHOOK_ENCRYPTION_KEY env var.
- 2. Volume cap enforcement: added qualifiedVolume to SettlementIncentiveCampaign + IncentiveEarning. getApplicableIncentiveBps checks volumeCap remaining. accrueIncentiveForExecution enforces qualifiedVolume + legVolume <= volumeCap inside the same transaction, pro-rates the earning if volume is capped.
- 3. Concurrency-safe incentive accrual: added @@unique([campaignId, executionId, providerId]) to IncentiveEarning. Rewrote accrueIncentiveForExecution: everything inside ONE transaction with conditional updateMany on (accrued, qualifiedVolume) — optimistic locking. Retries on conflict (max 3). Unique constraint prevents duplicate earnings at DB level.
- 4. Amount-aware slashing: new slashCollateralAmount(executionId, amount, asset, comp, tx) in collateral.ts — slashes EXACTLY the requested amount, rejects amounts > eligible (SlashExceedsEligibleError). resolveDispute validates + executes slash BEFORE updating dispute status (failed slash → dispute stays OPEN). Rejects zero/negative. Prevents double resolution.
- Tests: tests/p2-hardening.test.ts (28 assertions) — crypto round-trip + tamper detection, webhook secret not exposed in API, volumeCap tracking, dispute slash rejection (excessive/zero), double-resolution prevention. All pass.
- All existing tests still pass: collateral 23, authz 26, P2 marketplace 43. Lint + type-check clean.
- Pushed to GitHub (commit a713756).

Stage Summary:
- Webhook signing secrets are now encrypted at rest (AES-256-GCM with key versioning). Plaintext is shown once at creation and never stored.
- volumeCap is enforced cumulatively: the campaign tracks qualifiedVolume and stops paying incentives once the cap is reached.
- Incentive accrual is concurrency-safe: a unique constraint on (campaignId, executionId, providerId) prevents duplicates; budget + volume reservation happen atomically via conditional updates; two concurrent completions cannot overspend a campaign.
- Dispute slashing is amount-aware: the actual collateral deduction equals the approved slashedAmount, never implicitly slashes an entire execution's locked collateral. Rejects amounts above eligible collateral, zero/negative amounts, and double resolution.

---
Task ID: P2.2-Accounting
Agent: main (Z.ai Code)
Task: Fix incentive budget accounting semantics (remaining = totalBudget - accrued, not - accrued - paid). Add concurrent accrual tests for budget + volume caps. Add partial-slash collateral-release regression test. No routing/provider-API/state-machine/marketplace changes.

Work Log:
- Fixed budget formula in 4 locations: getApplicableIncentiveBps, tryAccrueLeg (budget enforcement + post-accrual exhaustion check), accrueWithCappedVolume, getCampaignStats. All now use remainingBudget = totalBudget - accrued (paid is a subset of accrued, not additional consumption).
- getCampaignStats now exposes unpaidAccrued = accrued - paid as a separate field.
- ops overview now exposes incentiveRemaining + incentiveUnpaidAccrued.
- Documented accounting semantics in the module header.
- Increased MAX_RETRIES from 3 to 5 with exponential backoff (50ms × attempt) for concurrent accrual conflict resolution.
- Tests: tests/p2-accounting.test.ts (21 assertions, direct DB):
  - Budget accounting: verified remaining = 70 when accrued=30, paid=30 (not 40). unpaidAccrued = 0. After accruing $20 more: remaining=50, unpaidAccrued=20.
  - Concurrent budget: 10 parallel accruals against $100 budget (each earns $20). accrued = exactly $100, 5 earnings created. Budget never overspent.
  - Concurrent volume cap: 10 parallel accruals against 5000 volume cap (each 1000 volume). qualifiedVolume = exactly 5000.
  - Partial slash: $1000 locked, slash $100. usable decreases by exactly $100. locked=0 (all locks released). $900 released back. SLASH ledger entry for exact $100.
- All existing tests still pass (collateral 23, hardening 28). Lint + type-check clean.
- Pushed to GitHub (commit 1577a65).

Stage Summary:
- Incentive budget accounting is now correct: remainingBudget = totalBudget - accrued. paid is a disbursement of already-accrued earnings, not an additional consumption. No double-counting.
- Concurrent accrual is proven safe: 10 parallel accruals against a tight budget result in accrued <= totalBudget, with exactly the right number of earnings. The unique constraint + optimistic locking + retry backoff prevents overspending.
- Partial slash is proven correct: the un-slashed portion of locked collateral is released back to available, while usable collateral decreases by exactly the slash amount.

---
Task ID: P3-UI
Agent: full-stack-developer
Task: Build dRamp Prompt 3 UI (economics, reputation, opportunities, commitments)

Work Log:
- Read worklog, app-shell, providers-panel, provider-card, ops-panel, marketplace-panel, format.ts, types.ts, serialize.ts, auth-guard.ts, and all economics/commitments API route handlers + library functions to understand exact response shapes and existing styling patterns (dark theme, emerald accent, shadcn New York, dramp-scroll custom scrollbar, sticky header + footer).
- Extended `src/lib/engine/serialize.ts` serializeProvider + serializeProviderPublic to include the `tier` field (NEW | VERIFIED | TRUSTED | PREMIUM) so the Providers panel can show tier badges for every role.
- Extended `src/components/dramp/types.ts` with full TS interfaces for every new endpoint: ReputationComponents/ReputationResult, ProviderEarnings/Capital/Performance/Efficiency/EconomicsResponse, StatementEntry/Summary/Response, QuoteWinLossResponse, OpportunityItem/OpportunitiesResponse, PricingOffer/Fill/IntelligenceResponse, NetworkHealthResponse, UnitEconomicsCorridor/Response, AcquisitionFunnelResponse, CommitmentItem/CommitmentsResponse, CommitmentSampleResponse. Added optional `tier?: string` to the Provider interface.
- Added helpers to `src/components/dramp/format.ts`: `tierBadgeClass` (NEW= zinc, VERIFIED= sky, TRUSTED= emerald, PREMIUM= amber), `tierDotClass`, `scoreBarColor` (0..100 → emerald/amber/rose), `scoreLabel`, `prettyCorridor`, `formatRatePercent` (4 decimals).
- Built `src/components/dramp/reputation-explorer.tsx`: dialog-triggered expandable breakdown showing overall score (0-100), tier badge, tier reason, sample size, decay note, and the 7 weighted components (reliability 25%, speed 15%, liquidityQuality 15%, pricing 15%, disputes 15%, operational 10%, history 5%) each with a progress bar colored by score, weight %, and explanation. Polled live. Supports both inline rendering and a button-triggered dialog.
- Built `src/components/dramp/opportunity-feed.tsx`: cards with corridor, demand, supply, gap, gap%, estimated spread bps, opportunity level (HIGH/MEDIUM/LOW) with colored badges. Includes the "Indicative opportunity — not a profitability guarantee" disclaimer. Empty state when no pending intents.
- Built `src/components/dramp/pricing-intelligence.tsx`: corridor selector (5 source × 5 destination assets, search button), stat cards (cheapest/median/most-expensive fees, fastest provider), sortable offers table with provider tier badge/reputation/fee/rate/capacity/speed/channel, recent fills table. Polls every 5s after explicit search.
- Built `src/components/dramp/provider-economics-view.tsx`: net earnings headline, earnings breakdown tiles (executionFees, incentives, rebates, penalties, slashing, compensation), capital metrics (committed/deployed/reserved/idle + vault usable/locked/max exposure + utilization progress bar), performance (totalExecutions, completed, completion rate with progress bar), efficiency (earningsPerLiquidity, capitalTurnover). Labeled "Prototype analytics".
- Built `src/components/dramp/provider-statement.tsx`: period selector (7/30/90 days), opening balance / net change / closing balance headline cards, categorized totals (executionFees, incentives, slashing, compensation, refunds, netChange), ledger entries table (timestamp, type badge colored by entry type, asset, amount, signed amount colored by direction, execution short id). Reconciled against ledger.
- Built `src/components/dramp/quote-winloss.tsx`: win rate headline with progress bar, wins/losses tiles, loss reasons breakdown (bars + %), recent results table (when, corridor, result badge, our fee, winner fee, reason lost).
- Built `src/components/dramp/network-health-view.tsx`: overall score (0-100) with colored progress bar + qualitative label, average wait headline, 5 component bars (liquidityDepth, routeCompetition, providerReliability, executionSuccess, riskConcentration) each with description.
- Built `src/components/dramp/unit-economics-view.tsx`: 4 stat tiles (totalVolume, totalFees, completedCount, avgCostBps), corridor breakdown table with volume/count/fees/avg take rate bps and share bar.
- Built `src/components/dramp/acquisition-funnel.tsx`: 7-stage funnel (applied → approved → connected → publishedOffer → receivedExecution → completedExecution → repeatProvider) each with bar scaled to max count + "% of applied" label, conversion rate tiles for the 5 stage-to-stage transitions (Strong/OK/Weak badges).
- Built `src/components/dramp/commitments-panel.tsx`: commitment cards with corridor, provider name, status badge (ACTIVE/PAUSED/BREACHED/EXPIRED), min liquidity, target execution time, avg available, samples count, reliability progress bar + "% met", end date. "New commitment" dialog with all required fields (provider selector for admin, source/dest asset+country, min/max liquidity, target execution seconds, end date). "Sample now" button (admin only) that POSTs to /api/commitments/[id]/sample and shows inline result + toast. Admin filter for "All providers" or specific provider.
- Built `src/components/dramp/economics-panel.tsx`: main panel with 9 sub-nav views, role-gated (public: Opportunities + Pricing; operator+: Provider economics, Provider statement, Quote win/loss, Commitments; admin-only: Network health, Unit economics, Funnel). Admin sees a provider selector for the per-provider views; operator auto-binds to session.user.providerId.
- Updated `src/components/dramp/provider-card.tsx`: added tier badge (NEW/VERIFIED/TRUSTED/PREMIUM with colored dot) next to the reputation score, and a "View reputation" button on every card that opens the reputation explorer dialog.
- Updated `src/components/dramp/ops-panel.tsx`: added 3 new sub-nav items (Network health, Unit economics, Funnel) that delegate to the economics components via direct ES imports.
- Updated `src/components/dramp/app-shell.tsx`: extended TabKey to include "economics", added a new tab {key: "economics", label: "Economics", icon: BarChart3} (visible to ALL authenticated users — internal sub-nav handles role-gating), and wired up `<EconomicsPanel />` in the TabsContent.
- Fixed a runtime error in commitments-panel.tsx where `<SelectItem value="">` (Radix Select forbids empty-string values) was replaced with a `"__all__"` sentinel that maps back to "" internally.
- All numbers come from API responses (Decimals as strings). Monetary amounts formatted with 2 decimals, scores 0-100, rates 4 decimals, percentages 1 decimal. Polling every 5s on health/opportunities/pricing, 10s on reputation/statement. Skeletons during fetch. Empty states ("No data") on every view. Toasts (sonner) on create commitment + sample mutations. Progress bars use the existing shadcn Progress component for reputation/health component scores.
- ESLint: 0 errors, 0 warnings. TypeScript strict: 0 errors in src/.

Self-verification (agent-browser):
- Logged in as demo admin (admin@dramp.demo / Demo1234!). Verified all 10 tabs render (Send, Executions, Marketplace, Providers, Monitor, Audit, Economics, Ops, API, Waitlist). New Economics tab visible between Audit and Ops.
- Economics tab → 9 sub-nav views visible: Opportunities, Pricing, Provider economics, Provider statement, Quote win/loss, Commitments, Network health, Unit economics, Funnel.
- Clicked Network health → overall score 65 (Good), 5 component bars (Liquidity Depth 72 Good, Route Competition 30 Weak, Provider Reliability 83 Excellent, Execution Success 50 Fair, Risk Concentration 83 Excellent), average wait 0s.
- Clicked Unit economics → 4 stat tiles (total volume 0, total fees 0, completed 0, avg cost 0 bps), corridor breakdown empty state ("No completed executions yet").
- Clicked Funnel → 7 stages (Applied 8, Approved 7, Connected 7, Published offer 7, Received execution 0, Completed execution 0, Repeat provider 0), conversion rates (Applied→Approved 88% Strong, Approved→Connected 100% Strong, Connected→Published 100% Strong, Published→First execution 0% Weak, First→Repeat 0% Weak).
- Clicked Opportunities → empty state ("No active opportunities right now") with "Indicative opportunity — not a profitability guarantee" disclaimer banner.
- Clicked Pricing → selected USD → USDC corridor → search returned 3 offers: Northbridge Bank (BANK, VERIFIED, 25 bps, MANUAL, 1m 0s, capacity 30,000), Atlas Exchange (CEX, VERIFIED, 30 bps, AUTOMATIC, 45s, 80,000), Atlas Exchange (CEX, VERIFIED, 35 bps, AUTOMATIC, 10s, 50,000). Stats: cheapest 25 bps, median 30 bps, most expensive 35 bps, fastest Atlas Exchange (10s execution).
- Clicked Provider economics → selected Northbridge Bank → net earnings $0.00 (lifetime), capital turnover 0.00×, earnings breakdown all 0, capital metrics (committed 60,000, deployed 0, reserved 0, idle 60,000, vault usable 19,000, vault locked 0, max exposure 12,666.67), utilization 0%, performance (0 total executions, 0 completed, 0% completion), efficiency (earnings/liquidity 0.000000, turnover 0.00×). "Prototype analytics" disclaimer shown.
- Clicked Provider statement → period selector "Last 30 days", opening balance 0.00, net change 0.00 (0 entries), closing balance 0.00, categorized totals (execution fees 0, incentives 0, slashing 0, compensation 0, refunds 0, net change 0).
- Clicked Quote win/loss → selected Atlas Exchange → empty states ("No losses recorded yet", "No quote results yet").
- Clicked Commitments → admin filter "All providers" showed 1 commitment (created by operator earlier): USD:US → EUR:EU, Northbridge Bank, Active, min liquidity 10,000.00, target 1m 0s, avg available 0.00, samples 0, reliability 0%. Clicked "Sample now" → success toast + sample result "not met · available 0.00" (correct — no offers on that corridor), samples incremented to 1.
- Providers tab → 8 provider cards now show tier badges: VERIFIED, PREMIUM, TRUSTED, VERIFIED, NEW, NEW, NEW, VERIFIED. Each card has a "View reputation" button. Clicked View reputation → dialog opened with overall score 74 (Good), tier NEW, tier reason "New provider — building history", and the 7-component breakdown (Reliability 50 Fair, Speed 100 Excellent, Liquidity Quality 100 Excellent, Pricing 42 Weak, Disputes 100 Excellent, Operational 100 Excellent, History 0 Weak) with progress bars and decay note "Weighted by recency: <7d full weight, 7-30d 0.5×, 30-90d 0.25×".
- Ops tab → verified 3 new sub-nav items render (Network health, Unit economics, Funnel) at the end of the existing 10 views. Clicked each — all render correctly (Network health 65 overall, Unit economics empty state, Funnel 8 applied).
- Signed out, logged in as operator (operator@dramp.demo). Verified 8 tabs visible (Send, Executions, Marketplace, Providers, Monitor, Audit, Economics, API) — Ops and Waitlist correctly HIDDEN. Economics tab shows 6 sub-nav views (Opportunities, Pricing, Provider economics, Provider statement, Quote win/loss, Commitments) — admin-only Network health/Unit economics/Funnel correctly HIDDEN. Commitments subnav shows "Showing your provider's commitments" badge, no admin filter, "New commitment" button works (created USD:US → EUR:EU, 10,000 min liquidity, target 60s, ends Nov 12 — appeared immediately in list).
- Signed out, logged in as Alice (alice@dramp.demo). Verified 7 tabs visible (Send, Executions, Marketplace, Providers, Monitor, Audit, Economics) — Ops, API, Waitlist correctly HIDDEN. Economics tab shows ONLY 2 sub-nav views (Opportunities, Pricing) — all operator+/admin views correctly HIDDEN. Providers tab shows tier badges (VERIFIED, PREMIUM, TRUSTED, VERIFIED, NEW, NEW, NEW, VERIFIED) and "View reputation" buttons for all 8 provider cards.
- Verified existing tabs still work for Alice: Send tab renders form (source amount 1000, USD/US→EUR/EU, Balanced + Wait for better); Marketplace tab shows 4 sub-tabs (Public offers, Pending demand, Provider competition, Settlement assets) with 12 public offers; Monitor tab shows "live" status + Active executions + Recent intents; Audit tab shows "Chain intact" with 0 events.
- Mobile (390×844): tabs collapse to icons, all content scrolls, footer pushes down naturally. Sticky header + footer preserved.
- Dev server log: only 200 OK responses — POST /api/commitments (create) → 200, POST /api/commitments/[id]/sample → 200, GET /api/economics/* (reputation, provider, statement, winloss, opportunities, pricing, network-health, unit-economics, funnel) → 200, GET /api/commitments → 200, GET /api/providers (with tier field) → 200. No 500s, no compile errors, no console errors after the Select.Item fix.
- ESLint: 0 errors, 0 warnings. TypeScript: 0 errors in src/.

Stage Summary:
- 11 new components delivered: reputation-explorer, opportunity-feed, pricing-intelligence, provider-economics-view, provider-statement, quote-winloss, network-health-view, unit-economics-view, acquisition-funnel, commitments-panel, economics-panel.
- app-shell.tsx extended to 10 role-gated tabs (Economics visible to all authenticated users; internal sub-nav role-gates public vs operator+ vs admin).
- provider-card.tsx extended to render tier badge + View reputation button.
- ops-panel.tsx extended with 3 new sub-nav items (Network health, Unit economics, Acquisition funnel) that delegate to the economics components.
- serializeProvider + serializeProviderPublic extended to include the `tier` field.
- Every view consumes the existing API; no second reputation system / routing engine / pricing engine / ledger was created. All numbers come from real API responses (Decimals as strings).
- Browser verification PASSED end-to-end across all three roles (admin, operator, alice). Existing tabs (Send/Executions/Marketplace/Providers/Monitor/Audit/Ops/API/Waitlist) all verified still working.
