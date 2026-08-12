"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { RiskBars } from "./risk-bars";
import { SettlementAssetRegistry } from "./settlement-asset-registry";
import { usePolling } from "@/hooks/use-polling";
import {
  ASSET_OPTIONS,
  COUNTRY_OPTIONS,
  RISK_OPTIONS,
  formatMoney,
  formatRate,
  formatDuration,
  prettyEnum,
  riskBarColor,
  toNum,
  shortId,
} from "./format";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type {
  MarketplaceResponse,
  MarketplaceOffer,
  PendingDemandResponse,
  PendingDemand,
  CompetitionResponse,
  CompetitionRoute,
} from "./types";
import {
  Store,
  Hourglass,
  Swords,
  Search,
  Loader2,
  ArrowRight,
  Clock,
  ShieldAlert,
  Gauge,
  Layers,
  Coins,
} from "lucide-react";

const CAPACITY_META: Record<string, { cls: string; label: string }> = {
  none: { cls: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300", label: "None" },
  low: { cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300", label: "Low" },
  medium: { cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300", label: "Medium" },
  high: { cls: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300", label: "High" },
  deep: { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300", label: "Deep" },
};

export function MarketplacePanel() {
  const [sub, setSub] = useState<string>("offers");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Store className="size-5 text-emerald-500" /> Open Liquidity Marketplace
          </h2>
          <p className="text-xs text-muted-foreground">
            Public liquidity, anonymized demand, and per-corridor provider competition.
          </p>
        </div>
      </div>

      <Tabs value={sub} onValueChange={setSub}>
        <TabsList className="bg-transparent p-0 h-9 gap-0.5">
          <TabsTrigger value="offers" className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400">
            <Store className="size-3.5" /> <span className="hidden sm:inline">Public offers</span>
          </TabsTrigger>
          <TabsTrigger value="demand" className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400">
            <Hourglass className="size-3.5" /> <span className="hidden sm:inline">Pending demand</span>
          </TabsTrigger>
          <TabsTrigger value="competition" className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400">
            <Swords className="size-3.5" /> <span className="hidden sm:inline">Provider competition</span>
          </TabsTrigger>
          <TabsTrigger value="assets" className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400">
            <Coins className="size-3.5" /> <span className="hidden sm:inline">Settlement assets</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="offers" className="focus-visible:outline-none mt-4">
          <OffersView />
        </TabsContent>
        <TabsContent value="demand" className="focus-visible:outline-none mt-4">
          <DemandView />
        </TabsContent>
        <TabsContent value="competition" className="focus-visible:outline-none mt-4">
          <CompetitionView />
        </TabsContent>
        <TabsContent value="assets" className="focus-visible:outline-none mt-4">
          <SettlementAssetRegistry intervalMs={5000} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public offers
// ---------------------------------------------------------------------------
function OffersView() {
  const [sourceAsset, setSourceAsset] = useState<string>("");
  const [destinationAsset, setDestinationAsset] = useState<string>("");

  const qs = new URLSearchParams();
  if (sourceAsset) qs.set("sourceAsset", sourceAsset);
  if (destinationAsset) qs.set("destinationAsset", destinationAsset);
  const url = `/api/marketplace${qs.toString() ? `?${qs.toString()}` : ""}`;
  const { data, loading } = usePolling<MarketplaceResponse>(url, 4000);
  const offers = data?.offers ?? [];

  return (
    <div className="space-y-3">
      <Card className="py-3">
        <CardContent className="flex flex-wrap items-end gap-3 py-1">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Source asset</Label>
            <Select value={sourceAsset || "ALL"} onValueChange={(v) => setSourceAsset(v === "ALL" ? "" : v)}>
              <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All assets</SelectItem>
                {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Destination asset</Label>
            <Select value={destinationAsset || "ALL"} onValueChange={(v) => setDestinationAsset(v === "ALL" ? "" : v)}>
              <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All assets</SelectItem>
                {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto text-xs text-muted-foreground flex items-center gap-1.5">
            <Search className="size-3" />
            {loading ? "Loading…" : `${offers.length} active offer${offers.length === 1 ? "" : "s"}`}
          </div>
        </CardContent>
      </Card>

      {loading && offers.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : offers.length === 0 ? (
        <Card className="py-12 border-dashed">
          <CardContent className="text-center text-sm text-muted-foreground">
            No public offers match these filters.
          </CardContent>
        </Card>
      ) : (
        <Card className="py-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Store className="size-4 text-emerald-500" />
              Public liquidity
              <Badge variant="outline" className="text-[10px] py-0 h-4">{offers.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2">
            <div className="dramp-scroll overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Provider</th>
                    <th className="text-left font-medium px-2 py-1.5">Corridor</th>
                    <th className="text-left font-medium px-2 py-1.5">Capability</th>
                    <th className="text-right font-medium px-2 py-1.5">Rate</th>
                    <th className="text-right font-medium px-2 py-1.5">Fee</th>
                    <th className="text-right font-medium px-2 py-1.5">Incent.</th>
                    <th className="text-center font-medium px-2 py-1.5">Capacity</th>
                    <th className="text-center font-medium px-2 py-1.5">Channel</th>
                    <th className="text-right font-medium px-2 py-1.5">Speed</th>
                    <th className="text-center font-medium px-2 py-1.5">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {offers.map((o) => <OfferRow key={o.id} offer={o} />)}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OfferRow({ offer }: { offer: MarketplaceOffer }) {
  const cap = CAPACITY_META[offer.capacityBucket] ?? CAPACITY_META.medium;
  const ri = toNum(offer.riskIndicator);
  return (
    <tr className="border-b last:border-0 hover:bg-muted/30">
      <td className="px-2 py-1.5">
        <div className="font-medium">{offer.provider.name}</div>
        <div className="text-[10px] text-muted-foreground">{prettyEnum(offer.provider.providerType)} · {prettyEnum(offer.provider.trustModel)}</div>
      </td>
      <td className="px-2 py-1.5 font-mono text-[10px]">
        {offer.sourceAsset}:{offer.sourceCountry} <ArrowRight className="inline size-2.5 mx-0.5 text-muted-foreground" /> {offer.destinationAsset}:{offer.destinationCountry}
      </td>
      <td className="px-2 py-1.5">
        <Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(offer.capability)}</Badge>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatRate(offer.rate)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{offer.feeBps} bps</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
        {offer.incentiveBps ? <span className="text-emerald-600 dark:text-emerald-400">{offer.incentiveBps} bps</span> : "—"}
      </td>
      <td className="px-2 py-1.5 text-center">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", cap.cls)}>{cap.label}</Badge>
      </td>
      <td className="px-2 py-1.5 text-center">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", offer.channelType === "MANUAL" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
          {offer.channelType}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatDuration(offer.expectedExecutionSeconds)}</td>
      <td className="px-2 py-1.5 text-center">
        <span className={cn("inline-block size-2 rounded-full", riskBarColor(ri))} title={`Counterparty risk ${(ri * 100).toFixed(0)}%`} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Pending demand (anonymized)
// ---------------------------------------------------------------------------
function DemandView() {
  const { data, loading } = usePolling<PendingDemandResponse>("/api/marketplace/demand", 3000);
  const demand = data?.demand ?? [];

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Hourglass className="size-4 text-amber-500" />
          Anonymized pending demand
          <Badge variant="outline" className="text-[10px] py-0 h-4">{demand.length}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          Active <span className="font-mono">WAIT_FOR_BETTER</span> intents — providers can see where liquidity is needed without exposing user PII.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        {loading && demand.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
          </div>
        ) : demand.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">
            No pending demand. All intents are either executing or completed.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto dramp-scroll pr-1">
            {demand.map((d) => <DemandCard key={d.id} demand={d} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DemandCard({ demand }: { demand: PendingDemand }) {
  const pct = Math.max(0, Math.min(100, (demand.elapsedSeconds / Math.max(1, demand.elapsedSeconds + demand.remainingWaitSeconds)) * 100));
  const urgent = demand.remainingWaitSeconds < 60;
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span>{demand.sourceAsset}:{demand.sourceCountry}</span>
          <ArrowRight className="size-3 text-muted-foreground" />
          <span>{demand.destinationAsset}:{demand.destinationCountry}</span>
        </div>
        <Badge variant="outline" className="text-[10px] py-0 h-4">{demand.amountBucket}</Badge>
      </div>
      <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
        <Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(demand.riskTolerance)}</Badge>
        <Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(demand.executionPolicy)}</Badge>
        <span className="font-mono">{shortId(demand.id, 6)}</span>
      </div>
      <Separator />
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><Clock className="size-2.5" /> Elapsed {formatDuration(demand.elapsedSeconds)}</span>
          <span className={cn("font-mono", urgent && "text-rose-600 dark:text-rose-400 font-medium")}>
            {urgent && <ShieldAlert className="inline size-2.5 mr-0.5" />}
            {formatDuration(demand.remainingWaitSeconds)} left
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div className={cn("h-full rounded-full", urgent ? "bg-rose-500" : "bg-amber-500")} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider competition
// ---------------------------------------------------------------------------
function CompetitionView() {
  const [sourceAsset, setSourceAsset] = useState("USD");
  const [sourceCountry, setSourceCountry] = useState("US");
  const [destinationAsset, setDestinationAsset] = useState("EUR");
  const [destinationCountry, setDestinationCountry] = useState("EU");
  const [sourceAmount, setSourceAmount] = useState("1000");
  const [riskTolerance, setRiskTolerance] = useState("BALANCED");

  const [routes, setRoutes] = useState<CompetitionRoute[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!sourceAmount || Number(sourceAmount) <= 0) {
      toast.error("Enter a source amount");
      return;
    }
    setLoading(true);
    setRoutes(null);
    try {
      const res = await fetch("/api/marketplace/competition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAsset,
          sourceCountry,
          destinationAsset,
          destinationCountry,
          sourceAmount: Number(sourceAmount),
          riskTolerance,
        }),
      });
      const json = (await res.json()) as CompetitionResponse;
      if (!res.ok) throw new Error((json as any).error || `HTTP ${res.status}`);
      const sorted = [...(json.routes || [])].sort((a, b) => Number(a.effectiveCost) - Number(b.effectiveCost));
      setRoutes(sorted);
      toast.success(`Found ${sorted.length} competing route${sorted.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error("Competition lookup failed", { description: err instanceof Error ? err.message : "unknown" });
      setRoutes([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_1fr] gap-4">
      <Card className="py-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Swords className="size-4 text-emerald-500" /> Corridor query
          </CardTitle>
          <CardDescription className="text-xs">
            Compare competing providers for a specific flow.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Source asset</Label>
              <Select value={sourceAsset} onValueChange={setSourceAsset}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Source country</Label>
              <Select value={sourceCountry} onValueChange={setSourceCountry}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Dest asset</Label>
              <Select value={destinationAsset} onValueChange={setDestinationAsset}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Dest country</Label>
              <Select value={destinationCountry} onValueChange={setDestinationCountry}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Source amount</Label>
            <Input type="number" min="0" step="any" value={sourceAmount} onChange={(e) => setSourceAmount(e.target.value)} className="font-mono h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Risk tolerance</Label>
            <Select value={riskTolerance} onValueChange={setRiskTolerance}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RISK_OPTIONS.map((r) => <SelectItem key={r} value={r}>{prettyEnum(r)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={run} disabled={loading} className="w-full" size="sm">
            {loading ? <><Loader2 className="size-3.5 animate-spin" /> Comparing…</> : <><Swords className="size-3.5" /> Compare providers</>}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-3 min-w-0">
        {!routes && !loading && (
          <Card className="py-12 border-dashed">
            <CardContent className="text-center text-sm text-muted-foreground space-y-2">
              <Swords className="size-6 text-muted-foreground/60 mx-auto" />
              <div>Configure a corridor and run the competition lookup.</div>
              <div className="text-xs">Shows up to 10 viable routes ranked by effective cost, with their provider, channel, speed and risk.</div>
            </CardContent>
          </Card>
        )}
        {loading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44 w-full" />)}
          </div>
        )}
        {routes && routes.length === 0 && (
          <Card className="py-10 border-dashed">
            <CardContent className="text-center text-sm text-muted-foreground">
              No competing routes found for this corridor.
            </CardContent>
          </Card>
        )}
        {routes && routes.length > 0 && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 max-h-[75vh] overflow-y-auto dramp-scroll pr-1">
            {routes.map((r, i) => <CompetitionRouteCard key={i} route={r} destinationAsset={destinationAsset} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function CompetitionRouteCard({ route, destinationAsset }: { route: CompetitionRoute; destinationAsset: string }) {
  return (
    <Card className="py-3">
      <CardContent className="space-y-2.5">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 font-medium">{route.tag}</Badge>
            <span className="text-sm font-medium">{route.providerName}</span>
            <Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(route.providerType)}</Badge>
            <Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(route.trustModel)}</Badge>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Layers className="size-3" /> {route.hopCount} hop{route.hopCount === 1 ? "" : "s"}
            <span className="mx-1">·</span>
            <Clock className="size-3" /> {formatDuration(route.expectedExecutionSeconds)}
          </div>
        </div>
        <p className="text-xs text-foreground/80 leading-relaxed">{route.explanation}</p>
        <div className="grid grid-cols-2 gap-2">
          <Metric icon={<Coins className="size-3" />} label="Net output" value={`${formatMoney(route.netOutput)} ${destinationAsset}`} />
          <Metric icon={<Gauge className="size-3" />} label="Eff. cost" value={`${formatMoney(route.effectiveCost)} ${route.legs[0]?.sourceAsset ?? ""}`} />
        </div>
        <Separator />
        <div>
          <div className="text-[10px] text-muted-foreground mb-1.5">Risk dimensions</div>
          <RiskBars risk={route.risk} compact />
        </div>
        <Separator />
        <div>
          <div className="text-[10px] text-muted-foreground mb-1.5">Legs</div>
          <div className="space-y-1">
            {route.legs.map((l, i) => (
              <div key={i} className="rounded-md border bg-muted/30 p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-medium">{l.providerName}</span>
                  <Badge variant="outline" className={cn("text-[10px] py-0 h-4", l.channelType === "MANUAL" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
                    {l.channelType}
                  </Badge>
                </div>
                <div className="font-mono mt-0.5">
                  {l.sourceAsset} <ArrowRight className="inline size-2.5 mx-0.5 text-muted-foreground" /> {l.destinationAsset}
                  <span className="text-muted-foreground ml-1">· {l.feeBps}bps{l.incentiveBps ? ` +${l.incentiveBps}bps inc` : ""}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-sm font-mono tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
