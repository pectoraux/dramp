"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ProviderCard } from "./provider-card";
import { usePolling } from "@/hooks/use-polling";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  formatPercent,
  prettyEnum,
} from "./format";
import { cn } from "@/lib/utils";
import { ShieldAlert, ChevronDown, Coins, Database } from "lucide-react";
import type { ProvidersResponse, SettlementAsset } from "./types";

export function ProvidersPanel() {
  const { data, loading } = usePolling<ProvidersResponse>("/api/providers", 3000);
  const providers = data?.providers ?? [];
  const assets = data?.settlementAssets ?? [];

  return (
    <div className="space-y-4">
      {/* Settlement assets reference */}
      <Collapsible defaultOpen>
        <Card className="py-3">
          <CollapsibleTrigger asChild>
            <CardHeader className="pb-0 cursor-pointer">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Coins className="size-4 text-emerald-500" />
                  Settlement assets reference
                  <Badge variant="outline" className="text-[10px] py-0 h-4">{assets.length}</Badge>
                </span>
                <Button variant="ghost" size="icon" className="size-6">
                  <ChevronDown className="size-4 transition-transform [[data-state=open]>&]:rotate-180" />
                </Button>
              </CardTitle>
              <CardDescription className="text-xs">
                Hard invariant: <span className="font-medium text-rose-600 dark:text-rose-400">VOLATILE_TOKEN assets are never collateral-eligible</span>.
              </CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-3">
              {loading && assets.length === 0 ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="dramp-scroll overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground border-b">
                      <tr>
                        <th className="text-left font-medium px-2 py-1.5">Symbol</th>
                        <th className="text-left font-medium px-2 py-1.5">Type</th>
                        <th className="text-left font-medium px-2 py-1.5">Issuer</th>
                        <th className="text-right font-medium px-2 py-1.5">Volatility</th>
                        <th className="text-right font-medium px-2 py-1.5">Liquidity</th>
                        <th className="text-right font-medium px-2 py-1.5">Peg</th>
                        <th className="text-right font-medium px-2 py-1.5">Incentive</th>
                        <th className="text-center font-medium px-2 py-1.5">Collateral</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assets.map((a) => (
                        <AssetRow key={a.id} asset={a} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Providers grid */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Database className="size-4 text-emerald-500" />
            Liquidity providers
            <Badge variant="outline" className="text-[10px] py-0 h-4">{providers.length}</Badge>
          </h3>
        </div>
        {loading && providers.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-80 w-full rounded-xl" />)}
          </div>
        ) : providers.length === 0 ? (
          <Card className="py-12 border-dashed">
            <CardContent className="text-center text-sm text-muted-foreground">
              No providers found. Seed the marketplace to populate.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {providers.map((p) => (
              <ProviderCard key={p.id} provider={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetRow({ asset }: { asset: SettlementAsset }) {
  const volatile = asset.assetType === "VOLATILE_TOKEN";
  return (
    <tr className={cn("border-b last:border-0 hover:bg-muted/30", volatile && "bg-rose-500/5")}>
      <td className="px-2 py-1.5">
        <div className="font-mono font-medium">{asset.symbol}</div>
        <div className="text-[10px] text-muted-foreground">{asset.network}</div>
      </td>
      <td className="px-2 py-1.5">
        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", volatile ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
          {prettyEnum(asset.assetType)}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">{asset.issuer}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(asset.volatilityScore)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(asset.liquidityScore)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(asset.pegQuality)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
        {asset.incentiveRate ? `${asset.incentiveRate} bps` : "—"}
      </td>
      <td className="px-2 py-1.5 text-center">
        {asset.isEligibleCollateral && !volatile ? (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
            Eligible
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-300 font-medium">
            <ShieldAlert className="size-2.5" /> NOT collateral
          </Badge>
        )}
      </td>
    </tr>
  );
}

