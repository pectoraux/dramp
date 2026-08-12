"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { StatusBadge, EnumBadge } from "./status-badge";
import { CommitmentBadge } from "./commitment-badge";
import { RiskBars } from "./risk-bars";
import { StateStepper } from "./state-stepper";
import { EventTimeline } from "./event-timeline";
import { LedgerView } from "./ledger-view";
import { usePolling } from "@/hooks/use-polling";
import {
  formatMoney,
  formatRate,
  formatBps,
  formatDuration,
  formatTimestamp,
  shortId,
  toNum,
  routeTagColor,
  commitmentExplanation,
  prettyEnum,
} from "./format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  Ban,
  ArrowRight,
  Clock,
  Coins,
  Receipt,
  ShieldOff,
  ChevronDown,
  Lock,
  ScrollText,
  Building2,
  Hourglass,
  AlertCircle,
  CheckCircle2,
  FileText,
} from "lucide-react";
import type { ExecutionDetailResponse } from "./types";

interface ExecutionDetailProps {
  executionId: string | null;
}

export function ExecutionDetail({ executionId }: ExecutionDetailProps) {
  const url = executionId ? `/api/executions/${executionId}` : null;
  const { data, loading, error } = usePolling<ExecutionDetailResponse>(url, 2000);

  if (!executionId) {
    return (
      <Card className="py-12 border-dashed">
        <CardContent className="text-center text-sm text-muted-foreground">
          Select an execution from the list to inspect its full lifecycle.
        </CardContent>
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card className="py-8 border-rose-500/40">
        <CardContent className="text-center text-sm text-rose-600 dark:text-rose-400">
          Failed to load execution: {error}
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const ex = data.execution;
  const intent = ex.intent;
  const route = ex.selectedRoute;
  const isSearchingWait = ex.status === "SEARCHING" && intent?.executionPolicy === "WAIT_FOR_BETTER";
  const maxWait = intent?.maxWaitSeconds ?? 1;
  const waitedPct = Math.min(100, Math.round((toNum(ex.waitedSeconds) / Math.max(1, maxWait)) * 100));
  const irreversible = ex.commitmentStatus === "IRREVERSIBLE";
  const completed = ex.status === "COMPLETED";

  async function handleCancel() {
    if (!executionId) return;
    try {
      const res = await fetch(`/api/executions/${executionId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "ui-user" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.cancelled) {
        toast.success("Execution cancelled", { description: json.reason ?? "Cancelled while reversible." });
      } else {
        toast.warning("Could not cancel", { description: json.reason ?? "Cancellation not permitted." });
      }
    } catch (err) {
      toast.error("Cancel failed", { description: err instanceof Error ? err.message : "unknown error" });
    }
  }

  return (
    <motion.div
      key={executionId}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-4"
    >
      {/* Header card */}
      <Card className="py-4">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="space-y-1.5 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-base font-mono">{shortId(ex.id, 12)}</CardTitle>
                <StatusBadge status={ex.status} />
                <CommitmentBadge status={ex.commitmentStatus} />
              </div>
              <CardDescription className="text-xs">
                {intent ? (
                  <>
                    {formatMoney(intent.sourceAmount)} {intent.sourceAsset} · {intent.sourceCountry}
                    <ArrowRight className="inline size-3 mx-1" />
                    {intent.destinationAsset} · {intent.destinationCountry}
                    {" · "}Attempt {ex.attemptNumber ?? 1}
                  </>
                ) : "—"}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {isSearchingWait && (
                <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400">
                  <Hourglass className="size-3 dramp-blink" /> Waiting {formatDuration(ex.waitedSeconds)}
                </Badge>
              )}
              {!irreversible ? (
                <Button variant="outline" size="sm" onClick={handleCancel} className="text-rose-600 dark:text-rose-400 hover:bg-rose-500/10">
                  <Ban className="size-3" /> Cancel
                </Button>
              ) : (
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button variant="outline" size="sm" disabled className="opacity-60">
                          <ShieldOff className="size-3" /> Cancel locked
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs text-xs">
                      {commitmentExplanation(ex.commitmentStatus)}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">State machine progress</div>
            <StateStepper status={ex.status} />
          </div>

          {ex.failureReason && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-600 dark:text-rose-300 flex gap-2">
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Failure reason</div>
                <div className="opacity-90">{ex.failureReason}</div>
              </div>
            </div>
          )}

          {isSearchingWait && (
            <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm text-sky-600 dark:text-sky-400">
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-sky-500 opacity-60 animate-ping" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-sky-500" />
                </span>
                <span className="font-medium">Monitoring market for better routes…</span>
                <span className="ml-auto text-xs font-mono tabular-nums">{formatDuration(ex.waitedSeconds)} / {formatDuration(maxWait)}</span>
              </div>
              <Progress value={waitedPct} className="h-1.5" />
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat icon={<Clock className="size-3" />} label="Waited" value={formatDuration(ex.waitedSeconds)} />
            <Stat icon={<Building2 className="size-3" />} label="Started" value={formatTimestamp(ex.startedAt)} />
            <Stat icon={<CheckCircle2 className="size-3" />} label="Completed" value={ex.completedAt ? formatTimestamp(ex.completedAt) : "—"} />
            <Stat icon={<Coins className="size-3" />} label="Attempt" value={`${ex.attemptNumber ?? 1}`} />
          </div>
        </CardContent>
      </Card>

      {/* Selected route */}
      {route && (
        <Card className="py-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <ArrowRight className="size-4 text-emerald-500" />
              Selected route
              {route.tag && (
                <Badge variant="outline" className={cn(routeTagColor(route.tag))}>{route.tag}</Badge>
              )}
            </CardTitle>
            {route.explanation && (
              <CardDescription className="text-xs leading-relaxed">{route.explanation}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat icon={<Coins className="size-3" />} label="Net output" value={route.netOutput ? `${formatMoney(route.netOutput)} ${intent?.destinationAsset ?? ""}` : "—"} highlight />
              <Stat icon={<Coins className="size-3" />} label="Eff. cost" value={route.effectiveCost ? `${formatMoney(route.effectiveCost)} ${intent?.sourceAsset ?? ""}` : "—"} />
              <Stat icon={<Clock className="size-3" />} label="Expected" value={formatDuration(route.expectedExecutionSeconds)} />
              <Stat icon={<ArrowRight className="size-3" />} label="Hops" value={`${route.hopCount ?? route.legs?.length ?? 0}`} />
            </div>

            {route.legs && route.legs.length > 0 && (
              <div className="rounded-md border bg-muted/20 p-2.5">
                <div className="text-xs text-muted-foreground mb-2">Provider chain</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {route.legs.map((leg, i) => {
                    const name = leg.provider?.name ?? leg.providerName ?? "Unknown";
                    const ptype = leg.provider?.providerType ?? leg.providerType;
                    return (
                      <div key={i} className="flex items-center gap-1.5">
                        <div className="rounded-md border bg-card px-2 py-1.5">
                          <div className="text-xs font-medium">{name}</div>
                          <div className="flex items-center gap-1 mt-0.5">
                            {ptype && <Badge variant="outline" className="text-[9px] py-0 h-3.5">{prettyEnum(ptype)}</Badge>}
                            <Badge variant="outline" className={cn("text-[9px] py-0 h-3.5", leg.channelType === "MANUAL" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
                              {leg.channelType}
                            </Badge>
                          </div>
                        </div>
                        {i < (route.legs?.length ?? 0) - 1 && <ArrowRight className="size-3 text-muted-foreground" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {route.risk && (
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Risk dimensions</div>
                <RiskBars risk={route.risk} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Receipt */}
      {completed && route && (
        <Card className="py-4 border-emerald-500/40 bg-emerald-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <Receipt className="size-4" />
              Execution receipt
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat icon={<Coins className="size-3" />} label="Final output" value={route.netOutput ? `${formatMoney(route.netOutput)} ${intent?.destinationAsset ?? ""}` : "—"} highlight />
              <Stat icon={<Coins className="size-3" />} label="Total cost" value={route.effectiveCost ? `${formatMoney(route.effectiveCost)} ${intent?.sourceAsset ?? ""}` : "—"} />
              <Stat icon={<Clock className="size-3" />} label="Total time" value={ex.completedAt ? formatDuration(Math.round((new Date(ex.completedAt).getTime() - new Date(ex.startedAt).getTime()) / 1000)) : "—"} />
            </div>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs h-7">
                  <FileText className="size-3" /> View full audit & ledger
                  <ChevronDown className="size-3" />
                </Button>
              </CollapsibleTrigger>
            </Collapsible>
          </CardContent>
        </Card>
      )}

      {/* Providers & obligations + collateral */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="py-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Building2 className="size-4 text-emerald-500" />
              Providers & obligations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {ex.legs && ex.legs.length > 0 ? (
              <div className="space-y-2">
                {ex.legs
                  .slice()
                  .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
                  .map((leg) => {
                    const obligation = ex.obligations?.find((o) => o.legId === leg.id);
                    return (
                      <div key={leg.id} className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                            <span className="text-xs font-medium truncate">{leg.provider?.name ?? "Unknown"}</span>
                            {leg.provider?.providerType && <EnumBadge value={leg.provider.providerType} className="text-[10px] py-0 h-4" />}
                            {leg.provider?.trustModel && <EnumBadge value={leg.provider.trustModel} className="text-[10px] py-0 h-4" />}
                          </div>
                          <Badge variant="outline" className={cn("text-[10px] py-0 h-4", leg.channelType === "MANUAL" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
                            {leg.channelType}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <span className="font-mono">{formatMoney(leg.amount)} {leg.sourceAsset}</span>
                          <ArrowRight className="size-3 text-muted-foreground" />
                          <span className="font-mono">{leg.destinationAsset}</span>
                          {leg.offer?.feeBps ? <span className="text-muted-foreground">fee {leg.offer.feeBps}bps</span> : null}
                          {leg.offer?.incentiveBps ? <span className="text-muted-foreground">inc {leg.offer.incentiveBps}bps</span> : null}
                          {leg.offer?.rate ? <span className="text-muted-foreground ml-auto">rate {formatRate(leg.offer.rate)}</span> : null}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] text-muted-foreground">Leg</span>
                          <StatusBadge status={leg.status} className="text-[10px] py-0 h-4" />
                          {obligation && (
                            <>
                              <span className="text-[10px] text-muted-foreground">· Obligation</span>
                              <StatusBadge status={obligation.status} className="text-[10px] py-0 h-4" />
                              <span className="text-[10px] font-mono ml-auto">{formatMoney(obligation.amount)} {obligation.asset}</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground text-center py-3">No legs yet.</div>
            )}
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Lock className="size-4 text-emerald-500" />
              Collateral & reservations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {ex.collateralLocks && ex.collateralLocks.length > 0 ? (
              <div className="space-y-1.5">
                {ex.collateralLocks.map((c, i) => (
                  <div key={i} className="rounded-md border bg-muted/20 p-2 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <Lock className="size-3 text-teal-500" />
                      <span className="font-mono">{formatMoney(c.amount)} {c.asset}</span>
                    </div>
                    <StatusBadge status={c.status} className="text-[10px] py-0 h-4" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground text-center py-2">No collateral locks.</div>
            )}
            {ex.reservations && ex.reservations.length > 0 && (
              <Separator />
            )}
            {ex.reservations && ex.reservations.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Capacity reservations</div>
                {ex.reservations.map((r, i) => (
                  <div key={i} className="rounded-md border bg-muted/20 p-2 flex items-center justify-between text-xs">
                    <span className="font-mono">{formatMoney(r.amount)}</span>
                    <StatusBadge status={r.status} className="text-[10px] py-0 h-4" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Audit timeline */}
      <Card className="py-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ScrollText className="size-4 text-emerald-500" />
            Event timeline
            <Badge variant="outline" className="text-[10px] py-0 h-4">{data.audit?.length ?? 0} events</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EventTimeline events={data.audit} maxHeight="max-h-[28rem]" />
        </CardContent>
      </Card>

      {/* Ledger — keyed by completion so it auto-expands once the execution completes */}
      <LedgerView key={`ledger-${completed}`} ledger={data.ledger} defaultOpen={completed} />
    </motion.div>
  );
}

function Stat({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn(
        "text-sm font-mono tabular-nums mt-0.5 truncate",
        highlight && "text-emerald-600 dark:text-emerald-400 font-semibold",
      )} title={value}>
        {value}
      </div>
    </div>
  );
}
