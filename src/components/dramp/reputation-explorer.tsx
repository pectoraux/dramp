"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import {
  tierBadgeClass,
  tierDotClass,
  scoreBarColor,
  scoreLabel,
  prettyEnum,
} from "./format";
import {
  Star,
  ChevronDown,
  Info,
  Loader2,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import type { ReputationResult } from "./types";

interface ReputationExplorerProps {
  providerId: string | null;
  /** If true, render as an inline card (used in dialogs). Otherwise a slim button trigger. */
  inline?: boolean;
  /** Compact trigger button label */
  triggerLabel?: string;
}

const COMPONENT_META: Array<{
  key: "reliability" | "speed" | "liquidityQuality" | "pricing" | "disputes" | "operational" | "history";
  label: string;
  weight: string;
  desc: string;
}> = [
  { key: "reliability", label: "Reliability", weight: "25%", desc: "Did the provider fulfill accepted executions?" },
  { key: "speed", label: "Speed", weight: "15%", desc: "How quickly does it execute?" },
  { key: "liquidityQuality", label: "Liquidity Quality", weight: "15%", desc: "Did advertised liquidity stay available?" },
  { key: "pricing", label: "Pricing", weight: "15%", desc: "How competitive are its offers vs network median?" },
  { key: "disputes", label: "Disputes", weight: "15%", desc: "How few disputes have been opened against it?" },
  { key: "operational", label: "Operational", weight: "10%", desc: "How few manual/API failures?" },
  { key: "history", label: "History", weight: "5%", desc: "How long has the provider been active?" },
];

export function ReputationExplorer({
  providerId,
  inline = false,
  triggerLabel = "View reputation",
}: ReputationExplorerProps) {
  const [open, setOpen] = useState(false);

  if (!providerId) {
    return null;
  }

  if (inline) {
    return <ReputationInline providerId={providerId} />;
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[10px] gap-1"
        onClick={() => setOpen(true)}
      >
        <Star className="size-3 text-amber-500" />
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto dramp-scroll">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-emerald-500" />
              Provider reputation
            </DialogTitle>
            <DialogDescription className="text-xs">
              Transparent, explainable score derived from observable historical behavior.
              Reputation never overrides hard risk constraints — it only affects route ranking.
            </DialogDescription>
          </DialogHeader>
          <ReputationInline providerId={providerId} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReputationInline({ providerId }: { providerId: string }) {
  const { data, loading, error } = usePolling<ReputationResult>(
    `/api/economics/reputation/${encodeURIComponent(providerId)}`,
    10000,
  );

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-300 flex items-start gap-2">
        <AlertCircle className="size-4 shrink-0 mt-0.5" />
        <span>Failed to load reputation: {error}</span>
      </div>
    );
  }

  if (!data) return null;

  const overall = data.components.overall;
  const tier = data.tier;

  return (
    <div className="space-y-3">
      {/* Overall score + tier */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="sm:col-span-2 py-3">
          <CardContent className="py-1">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Overall score</div>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-3xl font-mono tabular-nums font-semibold">{overall}</span>
                  <span className="text-xs text-muted-foreground">/ 100</span>
                  <span className="text-[10px] text-muted-foreground ml-1">{scoreLabel(overall)}</span>
                </div>
              </div>
              <div className="w-24">
                <Progress
                  value={overall}
                  className="h-2 bg-muted"
                />
              </div>
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground flex items-center gap-1">
              <Info className="size-3" />
              Based on {data.components.sampleSize} meaningful executions
            </div>
          </CardContent>
        </Card>

        <Card className="py-3">
          <CardContent className="py-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Tier</div>
            <div className="mt-1.5">
              <Badge variant="outline" className={cn("gap-1.5 h-6 px-2 text-[11px]", tierBadgeClass(tier))}>
                <span className={cn("inline-block size-1.5 rounded-full", tierDotClass(tier))} />
                {tier}
              </Badge>
            </div>
            <div className="mt-1.5 text-[10px] text-muted-foreground leading-snug">{data.tierReason}</div>
          </CardContent>
        </Card>
      </div>

      {/* Expandable component breakdown */}
      <Collapsible defaultOpen>
        <Card className="py-3">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Info className="size-3.5 text-emerald-500" />
              Why is this provider rated {overall}?
            </CardTitle>
            <CardDescription className="text-[10px]">
              Weighted composite — {data.components.decayNote}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-2 space-y-2.5">
            {COMPONENT_META.map((c) => {
              const val = data.components[c.key];
              return (
                <div key={c.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{c.label}</span>
                      <span className="text-[10px] text-muted-foreground">weight {c.weight}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">{scoreLabel(val)}</span>
                      <span className="font-mono tabular-nums">{val}</span>
                    </div>
                  </div>
                  <div className="relative h-1.5 w-full rounded-full bg-muted overflow-hidden">
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
      </Collapsible>
    </div>
  );
}
