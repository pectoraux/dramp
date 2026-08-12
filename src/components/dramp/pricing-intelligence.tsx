"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import {
  formatMoney,
  formatBps,
  formatRate,
  formatTimestamp,
  formatDuration,
  toNum,
  tierBadgeClass,
  tierDotClass,
  prettyEnum,
} from "./format";
import { LineChart, Zap, Coins, Activity, Search } from "lucide-react";
import type { PricingIntelligenceResponse } from "./types";

const ASSET_OPTIONS = ["USD", "EUR", "USDC", "SC", "WETH"];

export function PricingIntelligence() {
  const [src, setSrc] = useState<string>("USD");
  const [dst, setDst] = useState<string>("EUR");
  const [submitted, setSubmitted] = useState<string>("USD->EUR");

  const corridor = `${src}->${dst}`;
  const url = `/api/economics/pricing/${encodeURIComponent(corridor)}`;
  // We poll the last submitted corridor so the user explicitly searches.
  const { data, loading } = usePolling<PricingIntelligenceResponse>(
    submitted ? `/api/economics/pricing/${encodeURIComponent(submitted)}` : null,
    5000,
  );

  function search() {
    if (src === dst) return;
    setSubmitted(`${src}->${dst}`);
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <LineChart className="size-4 text-emerald-500" />
          Pricing intelligence
        </h3>
        <p className="text-xs text-muted-foreground">
          Competitive landscape for a corridor — fees, fastest provider, and recent fills.
        </p>
      </div>

      {/* Corridor selector */}
      <Card className="py-3">
        <CardContent className="py-1">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Source asset</label>
              <Select value={src} onValueChange={setSrc}>
                <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <span className="text-muted-foreground pb-1.5">→</span>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Destination asset</label>
              <Select value={dst} onValueChange={setDst}>
                <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" className="h-8" onClick={search} disabled={src === dst}>
              <Search className="size-3.5" /> Search
            </Button>
            {src === dst && (
              <span className="text-[10px] text-rose-500 pb-1.5">Source and destination must differ</span>
            )}
          </div>
        </CardContent>
      </Card>

      {!submitted ? (
        <Card className="py-10 border-dashed">
          <CardContent className="text-center text-sm text-muted-foreground">
            Pick a corridor and search to view pricing intelligence.
          </CardContent>
        </Card>
      ) : loading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !data ? null : (
        <PricingResultView data={data} />
      )}
    </div>
  );
}

function PricingResultView({ data }: { data: PricingIntelligenceResponse }) {
  if (data.message || (data.offerCount === 0 && (!data.offers || data.offers.length === 0))) {
    return (
      <Card className="py-10 border-dashed">
        <CardContent className="text-center text-sm text-muted-foreground space-y-1">
          <Search className="size-5 mx-auto text-muted-foreground/60" />
          <div>No active offers on corridor <span className="font-mono">{data.corridor}</span></div>
          {data.message && <div className="text-[10px]">{data.message}</div>}
        </CardContent>
      </Card>
    );
  }

  const offers = data.offers ?? [];
  const recentFills = data.recentFills ?? [];

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Coins className="size-3.5 text-emerald-500" />}
          label="Cheapest fee"
          value={data.cheapestFeeBps != null ? formatBps(data.cheapestFeeBps) : "—"}
          accent="emerald"
        />
        <StatCard
          icon={<LineChart className="size-3.5 text-sky-500" />}
          label="Median fee"
          value={data.medianFeeBps != null ? formatBps(data.medianFeeBps) : "—"}
        />
        <StatCard
          icon={<Coins className="size-3.5 text-amber-500" />}
          label="Most expensive"
          value={data.mostExpensiveFeeBps != null ? formatBps(data.mostExpensiveFeeBps) : "—"}
          accent="amber"
        />
        <StatCard
          icon={<Zap className="size-3.5 text-violet-500" />}
          label="Fastest provider"
          value={data.fastestProvider ?? "—"}
          sub={data.fastestExecutionSeconds != null ? `${formatDuration(data.fastestExecutionSeconds)} execution` : undefined}
        />
      </div>

      {/* Offers table */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="size-4 text-emerald-500" /> Active offers
            <Badge variant="outline" className="text-[10px] py-0 h-4">{data.offerCount}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">Sorted by fee ascending.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {offers.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No active offers.</div>
          ) : (
            <div className="dramp-scroll max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Provider</th>
                    <th className="text-left font-medium px-2 py-1.5">Tier</th>
                    <th className="text-right font-medium px-2 py-1.5">Fee</th>
                    <th className="text-right font-medium px-2 py-1.5">Rate</th>
                    <th className="text-right font-medium px-2 py-1.5">Capacity</th>
                    <th className="text-right font-medium px-2 py-1.5">Speed</th>
                    <th className="text-left font-medium px-2 py-1.5">Channel</th>
                  </tr>
                </thead>
                <tbody>
                  {offers.map((o, i) => (
                    <tr key={`${o.provider}-${i}`} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-1.5">
                        <div className="font-medium truncate max-w-[160px]">{o.provider}</div>
                        <div className="text-[10px] text-muted-foreground">{prettyEnum(o.providerType)}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        {o.tier ? (
                          <Badge variant="outline" className={cn("text-[9px] py-0 h-3.5 gap-1", tierBadgeClass(o.tier))}>
                            <span className={cn("inline-block size-1 rounded-full", tierDotClass(o.tier))} />
                            {o.tier}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatBps(o.feeBps)}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatRate(o.rate)}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(o.availableCapacity)}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatDuration(o.expectedExecutionSeconds)}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", o.channelType === "MANUAL" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
                          {o.channelType}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent fills */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Coins className="size-4 text-emerald-500" /> Recent fills
            <Badge variant="outline" className="text-[10px] py-0 h-4">{recentFills.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">Last 10 completed executions on this corridor.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {recentFills.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No completed fills yet.</div>
          ) : (
            <div className="dramp-scroll max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Amount</th>
                    <th className="text-right font-medium px-2 py-1.5">Fee</th>
                    <th className="text-right font-medium px-2 py-1.5">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {recentFills.map((f, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-1.5 font-mono tabular-nums">{formatMoney(f.amount)}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{f.feeBps != null ? formatBps(f.feeBps) : "—"}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground">{formatTimestamp(f.completedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: "emerald" | "amber";
}) {
  return (
    <Card className="py-3">
      <CardContent className="py-1">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className={cn(
          "text-sm font-mono tabular-nums mt-1 font-medium truncate",
          accent === "emerald" && "text-emerald-600 dark:text-emerald-400",
          accent === "amber" && "text-amber-600 dark:text-amber-400",
        )}>
          {value}
        </div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
