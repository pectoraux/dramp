"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Textarea,
} from "@/components/ui/textarea";
import { usePolling } from "@/hooks/use-polling";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  formatMoney,
  formatDuration,
  formatTimestamp,
  formatPercent,
  prettyEnum,
  riskBarColor,
  shortId,
  toNum,
} from "./format";
import type {
  OpsOverview,
  OpsQueueResponse,
  OpsQueueItem,
  OpsBottlenecks,
  OpsProviderRiskResponse,
  OpsProviderRisk,
  OpsAssetRiskResponse,
  OpsAssetRisk,
  OpsConcentration,
  OpsDisputesResponse,
  OpsDispute,
  OpsReconciliationResponse,
  OpsReconciliationItem,
  IncentivesResponse,
  IncentiveCampaign,
  OnboardingProvider,
  OnboardingProvidersResponse,
} from "./types";
import {
  Activity,
  Gauge,
  ListChecks,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  Coins,
  Scale,
  Gavel,
  FileCheck2,
  Gift,
  UserCheck,
  Loader2,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  Flag,
  Layers,
  TrendingUp,
  Building2,
} from "lucide-react";

type OpsView =
  | "overview"
  | "queue"
  | "bottlenecks"
  | "provider-risk"
  | "asset-risk"
  | "concentration"
  | "disputes"
  | "reconciliation"
  | "incentives"
  | "onboarding";

const VIEWS: { key: OpsView; label: string; icon: React.ReactNode }[] = [
  { key: "overview", label: "Overview", icon: <Gauge className="size-3.5" /> },
  { key: "queue", label: "Queue", icon: <ListChecks className="size-3.5" /> },
  { key: "bottlenecks", label: "Bottlenecks", icon: <AlertTriangle className="size-3.5" /> },
  { key: "provider-risk", label: "Provider risk", icon: <ShieldAlert className="size-3.5" /> },
  { key: "asset-risk", label: "Asset risk", icon: <Coins className="size-3.5" /> },
  { key: "concentration", label: "Concentration", icon: <Scale className="size-3.5" /> },
  { key: "disputes", label: "Disputes", icon: <Gavel className="size-3.5" /> },
  { key: "reconciliation", label: "Reconciliation", icon: <FileCheck2 className="size-3.5" /> },
  { key: "incentives", label: "Incentives", icon: <Gift className="size-3.5" /> },
  { key: "onboarding", label: "Onboarding", icon: <UserCheck className="size-3.5" /> },
];

