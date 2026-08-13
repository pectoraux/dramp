"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { formatDuration, scoreBarColor, scoreLabel } from "./format";
import { Activity, Clock, ShieldCheck } from "lucide-react";
import type { NetworkHealthResponse } from "./types";

const COMPONENT_META: Array<{ key: string; label: string; desc: string }> = [
  { key: "liquidityDepth", label: "Liquidity Depth", desc: "Total available capacity across all active offers." },
  { key: "routeCompetition", label: "Route Competition", desc: "Average active offers per corridor." },
  { key: "providerReliability", label: "Provider Reliability", desc: "Average reputation across active providers." },
  { key: "executionSuccess", label: "Execution Success", desc: "Completion rate of all executions." },
  { key: "riskConcentration", label: "Risk Concentration", desc: "Inverse of top provider's offer share (higher = more diverse)." },
];

export function NetworkHealthView() {
  const { data, loading } = usePolling<NetworkHealthResponse>("/api/economics/network-health", 5000);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const overall = data.overall;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Activity className="size-4 text-emerald-500" />
          Network health
        </h3>
        <p className="text-xs text-muted-foreground">
          Transparent composite score built from observable marketplace components.
        </p>
      </div>

      {/* Overall score */}
      <Card className="py-4 border-emerald-500/30">
        <CardContent className="py-1">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Overall score</div>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-4xl font-mono tabular-nums font-semibold">{overall}</span>
                <span className="text-xs text-muted-foreground">/ 100</span>
                <span className="text-xs ml-1">{scoreLabel(overall)}</span>
              </div>
            </div>
            <div className="w-full sm:w-48">
              <div className="relative h-2.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={cn("absolute inset-y-0 left-0 rounded-full transition-all", scoreBarColor(overall))}
                  style={{ width: `${Math.max(2, Math.min(100, overall))}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1">
                <span>0</span><span>50</span><span>100</span>
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2 text-xs">
            <Clock className="size-3.5 text-amber-500" />
            <span className="text-muted-foreground">Average wait</span>
            <span className="font-mono tabular-nums">{formatDuration(data.averageWait)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Component bars */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-500" /> Component breakdown
          </CardTitle>
          <CardDescription className="text-xs">Each component contributes to the composite score.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2 space-y-3">
          {COMPONENT_META.map((c) => {
            const val = data.components[c.key] ?? 0;
            return (
              <div key={c.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{c.label}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">{scoreLabel(val)}</span>
                    <span className="font-mono tabular-nums">{val}</span>
                  </div>
                </div>
                <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn("absolute inset-y-0 left-0 rounded-full transition-all", scoreBarColor(val))}
                    style={{ width: `${Math.max(2, Math.min(100, val))}%` }}
                  />
                </div>
                <div className="text-[10px] text-muted-foreground">{c.desc}</div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
