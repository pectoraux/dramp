"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePolling } from "@/hooks/use-polling";
import { EventTimeline } from "./event-timeline";
import {
  auditCategoryColor,
  shortId,
} from "./format";
import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldAlert, Link2 } from "lucide-react";
import type { AuditResponse } from "./types";

export function AuditPanel() {
  const { data, loading } = usePolling<AuditResponse>("/api/audit", 3000);
  const events = data?.events ?? [];
  const valid = data?.chainValid?.valid ?? true;
  const brokenAt = data?.chainValid?.brokenAt ?? null;

  // Reverse-chronological (events come in ascending from API).
  const sorted = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return (
    <div className="space-y-4">
      {/* Chain validity banner */}
      <Card className={cn("py-4", valid ? "border-emerald-500/40 bg-emerald-500/5" : "border-rose-500/50 bg-rose-500/5")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {valid ? (
              <ShieldCheck className="size-4 text-emerald-500" />
            ) : (
              <ShieldAlert className="size-4 text-rose-500" />
            )}
            <span>Audit chain integrity</span>
            <Badge variant="outline" className={cn("text-[10px] py-0 h-4", valid ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-300")}>
              {valid ? "Chain intact" : `Chain broken at index ${brokenAt}`}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            {valid
              ? `All ${events.length} events form a valid SHA-256 hash chain. Each event's hash incorporates the previous event's hash, making tampering detectable.`
              : "The hash chain is broken — events after the break point should not be trusted."}
          </CardDescription>
        </CardHeader>
        {sorted.length > 0 && (
          <CardContent>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
              <Link2 className="size-3" />
              <span>genesis</span>
              <span className="text-emerald-500">→</span>
              <span>{shortId(sorted[sorted.length - 1].hash, 10)}</span>
              <span className="text-muted-foreground/60">(oldest)</span>
              <span className="text-emerald-500 mx-1">…</span>
              <span>{shortId(sorted[0].hash, 10)}</span>
              <span className="text-muted-foreground/60">(latest)</span>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Event list */}
      <Card className="py-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            Audit events
            <Badge variant="outline" className="text-[10px] py-0 h-4">{sorted.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            Reverse chronological. Click any event to expand its full payload. Color-coded by category.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && sorted.length === 0 ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : sorted.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No audit events yet. Seed the marketplace and create an intent to populate the chain.
            </div>
          ) : (
            <EventTimeline events={sorted} maxHeight="max-h-[60vh]" />
          )}
        </CardContent>
      </Card>

      {/* Category legend */}
      <Card className="py-3">
        <CardContent className="py-2">
          <div className="flex items-center gap-2 flex-wrap text-[10px]">
            <span className="text-muted-foreground">Categories:</span>
            <Legend cls={auditCategoryColor("intent_created")} label="Intent" />
            <Legend cls={auditCategoryColor("route_selected")} label="Route" />
            <Legend cls={auditCategoryColor("collateral_locked")} label="Collateral" />
            <Legend cls={auditCategoryColor("settlement_settled")} label="Settlement" />
            <Legend cls={auditCategoryColor("payout_completed")} label="Payout" />
            <Legend cls={auditCategoryColor("leg_failed")} label="Failure" />
            <Legend cls={auditCategoryColor("market_signal")} label="Market" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] py-0 h-4", cls)}>{label}</Badge>
  );
}
