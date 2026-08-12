"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatMoney, toNum } from "./format";
import { Lock, Wallet, TrendingUp, Coins } from "lucide-react";
import type { ProviderVault } from "./types";
import { cn } from "@/lib/utils";

interface VaultCardProps {
  vault: ProviderVault | null | undefined;
  className?: string;
}

export function VaultCard({ vault, className }: VaultCardProps) {
  if (!vault) return null;
  const usable = toNum(vault.usableCollateral);
  const locked = toNum(vault.lockedCollateral);
  const maxExposure = toNum(vault.maxExposure);
  const utilPct = usable > 0 ? Math.min(100, Math.round((locked / usable) * 100)) : 0;
  const ratioPct = Math.round((vault.collateralizationRatio ?? 1.5) * 100);

  return (
    <Card className={cn("py-3", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
          <Lock className="size-3.5 text-teal-500" />
          Collateral vault
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Metric icon={<Wallet className="size-3" />} label="Usable" value={formatMoney(usable)} />
          <Metric icon={<Lock className="size-3" />} label="Locked" value={formatMoney(locked)} highlight={locked > 0} />
          <Metric icon={<TrendingUp className="size-3" />} label="Max exposure" value={formatMoney(maxExposure)} />
          <Metric icon={<Coins className="size-3" />} label="Ratio" value={`${ratioPct}%`} />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">Utilization (locked / usable)</span>
            <span className="font-mono tabular-nums">{utilPct}%</span>
          </div>
          <Progress value={utilPct} className={cn("h-1.5", utilPct > 80 && "[&>div]:bg-rose-500", utilPct > 50 && utilPct <= 80 && "[&>div]:bg-amber-500")} />
        </div>

        {vault.holdings && vault.holdings.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">Holdings</div>
            <div className="flex flex-wrap gap-1.5">
              {vault.holdings.map((h, i) => (
                <Badge key={i} variant="outline" className="text-[10px] py-0 h-4 font-mono">
                  {formatMoney(h.amount)} {h.asset}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
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
    <div className="rounded-md border bg-muted/20 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn("text-sm font-mono tabular-nums mt-0.5", highlight && "text-amber-600 dark:text-amber-400 font-medium")}>
        {value}
      </div>
    </div>
  );
}
