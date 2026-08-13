"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { formatMoney, toNum, prettyCorridor } from "./format";
import { BarChart3, DollarSign, Coins, TrendingUp } from "lucide-react";
import type { UnitEconomicsResponse } from "./types";

export function UnitEconomicsView() {
  const { data, loading } = usePolling<UnitEconomicsResponse>("/api/economics/unit-economics", 5000);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const corridors = data.corridors ?? [];
  const totalVolume = toNum(data.totalVolume);
  const totalFees = toNum(data.totalFees);
  const maxVolume = corridors.reduce((m, c) => Math.max(m, toNum(c.volume)), 0);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <BarChart3 className="size-4 text-emerald-500" />
          Unit economics
        </h3>
        <p className="text-xs text-muted-foreground">
          Total volume, fees, and per-corridor take rate across all completed executions.
        </p>
      </div>

      {/* Top-level stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          icon={<TrendingUp className="size-3.5 text-emerald-500" />}
          label="Total volume"
          value={formatMoney(totalVolume)}
          accent="emerald"
        />
        <StatTile
          icon={<DollarSign className="size-3.5 text-emerald-500" />}
          label="Total fees"
          value={formatMoney(totalFees)}
          accent="emerald"
        />
        <StatTile
          icon={<Coins className="size-3.5 text-sky-500" />}
          label="Completed"
          value={String(data.completedCount)}
          accent="sky"
        />
        <StatTile
          icon={<BarChart3 className="size-3.5 text-amber-500" />}
          label="Avg cost"
          value={`${data.avgCostBps} bps`}
          accent="amber"
        />
      </div>

      {/* Corridor breakdown table */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Corridor breakdown
            <Badge variant="outline" className="text-[10px] py-0 h-4">{corridors.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">Top corridors by volume (max 15).</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {corridors.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6">No completed executions yet.</div>
          ) : (
            <div className="dramp-scroll max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Corridor</th>
                    <th className="text-right font-medium px-2 py-1.5">Volume</th>
                    <th className="text-right font-medium px-2 py-1.5">Count</th>
                    <th className="text-right font-medium px-2 py-1.5">Fees</th>
                    <th className="text-right font-medium px-2 py-1.5">Avg take</th>
                    <th className="text-left font-medium px-2 py-1.5 w-32">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {corridors.map((c, i) => {
                    const vol = toNum(c.volume);
                    const pct = maxVolume > 0 ? (vol / maxVolume) * 100 : 0;
                    return (
                      <tr key={`${c.corridor}-${i}`} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-2 py-1.5 font-mono">{prettyCorridor(c.corridor)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(vol)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{c.count}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">{formatMoney(c.fees)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{c.avgTakeRateBps} bps</td>
                        <td className="px-2 py-1.5">
                          <div className="relative h-1.5 w-full rounded-full bg-muted overflow-hidden">
                            <div
                              className="absolute inset-y-0 left-0 bg-emerald-500 rounded-full"
                              style={{ width: `${Math.max(2, pct)}%` }}
                            />
                          </div>
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
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: "emerald" | "amber" | "sky";
}) {
  return (
    <Card className="py-3">
      <CardContent className="py-1">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className={cn(
          "text-lg font-mono tabular-nums mt-0.5 font-medium",
          accent === "emerald" && "text-emerald-600 dark:text-emerald-400",
          accent === "amber" && "text-amber-600 dark:text-amber-400",
          accent === "sky" && "text-sky-600 dark:text-sky-400",
        )}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
