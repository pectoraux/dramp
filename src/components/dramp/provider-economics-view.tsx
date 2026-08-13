"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { formatMoney, formatRate, toNum } from "./format";
import {
  Wallet,
  Coins,
  Activity,
  Zap,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Shield,
} from "lucide-react";
import type { ProviderEconomicsResponse } from "./types";

export function ProviderEconomicsView({ providerId }: { providerId: string | null }) {
  const { data, loading } = usePolling<ProviderEconomicsResponse | null>(
    providerId ? `/api/economics/provider/${encodeURIComponent(providerId)}` : null,
    5000,
  );

  if (!providerId) {
    return (
      <Card className="py-10 border-dashed">
        <CardContent className="text-center text-sm text-muted-foreground">
          Select a provider to view its economic profile.
        </CardContent>
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const earnings = data.earnings;
  const capital = data.capital;
  const performance = data.performance;
  const efficiency = data.efficiency;

  const completionPct = Math.round(performance.completionRate * 100);
  const committed = toNum(capital.committed);
  const reserved = toNum(capital.reserved);
  const deployed = toNum(capital.deployed);
  const idle = toNum(capital.idle);
  const utilizationPct = committed > 0 ? Math.round((reserved / committed) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-[10px] text-sky-700 dark:text-sky-300 flex items-start gap-1.5">
        <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
        <span>Prototype analytics — derived from ledger entries. Valuations are simulated.</span>
      </div>

      {/* Net earnings headline */}
      <Card className="py-4 border-emerald-500/30">
        <CardContent className="py-1">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                <DollarSign className="size-3 text-emerald-500" />
                Net earnings (lifetime)
              </div>
              <div className="text-3xl font-mono tabular-nums font-semibold mt-0.5 text-emerald-600 dark:text-emerald-400">
                {formatMoney(earnings.netEarnings)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Capital turnover</div>
              <div className="text-lg font-mono tabular-nums">{efficiency.capitalTurnover.toFixed(2)}×</div>
              <div className="text-[10px] text-muted-foreground">
                earnings/liquidity: {formatMoney(efficiency.earningsPerLiquidity, 6)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Earnings breakdown */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wallet className="size-4 text-emerald-500" /> Earnings breakdown
          </CardTitle>
          <CardDescription className="text-xs">All amounts derived from the existing ledger.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <EarningsTile label="Execution fees" value={earnings.executionFees} positive icon={<Coins className="size-3.5" />} />
            <EarningsTile label="Incentives" value={earnings.incentives} positive icon={<TrendingUp className="size-3.5" />} />
            <EarningsTile label="Rebates" value={earnings.rebates} positive icon={<TrendingUp className="size-3.5" />} />
            <EarningsTile label="Penalties" value={earnings.penalties} negative icon={<TrendingDown className="size-3.5" />} />
            <EarningsTile label="Slashing" value={earnings.slashing} negative icon={<TrendingDown className="size-3.5" />} />
            <EarningsTile label="Compensation" value={earnings.compensation} negative icon={<TrendingDown className="size-3.5" />} />
          </div>
        </CardContent>
      </Card>

      {/* Capital metrics */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="size-4 text-emerald-500" /> Capital metrics
          </CardTitle>
          <CardDescription className="text-xs">Committed vs deployed vs idle liquidity.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1 space-y-3">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Utilization</span>
              <span className="font-mono tabular-nums">{utilizationPct}%</span>
            </div>
            <Progress value={utilizationPct} className="h-1.5 bg-muted" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <CapitalTile label="Committed" value={capital.committed} accent="emerald" />
            <CapitalTile label="Deployed" value={capital.deployed} accent="sky" />
            <CapitalTile label="Reserved" value={capital.reserved} accent="amber" />
            <CapitalTile label="Idle" value={capital.idle} accent="zinc" />
          </div>

          <Separator />

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <CapitalTile label="Vault usable" value={capital.vaultUsable} accent="emerald" />
            <CapitalTile label="Vault locked" value={capital.vaultLocked} accent="amber" />
            <CapitalTile label="Max exposure" value={capital.maxExposure} accent="rose" />
          </div>
        </CardContent>
      </Card>

      {/* Performance */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="size-4 text-emerald-500" /> Performance
          </CardTitle>
          <CardDescription className="text-xs">Execution outcomes over lifetime.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total executions</div>
              <div className="text-xl font-mono tabular-nums mt-0.5">{performance.totalExecutions}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Completed</div>
              <div className="text-xl font-mono tabular-nums mt-0.5 text-emerald-600 dark:text-emerald-400">{performance.completed}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Completion rate</div>
              <div className="text-xl font-mono tabular-nums mt-0.5">{completionPct}%</div>
            </div>
          </div>
          <Progress value={completionPct} className="h-1.5 bg-muted mt-3" />
        </CardContent>
      </Card>

      {/* Efficiency */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="size-4 text-emerald-500" /> Capital efficiency
          </CardTitle>
          <CardDescription className="text-xs">{efficiency.note}</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border bg-muted/20 p-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Earnings / committed liquidity</div>
              <div className="text-lg font-mono tabular-nums mt-0.5">{formatMoney(efficiency.earningsPerLiquidity, 6)}</div>
              <div className="text-[10px] text-muted-foreground">Lifetime earnings per unit of committed capital</div>
            </div>
            <div className="rounded-md border bg-muted/20 p-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Capital turnover</div>
              <div className="text-lg font-mono tabular-nums mt-0.5">{efficiency.capitalTurnover.toFixed(2)}×</div>
              <div className="text-[10px] text-muted-foreground">Total execution volume / committed capital</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EarningsTile({
  label,
  value,
  positive,
  negative,
  icon,
}: {
  label: string;
  value: string;
  positive?: boolean;
  negative?: boolean;
  icon?: React.ReactNode;
}) {
  const n = toNum(value);
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className={cn(
        "text-sm font-mono tabular-nums mt-0.5",
        positive && n > 0 && "text-emerald-600 dark:text-emerald-400",
        negative && n > 0 && "text-rose-600 dark:text-rose-400",
        n === 0 && "text-muted-foreground",
      )}>
        {formatMoney(value)}
      </div>
    </div>
  );
}

function CapitalTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "emerald" | "amber" | "sky" | "rose" | "zinc";
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={cn(
        "text-sm font-mono tabular-nums mt-0.5",
        accent === "emerald" && "text-emerald-600 dark:text-emerald-400",
        accent === "amber" && "text-amber-600 dark:text-amber-400",
        accent === "sky" && "text-sky-600 dark:text-sky-400",
        accent === "rose" && "text-rose-600 dark:text-rose-400",
        accent === "zinc" && "text-muted-foreground",
      )}>
        {formatMoney(value)}
      </div>
    </div>
  );
}
