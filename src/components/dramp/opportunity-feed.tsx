"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { formatMoney, toNum, prettyCorridor } from "./format";
import { TrendingUp, AlertCircle, Gauge } from "lucide-react";
import type { OpportunitiesResponse, OpportunityItem } from "./types";

function opportunityColor(level: string): string {
  switch (level) {
    case "HIGH":
      return "border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 font-medium";
    case "MEDIUM":
      return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300";
    case "LOW":
    default:
      return "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300";
  }
}

export function OpportunityFeed() {
  const { data, loading } = usePolling<OpportunitiesResponse>("/api/economics/opportunities", 5000);
  const opportunities = data?.opportunities ?? [];

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <TrendingUp className="size-4 text-emerald-500" />
            Provider opportunities
          </h3>
          <p className="text-xs text-muted-foreground">
            Corridors where demand exceeds supply. Estimated spread is the median fee on the corridor.
          </p>
        </div>
        <Badge variant="outline" className="text-[10px] py-0 h-4 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300">
          {opportunities.length} active
        </Badge>
      </div>

      {/* Disclaimer banner */}
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
        <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
        <span>Indicative opportunity — not a profitability guarantee. Actual earnings depend on competition, capital cost, and execution reliability.</span>
      </div>

      {opportunities.length === 0 ? (
        <Card className="py-10 border-dashed">
          <CardContent className="text-center text-sm text-muted-foreground space-y-2">
            <Gauge className="size-6 mx-auto text-muted-foreground/60" />
            <div>No active opportunities right now</div>
            <div className="text-[10px]">Opportunities appear when pending WAIT_FOR_BETTER intents exceed available supply on a corridor.</div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {opportunities.map((o, i) => (
            <OpportunityCard key={`${o.corridor}-${i}`} o={o} />
          ))}
        </div>
      )}
    </div>
  );
}

function OpportunityCard({ o }: { o: OpportunityItem }) {
  const demand = toNum(o.demandAmount);
  const supply = toNum(o.supplyAmount);
  const gap = toNum(o.gap);
  const gapPct = o.gapPct;
  const supplyPct = demand > 0 ? Math.max(0, Math.min(100, (supply / demand) * 100)) : 0;

  return (
    <Card className="py-3 h-full">
      <CardContent className="py-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-mono text-xs truncate">{prettyCorridor(o.corridor)}</div>
            <div className="text-[10px] text-muted-foreground">Demand vs available supply</div>
          </div>
          <Badge variant="outline" className={cn("text-[10px] py-0 h-4 shrink-0", opportunityColor(o.opportunity))}>
            {o.opportunity}
          </Badge>
        </div>

        {/* Demand vs supply bar */}
        <div className="space-y-1">
          <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-sky-500/60"
              style={{ width: `${supplyPct}%` }}
              title={`Supply: ${formatMoney(supply)}`}
            />
            <div
              className="absolute inset-y-0 left-0 bg-rose-500/40 border-r border-rose-500/60"
              style={{ width: `${100 - supplyPct}%` }}
              title={`Gap: ${formatMoney(gap)}`}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Demand <span className="font-mono text-foreground">{formatMoney(demand)}</span></span>
            <span>Supply <span className="font-mono text-foreground">{formatMoney(supply)}</span></span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[10px] pt-1">
          <div className="rounded-md border bg-muted/20 p-1.5">
            <div className="text-muted-foreground">Liquidity gap</div>
            <div className="font-mono tabular-nums text-sm mt-0.5 text-rose-600 dark:text-rose-400">
              {formatMoney(gap)}
            </div>
            <div className="text-[9px] text-muted-foreground">({gapPct}% of demand)</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-1.5">
            <div className="text-muted-foreground">Est. spread</div>
            <div className="font-mono tabular-nums text-sm mt-0.5 text-emerald-600 dark:text-emerald-400">
              {o.estimatedSpreadBps} bps
            </div>
            <div className="text-[9px] text-muted-foreground">median fee on corridor</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
