"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { ShieldAlert, ChevronDown, Coins } from "lucide-react";
import type { SettlementAsset } from "./types";

interface SettlementAssetRegistryResponse {
  assets: (SettlementAsset & {
    activeOfferCount?: number;
    activeCampaignCount?: number;
  })[];
}

interface Props {
  /** When provided, this URL is polled instead of /api/settlement-assets. */
  url?: string;
  /** Polling interval (defaults to 5000ms). */
  intervalMs?: number;
  /** Default open state of the collapsible. */
  defaultOpen?: boolean;
  /** Show the section header (title + count). */
  withHeader?: boolean;
}

// Reusable settlement asset registry table. Pulls from /api/settlement-assets
// (any authenticated user). Hard-invariant highlighting: VOLATILE_TOKEN rows
// are tinted rose and marked "NOT collateral".
export function SettlementAssetRegistry({
  url = "/api/settlement-assets",
  intervalMs = 5000,
  defaultOpen = true,
  withHeader = true,
}: Props) {
  const { data, loading } = usePolling<SettlementAssetRegistryResponse>(url, intervalMs);
  const assets = data?.assets ?? [];

  const body = loading && assets.length === 0 ? (
    <Skeleton className="h-24 w-full" />
  ) : assets.length === 0 ? (
    <div className="text-xs text-muted-foreground text-center py-4">No settlement assets.</div>
  ) : (
    <div className="dramp-scroll overflow-x-auto max-h-96 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground border-b sticky top-0 bg-card">
          <tr>
            <th className="text-left font-medium px-2 py-1.5">Symbol</th>
            <th className="text-left font-medium px-2 py-1.5">Type</th>
            <th className="text-left font-medium px-2 py-1.5">Issuer</th>
            <th className="text-left font-medium px-2 py-1.5">Network</th>
            <th className="text-right font-medium px-2 py-1.5">Vol</th>
            <th className="text-right font-medium px-2 py-1.5">Liq</th>
            <th className="text-right font-medium px-2 py-1.5">Peg</th>
            <th className="text-right font-medium px-2 py-1.5">Incent.</th>
            <th className="text-right font-medium px-2 py-1.5">Offers</th>
            <th className="text-right font-medium px-2 py-1.5">Camps</th>
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
  );

  if (!withHeader) {
    return (
      <Card className="py-3">
        <CardContent className="pt-3">{body}</CardContent>
      </Card>
    );
  }

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card className="py-3">
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-0 cursor-pointer">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Coins className="size-4 text-emerald-500" />
                Settlement asset registry
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
          <CardContent className="pt-3">{body}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function AssetRow({
  asset,
}: {
  asset: SettlementAsset & {
    activeOfferCount?: number;
    activeCampaignCount?: number;
  };
}) {
  const volatile = asset.assetType === "VOLATILE_TOKEN";
  return (
    <tr className={cn("border-b last:border-0 hover:bg-muted/30", volatile && "bg-rose-500/5")}>
      <td className="px-2 py-1.5">
        <div className="font-mono font-medium">{asset.symbol}</div>
      </td>
      <td className="px-2 py-1.5">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] py-0 h-4",
            volatile
              ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
          )}
        >
          {prettyEnum(asset.assetType)}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">{asset.issuer}</td>
      <td className="px-2 py-1.5 text-muted-foreground font-mono text-[10px]">{asset.network}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(asset.volatilityScore)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(asset.liquidityScore)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatPercent(asset.pegQuality)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
        {asset.incentiveRate ? `${asset.incentiveRate} bps` : "—"}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{asset.activeOfferCount ?? "—"}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{asset.activeCampaignCount ?? "—"}</td>
      <td className="px-2 py-1.5 text-center">
        {asset.isEligibleCollateral && !volatile ? (
          <Badge
            variant="outline"
            className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
          >
            Eligible
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-[10px] py-0 h-4 border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-300 font-medium"
          >
            <ShieldAlert className="size-2.5" /> NOT collateral
          </Badge>
        )}
      </td>
    </tr>
  );
}
