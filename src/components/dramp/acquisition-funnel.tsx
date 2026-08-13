"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { Filter, Users } from "lucide-react";
import type { AcquisitionFunnelResponse } from "./types";

const STAGES: Array<{
  key: keyof AcquisitionFunnelResponse;
  label: string;
  desc: string;
  icon: React.ReactNode;
}> = [
  { key: "applied", label: "Applied", desc: "Submitted a waitlist application", icon: <Users className="size-3.5" /> },
  { key: "approved", label: "Approved", desc: "Admin approved the application", icon: <Filter className="size-3.5" /> },
  { key: "connected", label: "Connected", desc: "Provider status set to ACTIVE", icon: <Filter className="size-3.5" /> },
  { key: "publishedOffer", label: "Published offer", desc: "First offer created", icon: <Filter className="size-3.5" /> },
  { key: "receivedExecution", label: "Received execution", desc: "First leg assigned", icon: <Filter className="size-3.5" /> },
  { key: "completedExecution", label: "Completed execution", desc: "First completed execution", icon: <Filter className="size-3.5" /> },
  { key: "repeatProvider", label: "Repeat provider", desc: "More than 1 completed execution", icon: <Filter className="size-3.5" /> },
];

const CONVERSION_STAGES: Array<{
  key: keyof AcquisitionFunnelResponse["conversionRates"];
  from: string;
  to: string;
  label: string;
}> = [
  { key: "appliedToApproved", from: "applied", to: "approved", label: "Applied → Approved" },
  { key: "approvedToConnected", from: "approved", to: "connected", label: "Approved → Connected" },
  { key: "connectedToPublished", from: "connected", to: "publishedOffer", label: "Connected → Published" },
  { key: "publishedToFirstExecution", from: "publishedOffer", to: "receivedExecution", label: "Published → First execution" },
  { key: "firstToRepeat", from: "receivedExecution", to: "repeatProvider", label: "First → Repeat" },
];

export function AcquisitionFunnel() {
  const { data, loading } = usePolling<AcquisitionFunnelResponse>("/api/economics/funnel", 5000);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  // Max count for bar width scaling
  const maxValue = Math.max(
    data.applied, data.approved, data.connected, data.publishedOffer,
    data.receivedExecution, data.completedExecution, data.repeatProvider, 1,
  );

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Filter className="size-4 text-emerald-500" />
          Provider acquisition funnel
        </h3>
        <p className="text-xs text-muted-foreground">
          From waitlist application to repeat provider — conversion at each stage.
        </p>
      </div>

      {/* Funnel stages */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Funnel stages
          </CardTitle>
          <CardDescription className="text-xs">Bars scaled to the largest stage count.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2 space-y-2.5">
          {STAGES.map((s) => {
            const value = data[s.key] as number;
            const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
            const conversionPct = data.applied > 0 ? Math.round((value / data.applied) * 100) : 0;
            return (
              <div key={s.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-muted-foreground shrink-0">{s.icon}</span>
                    <span className="font-medium">{s.label}</span>
                    <span className="text-[10px] text-muted-foreground truncate hidden sm:inline">{s.desc}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-muted-foreground">of applied</span>
                    <span className="font-mono tabular-nums text-[10px] text-muted-foreground">{conversionPct}%</span>
                    <span className="font-mono tabular-nums font-medium w-8 text-right">{value}</span>
                  </div>
                </div>
                <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all"
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Conversion rates */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Conversion rates</CardTitle>
          <CardDescription className="text-xs">Stage-to-stage conversion %.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {CONVERSION_STAGES.map((c) => {
              const value = data.conversionRates[c.key];
              const color = value >= 75 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                : value >= 40 ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300";
              return (
                <div key={c.key} className="rounded-md border bg-muted/20 p-2">
                  <div className="text-[10px] text-muted-foreground">{c.label}</div>
                  <div className="flex items-baseline justify-between mt-0.5">
                    <span className={cn("text-lg font-mono tabular-nums font-semibold", color.split(" ").find(c => c.startsWith("text-")))}>
                      {value}%
                    </span>
                    <Badge variant="outline" className={cn("text-[9px] py-0 h-4", color)}>
                      {value >= 75 ? "Strong" : value >= 40 ? "OK" : "Weak"}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
