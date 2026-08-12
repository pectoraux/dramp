"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "./status-badge";
import { CommitmentBadge } from "./commitment-badge";
import { usePolling } from "@/hooks/use-polling";
import {
  formatMoney,
  formatDuration,
  formatTimestamp,
  shortId,
  prettyEnum,
} from "./format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Activity,
  Cog,
  Database,
  Loader2,
  Radio,
  Zap,
  ArrowRight,
} from "lucide-react";
import type { MonitorResponse } from "./types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface MonitorPanelProps {
  onJumpToExecution: (id: string) => void;
}

export function MonitorPanel({ onJumpToExecution }: MonitorPanelProps) {
  const { data, loading, refetch } = usePolling<MonitorResponse>("/api/monitor", 2000);
  const stats = data?.stats;
  const active = data?.activeExecutions ?? [];
  const intents = data?.recentIntents ?? [];
  const [ticking, setTicking] = useState(false);
  const [reseeding, setReseeding] = useState(false);

  async function forceTick() {
    setTicking(true);
    try {
      const res = await fetch("/api/engine/tick", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      refetch();
      toast.success("Engine tick forced", {
        description: `Advanced ${json.advanced ?? 0} execution(s) · ${json.signals ?? 0} signal(s)`,
      });
    } catch (err) {
      toast.error("Tick failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setTicking(false);
    }
  }

  async function reseed() {
    setReseeding(true);
    try {
      const res = await fetch("/api/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Database reseeded", {
        description: `${json.providers ?? 0} providers · ${json.offers ?? 0} offers`,
      });
      refetch();
    } catch (err) {
      toast.error("Reseed failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setReseeding(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<Database className="size-4 text-emerald-500" />}
          label="Providers"
          value={stats ? String(stats.providerCount) : "—"}
          loading={loading && !stats}
        />
        <StatCard
          icon={<Activity className="size-4 text-sky-500" />}
          label="Active offers"
          value={stats ? String(stats.offerCount) : "—"}
          loading={loading && !stats}
        />
        <StatCard
          icon={<Zap className="size-4 text-amber-500" />}
          label="Active executions"
          value={stats ? String(stats.activeCount) : "—"}
          loading={loading && !stats}
        />
        <StatCard
          icon={<Radio className={cn("size-4", stats?.tickerRunning ? "text-emerald-500" : "text-rose-500")} />}
          label="Ticker"
          value={stats ? (stats.tickerRunning ? "Running" : "Stopped") : "—"}
          loading={loading && !stats}
          accent={stats?.tickerRunning ? "emerald" : "rose"}
        />
      </div>

      {/* Controls */}
      <Card className="py-3">
        <CardContent className="flex items-center justify-between gap-2 flex-wrap py-1">
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Cog className="size-3.5" />
            Operator controls
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={forceTick} disabled={ticking}>
              {ticking ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
              Force engine tick
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-rose-600 dark:text-rose-400 hover:bg-rose-500/10">
                  <Database className="size-3" /> Reseed database
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reseed the marketplace?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This wipes <span className="font-medium text-foreground">all</span> executions, intents, ledger entries, audit events, obligations, and collateral locks, then restores the demo seed data. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={reseed}
                    className="bg-rose-600 hover:bg-rose-700 text-white"
                    disabled={reseeding}
                  >
                    {reseeding ? <Loader2 className="size-4 animate-spin" /> : null}
                    Yes, wipe & reseed
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      {/* Active executions */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="size-4 text-emerald-500" />
            Active executions
            <Badge variant="outline" className="text-[10px] py-0 h-4">{active.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2">
          {loading && active.length === 0 ? (
            <Skeleton className="h-20 w-full" />
          ) : active.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No active executions.</div>
          ) : (
            <div className="dramp-scroll overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">ID</th>
                    <th className="text-left font-medium px-2 py-1.5">Intent</th>
                    <th className="text-left font-medium px-2 py-1.5">Status</th>
                    <th className="text-left font-medium px-2 py-1.5">Commitment</th>
                    <th className="text-right font-medium px-2 py-1.5">Waited</th>
                    <th className="text-left font-medium px-2 py-1.5">Route</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((ex) => {
                    const i = ex.intent;
                    const tag = ex.selectedRoute?.tag;
                    return (
                      <tr
                        key={ex.id}
                        className="border-b last:border-0 hover:bg-emerald-500/5 cursor-pointer"
                        onClick={() => onJumpToExecution(ex.id)}
                      >
                        <td className="px-2 py-1.5 font-mono text-[10px]">{shortId(ex.id, 10)}</td>
                        <td className="px-2 py-1.5">
                          <span className="font-mono">{formatMoney(i?.sourceAmount)} {i?.sourceAsset}</span>
                          <ArrowRight className="inline size-2.5 mx-1 text-muted-foreground" />
                          <span className="font-mono">{i?.destinationAsset}</span>
                          <span className="text-[10px] text-muted-foreground ml-1">{i?.sourceCountry}→{i?.destinationCountry}</span>
                        </td>
                        <td className="px-2 py-1.5"><StatusBadge status={ex.status} className="text-[10px] py-0 h-4" /></td>
                        <td className="px-2 py-1.5"><CommitmentBadge status={ex.commitmentStatus} className="text-[10px] py-0 h-4" withTooltip={false} /></td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatDuration(ex.waitedSeconds)}</td>
                        <td className="px-2 py-1.5">
                          {tag ? (
                            <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">{tag}</Badge>
                          ) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent intents */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="size-4 text-emerald-500" />
            Recent intents
            <Badge variant="outline" className="text-[10px] py-0 h-4">{intents.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2">
          {loading && intents.length === 0 ? (
            <Skeleton className="h-20 w-full" />
          ) : intents.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No intents yet.</div>
          ) : (
            <div className="dramp-scroll overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">ID</th>
                    <th className="text-left font-medium px-2 py-1.5">Corridor</th>
                    <th className="text-right font-medium px-2 py-1.5">Amount</th>
                    <th className="text-left font-medium px-2 py-1.5">Risk</th>
                    <th className="text-left font-medium px-2 py-1.5">Policy</th>
                    <th className="text-left font-medium px-2 py-1.5">Status</th>
                    <th className="text-left font-medium px-2 py-1.5">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {intents.map((it) => (
                    <tr key={it.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-1.5 font-mono text-[10px]">{shortId(it.id, 10)}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px]">{it.sourceAsset}:{it.sourceCountry}→{it.destinationAsset}:{it.destinationCountry}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(it.sourceAmount)}</td>
                      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(it.riskTolerance)}</Badge></td>
                      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] py-0 h-4">{prettyEnum(it.executionPolicy)}</Badge></td>
                      <td className="px-2 py-1.5"><StatusBadge status={it.status === "ACTIVE" ? "SEARCHING" : it.status === "COMPLETED" ? "COMPLETED" : it.status} className="text-[10px] py-0 h-4" /></td>
                      <td className="px-2 py-1.5 text-[10px] text-muted-foreground">{formatTimestamp(it.createdAt)}</td>
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
  loading,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  loading?: boolean;
  accent?: "emerald" | "rose";
}) {
  return (
    <Card className="py-3">
      <CardContent className="py-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        {loading ? (
          <Skeleton className="h-6 w-16 mt-1" />
        ) : (
          <div className={cn(
            "text-xl font-mono tabular-nums mt-1 font-semibold",
            accent === "rose" && "text-rose-600 dark:text-rose-400",
            accent === "emerald" && "text-emerald-600 dark:text-emerald-400",
          )}>
            {value}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