export function OpsPanel() {
  const [view, setView] = useState<OpsView>("overview");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Activity className="size-5 text-emerald-500" /> Network Operations
        </h2>
        <p className="text-xs text-muted-foreground">
          Real-time view of executions, risk, disputes, reconciliation, incentives, and provider onboarding.
        </p>
      </div>

      {/* Sub-nav */}
      <div className="flex overflow-x-auto dramp-scroll gap-1 border-b pb-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap",
              view === v.key
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {v.icon}
            {v.label}
          </button>
        ))}
      </div>

      {view === "overview" && <OverviewView />}
      {view === "queue" && <QueueView />}
      {view === "bottlenecks" && <BottlenecksView />}
      {view === "provider-risk" && <ProviderRiskView />}
      {view === "asset-risk" && <AssetRiskView />}
      {view === "concentration" && <ConcentrationView />}
      {view === "disputes" && <DisputesView />}
      {view === "reconciliation" && <ReconciliationView />}
      {view === "incentives" && <IncentivesView />}
      {view === "onboarding" && <OnboardingView />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function OverviewView() {
  const { data, loading } = usePolling<OpsOverview>("/api/ops/overview", 5000);
  if (loading && !data) {
    return <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>;
  }
  if (!data) return null;
  const cards: { label: string; value: string; icon: React.ReactNode; accent?: "emerald" | "rose" | "amber" | "sky" }[] = [
    { label: "Total volume", value: formatMoney(data.totalVolume), icon: <TrendingUp className="size-4 text-emerald-500" />, accent: "emerald" },
    { label: "Completed", value: String(data.completedCount), icon: <CheckCircle2 className="size-4 text-emerald-500" /> },
    { label: "Active executions", value: String(data.activeExecutionCount), icon: <Activity className="size-4 text-sky-500" />, accent: "sky" },
    { label: "Active providers", value: String(data.activeProviders), icon: <Building2 className="size-4 text-emerald-500" /> },
    { label: "Available liquidity", value: formatMoney(data.availableLiquidity), icon: <Coins className="size-4 text-emerald-500" /> },
    { label: "Reserved liquidity", value: formatMoney(data.reservedLiquidity), icon: <Coins className="size-4 text-amber-500" />, accent: "amber" },
    { label: "Aggregate exposure", value: formatMoney(data.aggregateExposure), icon: <ShieldAlert className="size-4 text-amber-500" />, accent: "amber" },
    { label: "Aggregate collateral", value: formatMoney(data.aggregateCollateral), icon: <ShieldCheck className="size-4 text-emerald-500" /> },
    { label: "Unsettled obligations", value: formatMoney(data.unsettledObligations), icon: <Clock className="size-4 text-amber-500" />, accent: "amber" },
    { label: "Incentive budget", value: formatMoney(data.incentiveBudget), icon: <Gift className="size-4 text-emerald-500" /> },
    { label: "Incentive accrued", value: formatMoney(data.incentiveAccrued), icon: <Gift className="size-4 text-sky-500" /> },
    { label: "Incentive paid", value: formatMoney(data.incentivePaid), icon: <Gift className="size-4 text-emerald-500" /> },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {cards.map((c) => (
        <Card key={c.label} className="py-3">
          <CardContent className="py-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {c.icon}
              {c.label}
            </div>
            <div className={cn(
              "text-xl font-mono tabular-nums mt-1 font-semibold",
              c.accent === "emerald" && "text-emerald-600 dark:text-emerald-400",
              c.accent === "rose" && "text-rose-600 dark:text-rose-400",
              c.accent === "amber" && "text-amber-600 dark:text-amber-400",
              c.accent === "sky" && "text-sky-600 dark:text-sky-400",
            )}>
              {c.value}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution queue
// ---------------------------------------------------------------------------
function QueueView() {
  const { data, loading } = usePolling<OpsQueueResponse>("/api/ops/queue", 3000);
  const queue = data?.queue ?? [];
  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ListChecks className="size-4 text-emerald-500" /> Waiting intents
          <Badge variant="outline" className="text-[10px] py-0 h-4">{queue.length}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">SEARCHING executions waiting for liquidity.</CardDescription>
      </CardHeader>
      <CardContent className="px-2">
        {loading && queue.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : queue.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No waiting intents.</div>
        ) : (
          <div className="dramp-scroll overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                <tr>
                  <th className="text-left font-medium px-2 py-1.5">Execution</th>
                  <th className="text-left font-medium px-2 py-1.5">Corridor</th>
                  <th className="text-right font-medium px-2 py-1.5">Amount</th>
                  <th className="text-left font-medium px-2 py-1.5">Risk</th>
                  <th className="text-left font-medium px-2 py-1.5">Policy</th>
                  <th className="text-right font-medium px-2 py-1.5">Elapsed</th>
                  <th className="text-right font-medium px-2 py-1.5">Remaining</th>
                  <th className="text-left font-medium px-2 py-1.5">Wait</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => <QueueRow key={q.executionId} item={q} />)}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QueueRow({ item }: { item: OpsQueueItem }) {
  const longWait = item.elapsedSeconds > 120;
  const pct = Math.max(0, Math.min(100, (item.elapsedSeconds / Math.max(1, item.elapsedSeconds + item.remainingWaitSeconds)) * 100));
  return (
    <tr className={cn("border-b last:border-0 hover:bg-muted/30", longWait && "bg-rose-500/5")}>
      <td className="px-2 py-1.5 font-mono text-[10px]">{shortId(item.executionId, 10)}</td>
      <td className="px-2 py-1.5 font-mono text-[10px]">
        {item.sourceAsset}:{item.sourceCountry} <ArrowRight className="inline size-2.5 mx-0.5 text-muted-foreground" /> {item.destinationAsset}:{item.destinationCountry}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(item.amount)} {item.sourceAsset}</td>
      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(item.riskTolerance)}</Badge></td>
      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(item.executionPolicy)}</Badge></td>
      <td className={cn("px-2 py-1.5 text-right font-mono tabular-nums", longWait && "text-rose-600 dark:text-rose-400 font-medium")}>
        {formatDuration(item.elapsedSeconds)}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatDuration(item.remainingWaitSeconds)}</td>
      <td className="px-2 py-1.5 w-24">
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div className={cn("h-full rounded-full", longWait ? "bg-rose-500" : "bg-amber-500")} style={{ width: `${pct}%` }} />
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Bottlenecks
// ---------------------------------------------------------------------------
function BottlenecksView() {
  const { data, loading } = usePolling<OpsBottlenecks>("/api/ops/bottlenecks", 5000);
  if (loading && !data) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" /> Corridor demand
            <Badge variant="outline" className="text-[10px] py-0 h-4">{data.corridorDemand.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2 space-y-2 max-h-96 overflow-y-auto dramp-scroll">
          {data.corridorDemand.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No corridor demand bottlenecks.</div>
          ) : data.corridorDemand.map((c, i) => (
            <div key={i} className="rounded-md border bg-muted/30 p-2 text-xs">
              <div className="font-mono text-[10px]">{c.corridor}</div>
              <div className="flex items-center justify-between mt-1 text-[10px] text-muted-foreground">
                <span>{c.count} intent{c.count === 1 ? "" : "s"}</span>
                <span className="font-mono">{formatMoney(c.totalAmount)}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert className="size-4 text-rose-500" /> Providers near capacity
            <Badge variant="outline" className="text-[10px] py-0 h-4">{data.providersNearCapacity.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">{"Reserved / available > 70%"}</CardDescription>
        </CardHeader>
        <CardContent className="pt-2 space-y-2 max-h-96 overflow-y-auto dramp-scroll">
          {data.providersNearCapacity.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">All providers within safe capacity.</div>
          ) : data.providersNearCapacity.map((p, i) => (
            <div key={i} className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.providerName}</span>
                <Badge variant="outline" className={cn("text-[10px] py-0 h-4", p.utilization > 90 ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300")}>
                  {p.utilization}%
                </Badge>
              </div>
              <div className="text-[10px] text-muted-foreground">{prettyEnum(p.providerType)} · {p.corridor}</div>
              <div className="text-[10px] text-muted-foreground font-mono">reserved {formatMoney(p.reserved)} / {formatMoney(p.available)}</div>
              <Progress value={p.utilization} className="h-1" />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="size-4 text-amber-500" /> Manual bottlenecks
            <Badge variant="outline" className="text-[10px] py-0 h-4">{data.manualBottlenecks.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">Offers on MANUAL channels.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2 space-y-2 max-h-96 overflow-y-auto dramp-scroll">
          {data.manualBottlenecks.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No manual bottlenecks.</div>
          ) : data.manualBottlenecks.map((b, i) => (
            <div key={i} className="rounded-md border bg-muted/30 p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium">{b.providerName}</span>
                <Badge variant="outline" className="text-[10px] py-0 h-4 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300">
                  {formatDuration(b.expectedExecutionSeconds)}
                </Badge>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{b.corridor}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider risk
// ---------------------------------------------------------------------------
function ProviderRiskView() {
  const { data, loading } = usePolling<OpsProviderRiskResponse>("/api/ops/provider-risk", 5000);
  const providers = data?.providers ?? [];
  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldAlert className="size-4 text-emerald-500" /> Provider counterparty risk
          <Badge variant="outline" className="text-[10px] py-0 h-4">{providers.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {loading && providers.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : providers.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No providers.</div>
        ) : (
          <div className="dramp-scroll overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                <tr>
                  <th className="text-left font-medium px-2 py-1.5">Provider</th>
                  <th className="text-left font-medium px-2 py-1.5">Type</th>
                  <th className="text-left font-medium px-2 py-1.5">Status</th>
                  <th className="text-right font-medium px-2 py-1.5">Reputation</th>
                  <th className="text-center font-medium px-2 py-1.5">Cpty risk</th>
                  <th className="text-right font-medium px-2 py-1.5">Exposure</th>
                  <th className="text-right font-medium px-2 py-1.5">Max</th>
                  <th className="text-left font-medium px-2 py-1.5">Utilization</th>
                  <th className="text-right font-medium px-2 py-1.5">Offers</th>
                  <th className="text-right font-medium px-2 py-1.5">Oblig.</th>
                  <th className="text-center font-medium px-2 py-1.5">Flag</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => <ProviderRiskRow key={p.id} p={p} />)}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProviderRiskRow({ p }: { p: OpsProviderRisk }) {
  const risk = toNum(p.counterpartyRisk);
  return (
    <tr className={cn("border-b last:border-0 hover:bg-muted/30", p.flagged && "bg-rose-500/5")}>
      <td className="px-2 py-1.5 font-medium">{p.name}</td>
      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(p.providerType)}</Badge></td>
      <td className="px-2 py-1.5">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", p.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>
          {prettyEnum(p.status)}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{(p.reputationScore * 100).toFixed(0)}%</td>
      <td className="px-2 py-1.5 text-center">
        <span className={cn("inline-block size-2.5 rounded-full", riskBarColor(risk))} title={`Risk ${(risk * 100).toFixed(0)}%`} />
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(p.exposure)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{formatMoney(p.maxExposure)}</td>
      <td className="px-2 py-1.5 w-32">
        <div className="flex items-center gap-1.5">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden flex-1">
            <div className={cn("h-full rounded-full", p.utilization > 80 ? "bg-rose-500" : p.utilization > 50 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${Math.min(100, p.utilization)}%` }} />
          </div>
          <span className="text-[10px] font-mono tabular-nums w-8 text-right">{p.utilization}%</span>
        </div>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{p.activeOffers}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{p.activeObligations}</td>
      <td className="px-2 py-1.5 text-center">
        {p.flagged ? (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-300"><Flag className="size-2.5" />Flagged</Badge>
        ) : (
          <span className="text-muted-foreground text-[10px]">—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Asset risk
// ---------------------------------------------------------------------------
function AssetRiskView() {
  const { data, loading } = usePolling<OpsAssetRiskResponse>("/api/ops/asset-risk", 5000);
  const assets = data?.assets ?? [];
  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Coins className="size-4 text-emerald-500" /> Settlement asset risk
          <Badge variant="outline" className="text-[10px] py-0 h-4">{assets.length}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          Hard invariant: <span className="font-medium text-rose-600 dark:text-rose-400">VOLATILE_TOKEN assets are never collateral-eligible</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2">
        {loading && assets.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : assets.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No settlement assets.</div>
        ) : (
          <div className="dramp-scroll overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                <tr>
                  <th className="text-left font-medium px-2 py-1.5">Symbol</th>
                  <th className="text-left font-medium px-2 py-1.5">Type</th>
                  <th className="text-right font-medium px-2 py-1.5">Volatility</th>
                  <th className="text-right font-medium px-2 py-1.5">Liquidity</th>
                  <th className="text-right font-medium px-2 py-1.5">Peg</th>
                  <th className="text-right font-medium px-2 py-1.5">Incent.</th>
                  <th className="text-center font-medium px-2 py-1.5">Risk score</th>
                  <th className="text-left font-medium px-2 py-1.5">Status</th>
                  <th className="text-center font-medium px-2 py-1.5">Collateral</th>
                  <th className="text-right font-medium px-2 py-1.5">Offers</th>
                  <th className="text-right font-medium px-2 py-1.5">Providers</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => <AssetRiskRow key={a.id} a={a} />)}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssetRiskRow({ a }: { a: OpsAssetRisk }) {
  const volatile = a.assetType === "VOLATILE_TOKEN";
  const risk = toNum(a.riskScore);
  return (
    <tr className={cn("border-b last:border-0 hover:bg-muted/30", volatile && "bg-rose-500/5")}>
      <td className="px-2 py-1.5 font-mono font-medium">{a.symbol}</td>
      <td className="px-2 py-1.5">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", volatile ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
          {prettyEnum(a.assetType)}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(a.volatilityScore)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(a.liquidityScore)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(a.pegQuality)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{a.incentiveRate ? `${a.incentiveRate} bps` : "—"}</td>
      <td className="px-2 py-1.5 text-center">
        <span className={cn("inline-block size-2.5 rounded-full", riskBarColor(risk))} title={`Risk ${(risk * 100).toFixed(0)}%`} />
      </td>
      <td className="px-2 py-1.5">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", a.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>
          {prettyEnum(a.status)}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-center">
        {a.isEligibleCollateral && !volatile ? (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">Eligible</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-300 font-medium">
            <ShieldAlert className="size-2.5" /> NOT collateral
          </Badge>
        )}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{a.dependentOfferCount}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{a.providerCount}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------
function ConcentrationView() {
  const { data, loading } = usePolling<OpsConcentration>("/api/ops/concentration", 6000);
  if (loading && !data) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;
  const maxType = Math.max(1, ...data.offersByProviderType.map((d) => d.count ?? 0));
  const maxCountry = Math.max(1, ...data.offersByCountry.map((d) => d.count ?? 0));
  const maxCollateral = Math.max(1, ...data.collateralByAsset.map((d) => toNum(d.amount)));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Card className="py-3">
          <CardContent className="py-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Building2 className="size-4 text-emerald-500" /> Active providers</div>
            <div className="text-xl font-mono tabular-nums mt-1 font-semibold">{data.totalActiveProviders}</div>
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardContent className="py-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Layers className="size-4 text-emerald-500" /> Active offers</div>
            <div className="text-xl font-mono tabular-nums mt-1 font-semibold">{data.totalActiveOffers}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ConcentrationCard title="Offers by provider type" items={data.offersByProviderType.map((d) => ({ label: prettyEnum(d.type ?? ""), value: d.count ?? 0, share: d.share }))} max={maxType} accent="emerald" />
        <ConcentrationCard title="Offers by country" items={data.offersByCountry.map((d) => ({ label: d.country ?? "", value: d.count ?? 0 }))} max={maxCountry} accent="sky" />
        <ConcentrationCard title="Collateral by asset" items={data.collateralByAsset.map((d) => ({ label: d.asset ?? "", value: toNum(d.amount), display: formatMoney(d.amount) }))} max={maxCollateral} accent="amber" />
      </div>
    </div>
  );
}

function ConcentrationCard({
  title,
  items,
  max,
  accent,
}: {
  title: string;
  items: { label: string; value: number; share?: number; display?: string }[];
  max: number;
  accent: "emerald" | "sky" | "amber";
}) {
  const barColor = accent === "emerald" ? "bg-emerald-500" : accent === "sky" ? "bg-sky-500" : "bg-amber-500";
  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="size-4 text-emerald-500" /> {title}
          <Badge variant="outline" className="text-[10px] py-0 h-4">{items.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2 space-y-2 max-h-80 overflow-y-auto dramp-scroll">
        {items.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">No data.</div>
        ) : items.map((it, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono">{it.label}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {it.display ?? it.value}{typeof it.share === "number" ? ` · ${it.share}%` : ""}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div className={cn("h-full rounded-full", barColor)} style={{ width: `${Math.max(2, (it.value / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------
const DISPUTE_RESOLUTIONS = [
  { v: "RESOLVED_PROVIDER", label: "Resolved — provider" },
  { v: "RESOLVED_USER", label: "Resolved — user" },
  { v: "PARTIAL_COMPENSATION", label: "Partial compensation" },
  { v: "SLASHED", label: "Slashed collateral" },
  { v: "CLOSED", label: "Closed" },
];

function DisputesView() {
  const { data, loading, refetch } = usePolling<OpsDisputesResponse>("/api/ops/disputes", 6000);
  const disputes = data?.disputes ?? [];
  const [resolving, setResolving] = useState<string | null>(null);

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Gavel className="size-4 text-emerald-500" /> Disputes
          <Badge variant="outline" className="text-[10px] py-0 h-4">{disputes.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2 space-y-2 max-h-[70vh] overflow-y-auto dramp-scroll">
        {loading && disputes.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : disputes.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No disputes on record.</div>
        ) : disputes.map((d) => (
          <DisputeRow key={d.id} d={d} resolving={resolving === d.id} onResolving={setResolving} onResolved={() => refetch()} />
        ))}
      </CardContent>
    </Card>
  );
}

function DisputeRow({
  d,
  resolving,
  onResolving,
  onResolved,
}: {
  d: OpsDispute;
  resolving: boolean;
  onResolving: (id: string | null) => void;
  onResolved: () => void;
}) {
  const [resolution, setResolution] = useState<string>("RESOLVED_PROVIDER");
  const [compensationAmount, setCompensationAmount] = useState("");
  const [slashedAmount, setSlashedAmount] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  const isResolved = d.status === "RESOLVED" || !!d.resolution;

  async function submit() {
    onResolving(d.id);
    try {
      const body: any = { resolution };
      if (compensationAmount) body.compensationAmount = Number(compensationAmount);
      if (slashedAmount) body.slashedAmount = Number(slashedAmount);
      if (note) body.note = note;
      const res = await fetch(`/api/ops/disputes/${d.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Dispute resolved", { description: `${d.providerName} · ${resolution}` });
      setOpen(false);
      onResolved();
    } catch (err) {
      toast.error("Resolve failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      onResolving(null);
    }
  }

  return (
    <div className={cn("rounded-md border bg-card p-3 space-y-2", isResolved && "opacity-70")}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm">{d.providerName}</span>
            <Badge variant="outline" className="text-[10px] py-0 h-4 border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300">{prettyEnum(d.reason)}</Badge>
            <Badge variant="outline" className={cn("text-[10px] py-0 h-4", isResolved ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300")}>
              {prettyEnum(d.status)}
            </Badge>
          </div>
          <div className="text-[10px] text-muted-foreground">
            <span className="font-mono">{d.corridor}</span> · exec <span className="font-mono">{shortId(d.executionId, 8)}</span> · {formatTimestamp(d.createdAt)}
          </div>
          {d.description && <div className="text-xs text-muted-foreground italic mt-1">"{d.description}"</div>}
          {(d.compensationAmount || d.slashedAmount) && (
            <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2">
              {d.compensationAmount && <span>compensation: <span className="font-mono text-foreground">{formatMoney(d.compensationAmount)}</span></span>}
              {d.slashedAmount && <span>slashed: <span className="font-mono text-rose-600 dark:text-rose-400">{formatMoney(d.slashedAmount)}</span></span>}
            </div>
          )}
        </div>
        {!isResolved && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Resolve</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Resolve dispute — {d.providerName}</DialogTitle>
                <DialogDescription>Choose a resolution. Amounts are optional and depend on the resolution type.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="space-y-1">
                  <Label className="text-xs">Resolution</Label>
                  <Select value={resolution} onValueChange={setResolution}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DISPUTE_RESOLUTIONS.map((r) => <SelectItem key={r.v} value={r.v}>{r.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Compensation amount</Label>
                    <Input type="number" min="0" step="any" value={compensationAmount} onChange={(e) => setCompensationAmount(e.target.value)} placeholder="0" className="font-mono" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Slashed amount</Label>
                    <Input type="number" min="0" step="any" value={slashedAmount} onChange={(e) => setSlashedAmount(e.target.value)} placeholder="0" className="font-mono" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Note (optional)</Label>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Resolution context…" rows={2} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={submit} disabled={resolving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  {resolving ? <><Loader2 className="size-4 animate-spin" /> Resolving…</> : <><Gavel className="size-4" /> Resolve</>}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
const RECONCILE_STATUSES = ["RESOLVED", "FALSE_POSITIVE", "ESCALATED"];

function ReconciliationView() {
  const { data, loading, refetch } = usePolling<OpsReconciliationResponse>("/api/ops/reconciliation", 6000);
  const items = data?.items ?? [];
  const [resolving, setResolving] = useState<string | null>(null);

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileCheck2 className="size-4 text-emerald-500" /> Reconciliation queue
          <Badge variant="outline" className="text-[10px] py-0 h-4">{items.length}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">Discrepancies between expected and reported obligation amounts.</CardDescription>
      </CardHeader>
      <CardContent className="pt-2 space-y-2 max-h-[70vh] overflow-y-auto dramp-scroll">
        {loading && items.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : items.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No reconciliation items.</div>
        ) : items.map((it) => (
          <ReconRow key={it.id} item={it} resolving={resolving === it.id} onResolving={setResolving} onResolved={() => refetch()} />
        ))}
      </CardContent>
    </Card>
  );
}

function ReconRow({
  item,
  resolving,
  onResolving,
  onResolved,
}: {
  item: OpsReconciliationItem;
  resolving: boolean;
  onResolving: (id: string | null) => void;
  onResolved: () => void;
}) {
  const [status, setStatus] = useState("RESOLVED");
  const [resolution, setResolution] = useState("");
  const [open, setOpen] = useState(false);
  const isResolved = item.status === "RESOLVED" || item.status === "FALSE_POSITIVE";

  async function submit() {
    onResolving(item.id);
    try {
      const res = await fetch(`/api/ops/reconciliation/${item.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, resolution }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Reconciliation item resolved", { description: `${shortId(item.id, 8)} · ${status}` });
      setOpen(false);
      onResolved();
    } catch (err) {
      toast.error("Resolve failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      onResolving(null);
    }
  }

  const sev = item.severity;
  return (
    <div className={cn("rounded-md border bg-card p-3 space-y-1", isResolved && "opacity-70")}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className={cn("text-[10px] py-0 h-4", sev === "CRITICAL" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : sev === "HIGH" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>
              {prettyEnum(item.type)} · {prettyEnum(item.severity)}
            </Badge>
            <Badge variant="outline" className={cn("text-[10px] py-0 h-4", isResolved ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300")}>
              {prettyEnum(item.status)}
            </Badge>
            <span className="text-[10px] text-muted-foreground font-mono">{shortId(item.id, 8)}</span>
          </div>
          {item.description && <div className="text-xs text-foreground/80 mt-0.5">{item.description}</div>}
          <div className="text-[10px] text-muted-foreground mt-0.5">
            provider <span className="font-mono">{shortId(item.providerId, 8)}</span>
            {item.executionId && <> · exec <span className="font-mono">{shortId(item.executionId, 8)}</span></>}
            {item.asset && <> · <span className="font-mono">{item.asset}</span></>}
            {item.expectedAmount && <> · expected <span className="font-mono">{formatMoney(item.expectedAmount)}</span></>}
            {item.reportedAmount && <> · reported <span className="font-mono">{formatMoney(item.reportedAmount)}</span></>}
          </div>
        </div>
        {!isResolved && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Resolve</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Resolve reconciliation item</DialogTitle>
                <DialogDescription>Mark this discrepancy as resolved or escalate.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="space-y-1">
                  <Label className="text-xs">New status</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RECONCILE_STATUSES.map((s) => <SelectItem key={s} value={s}>{prettyEnum(s)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Resolution note</Label>
                  <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="How was this resolved?" rows={3} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={submit} disabled={resolving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  {resolving ? <><Loader2 className="size-4 animate-spin" /> Resolving…</> : <><FileCheck2 className="size-4" /> Resolve</>}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incentives
// ---------------------------------------------------------------------------
function IncentivesView() {
  const { data, loading, refetch } = usePolling<IncentivesResponse>("/api/incentives", 6000);
  const campaigns = data?.campaigns ?? [];
  const [creating, setCreating] = useState(false);

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Gift className="size-4 text-emerald-500" /> Settlement incentive campaigns
            <Badge variant="outline" className="text-[10px] py-0 h-4">{campaigns.length}</Badge>
          </CardTitle>
          <CreateCampaignDialog onCreated={() => refetch()} triggerCreating={setCreating} />
        </div>
      </CardHeader>
      <CardContent className="pt-2 space-y-2 max-h-[70vh] overflow-y-auto dramp-scroll">
        {loading && campaigns.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : campaigns.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No incentive campaigns yet.</div>
        ) : campaigns.map((c) => <CampaignRow key={c.id} c={c} />)}
        {creating && <div className="text-[10px] text-muted-foreground">Creating…</div>}
      </CardContent>
    </Card>
  );
}

function CampaignRow({ c }: { c: IncentiveCampaign }) {
  const used = toNum(c.accrued) + toNum(c.paid);
  const pct = toNum(c.totalBudget) > 0 ? Math.min(100, (used / toNum(c.totalBudget)) * 100) : 0;
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm">{c.name}</span>
            <Badge variant="outline" className="text-[10px] py-0 h-4">{c.settlementAsset}</Badge>
            <Badge variant="outline" className={cn("text-[10px] py-0 h-4", c.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>
              {prettyEnum(c.status)}
            </Badge>
            <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">{c.incentiveBps} bps</Badge>
          </div>
          <div className="text-[10px] text-muted-foreground">
            {prettyEnum(c.fundingSource)}{c.sponsor ? ` · ${c.sponsor}` : ""} · {formatTimestamp(c.startDate)} → {formatTimestamp(c.endDate)}
          </div>
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono tabular-nums">
          <span>accrued {formatMoney(c.accrued)}</span>
          <span>paid {formatMoney(c.paid)}</span>
          <span>budget {formatMoney(c.totalBudget)}</span>
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>
    </div>
  );
}

function CreateCampaignDialog({ onCreated, triggerCreating }: { onCreated: () => void; triggerCreating: (b: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [settlementAssetId, setSettlementAssetId] = useState("");
  const [incentiveBps, setIncentiveBps] = useState("25");
  const [fundingSource, setFundingSource] = useState("dramp");
  const [totalBudget, setTotalBudget] = useState("10000");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [saving, setSaving] = useState(false);

  const [assets, setAssets] = useState<{ id: string; symbol: string }[]>([]);
  // load assets on open
  async function loadAssets() {
    try {
      const res = await fetch("/api/settlement-assets");
      const json = await res.json();
      setAssets((json.assets ?? []).map((a: any) => ({ id: a.id, symbol: a.symbol })));
      if (json.assets?.[0]?.id) setSettlementAssetId(json.assets[0].id);
    } catch { /* ignore */ }
  }

  async function submit() {
    if (!name || !settlementAssetId || !totalBudget) {
      toast.error("Fill in name, asset and budget");
      return;
    }
    setSaving(true);
    triggerCreating(true);
    try {
      const res = await fetch("/api/incentives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          settlementAssetId,
          incentiveBps: Number(incentiveBps),
          fundingSource,
          startDate,
          endDate,
          totalBudget: Number(totalBudget),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Campaign created", { description: shortId(json.id, 8) });
      setOpen(false);
      setName(""); setTotalBudget("10000"); setIncentiveBps("25");
      onCreated();
    } catch (err) {
      toast.error("Create failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setSaving(false);
      triggerCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) loadAssets(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Gift className="size-3.5" /> Create campaign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create incentive campaign</DialogTitle>
          <DialogDescription>Subsidize a settlement asset to attract liquidity.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="USDC corridor subsidy" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Settlement asset</Label>
              <Select value={settlementAssetId} onValueChange={setSettlementAssetId}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select asset" /></SelectTrigger>
                <SelectContent>
                  {assets.map((a) => <SelectItem key={a.id} value={a.id}>{a.symbol}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Incentive (bps)</Label>
              <Input type="number" min="0" value={incentiveBps} onChange={(e) => setIncentiveBps(e.target.value)} className="font-mono" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Funding source</Label>
              <Input value={fundingSource} onChange={(e) => setFundingSource(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Total budget</Label>
              <Input type="number" min="0" value={totalBudget} onChange={(e) => setTotalBudget(e.target.value)} className="font-mono" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">End date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving ? <><Loader2 className="size-4 animate-spin" /> Creating…</> : <><Gift className="size-4" /> Create</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
const ONBOARDING_STATUSES = ["APPLIED", "REVIEW", "APPROVED", "ACTIVE", "SUSPENDED", "REJECTED"];

function OnboardingView() {
  const { data, loading, refetch } = usePolling<OnboardingProvidersResponse>("/api/providers", 6000);
  const providers = (data?.providers ?? []) as unknown as OnboardingProvider[];
  const pending = providers.filter((p) => p.status === "APPLIED" || p.status === "REVIEW");
  const all = providers;
  const [updating, setUpdating] = useState<string | null>(null);

  async function update(id: string, status: string) {
    setUpdating(id);
    try {
      const res = await fetch(`/api/onboarding/providers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success(`Provider ${status.toLowerCase()}`, { description: shortId(id, 8) });
      refetch();
    } catch (err) {
      toast.error("Update failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setUpdating(null);
    }
  }

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <Card className="py-3 border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <UserCheck className="size-4 text-amber-500" /> Pending applications
              <Badge variant="outline" className="text-[10px] py-0 h-4 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300">{pending.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2 space-y-2">
            {pending.map((p) => (
              <OnboardingRow key={p.id} p={p} updating={updating === p.id} onApprove={() => update(p.id, "APPROVED")} onReject={() => update(p.id, "REJECTED")} onReview={() => update(p.id, "REVIEW")} onActivate={() => update(p.id, "ACTIVE")} />
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Building2 className="size-4 text-emerald-500" /> All providers
            <Badge variant="outline" className="text-[10px] py-0 h-4">{all.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2">
          {loading && all.length === 0 ? (
            <Skeleton className="h-32 w-full" />
          ) : all.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-8">No providers.</div>
          ) : (
            <div className="dramp-scroll overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Name</th>
                    <th className="text-left font-medium px-2 py-1.5">Type</th>
                    <th className="text-left font-medium px-2 py-1.5">Trust</th>
                    <th className="text-left font-medium px-2 py-1.5">Jurisdiction</th>
                    <th className="text-left font-medium px-2 py-1.5">Contact</th>
                    <th className="text-center font-medium px-2 py-1.5">API</th>
                    <th className="text-left font-medium px-2 py-1.5">Status</th>
                    <th className="text-right font-medium px-2 py-1.5">Lifecycle</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((p) => <OnboardingTableRow key={p.id} p={p} updating={updating === p.id} onUpdate={(s) => update(p.id, s)} />)}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OnboardingRow({
  p,
  updating,
  onApprove,
  onReject,
  onReview,
  onActivate,
}: {
  p: OnboardingProvider;
  updating: boolean;
  onApprove: () => void;
  onReject: () => void;
  onReview: () => void;
  onActivate: () => void;
}) {
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm">{p.name}</span>
            <Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(p.providerType)}</Badge>
            <Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(p.trustModel)}</Badge>
            <Badge variant="outline" className={cn("text-[10px] py-0 h-4", p.status === "APPLIED" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300")}>
              {prettyEnum(p.status)}
            </Badge>
          </div>
          <div className="text-[10px] text-muted-foreground">
            {p.jurisdiction && <>jurisdiction <span className="font-mono">{p.jurisdiction}</span> · </>}
            {p.contactEmail && <>contact <span className="font-mono">{p.contactEmail}</span></>}
          </div>
          {p.onboardingNote && <div className="text-xs text-muted-foreground italic mt-1">"{p.onboardingNote}"</div>}
        </div>
        <div className="flex items-center gap-1.5">
          {p.status === "APPLIED" && (
            <Button size="sm" variant="outline" onClick={onReview} disabled={updating}>
              {updating ? <Loader2 className="size-3 animate-spin" /> : <UserCheck className="size-3.5" />} Review
            </Button>
          )}
          <Button size="sm" onClick={onApprove} disabled={updating} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8">
            {updating ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Approve
          </Button>
          <Button size="sm" variant="outline" onClick={onActivate} disabled={updating} className="h-8">
            Activate
          </Button>
          <Button size="sm" variant="outline" onClick={onReject} disabled={updating} className="text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 h-8">
            <XCircle className="size-3.5" /> Reject
          </Button>
        </div>
      </div>
    </div>
  );
}

function OnboardingTableRow({
  p,
  updating,
  onUpdate,
}: {
  p: OnboardingProvider;
  updating: boolean;
  onUpdate: (status: string) => void;
}) {
  return (
    <tr className="border-b last:border-0 hover:bg-muted/30">
      <td className="px-2 py-1.5 font-medium">{p.name}</td>
      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(p.providerType)}</Badge></td>
      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(p.trustModel)}</Badge></td>
      <td className="px-2 py-1.5 text-[10px] text-muted-foreground font-mono">{p.jurisdiction ?? "—"}</td>
      <td className="px-2 py-1.5 text-[10px] text-muted-foreground font-mono">{p.contactEmail ?? "—"}</td>
      <td className="px-2 py-1.5 text-center">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", p.apiIntegrationStatus === "CONNECTED" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : p.apiIntegrationStatus === "PENDING" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>
          {p.apiIntegrationStatus ?? "NONE"}
        </Badge>
      </td>
      <td className="px-2 py-1.5">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", p.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : p.status === "APPLIED" || p.status === "REVIEW" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : p.status === "REJECTED" || p.status === "SUSPENDED" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>
          {prettyEnum(p.status)}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-right">
        <Select value={p.status} onValueChange={onUpdate} disabled={updating}>
          <SelectTrigger className="h-7 text-[10px] w-[120px] ml-auto"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ONBOARDING_STATUSES.map((s) => <SelectItem key={s} value={s}>{prettyEnum(s)}</SelectItem>)}
          </SelectContent>
        </Select>
      </td>
    </tr>
  );
}
