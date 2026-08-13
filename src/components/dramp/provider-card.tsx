"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { EnumBadge, StatusBadge } from "./status-badge";
import { VaultCard } from "./vault-card";
import {
  formatMoney,
  formatRate,
  formatBps,
  formatTimestamp,
  toNum,
  prettyEnum,
  tierBadgeClass,
  tierDotClass,
} from "./format";
import { ReputationExplorer } from "./reputation-explorer";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  Star,
  CheckCircle2,
  XCircle,
  Loader2,
  Building2,
  HandCoins,
} from "lucide-react";
import { useState } from "react";
import type { Provider, ProviderObligation } from "./types";

interface ProviderCardProps {
  provider: Provider;
}

export function ProviderCard({ provider }: ProviderCardProps) {
  const [busy, setBusy] = useState<string | null>(null);

  const suspended = provider.status !== "ACTIVE";
  const reputation = Math.round(toNum(provider.reputationScore) * 100);

  async function actOnLeg(legId: string, kind: "confirm" | "fail") {
    setBusy(`${legId}:${kind}`);
    try {
      const url = kind === "confirm" ? `/api/legs/${legId}/confirm` : `/api/legs/${legId}/fail`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "confirm" ? { actorId: "ui-operator", note: "manual confirmation" } : { reason: "manual failure reported from UI" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success(kind === "confirm" ? "Leg confirmed" : "Leg reported failed", {
        description: `${provider.name} · ${legId.slice(0, 8)}`,
      });
    } catch (err) {
      toast.error(kind === "confirm" ? "Confirm failed" : "Report failed", {
        description: err instanceof Error ? err.message : "unknown error",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <Card className={cn("py-4 h-full", suspended && "opacity-75")}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="size-4 text-emerald-500 shrink-0" />
                <span className="truncate">{provider.name}</span>
              </CardTitle>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <EnumBadge value={provider.providerType} className="text-[10px] py-0 h-4" />
                <EnumBadge value={provider.trustModel} className="text-[10px] py-0 h-4" />
                <Badge variant="outline" className={cn("text-[10px] py-0 h-4", provider.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-500")}>
                  <span className={cn("inline-block size-1.5 rounded-full", provider.status === "ACTIVE" ? "bg-emerald-500" : "bg-zinc-500")} />
                  {prettyEnum(provider.status)}
                </Badge>
              </div>
            </div>
            <div className="flex flex-col items-end shrink-0 gap-1">
              <div className="flex items-center gap-1 text-xs">
                <Star className="size-3 text-amber-500 fill-amber-500" />
                <span className="font-mono tabular-nums font-medium">{reputation}</span>
                <span className="text-muted-foreground text-[10px]">/100</span>
              </div>
              <span className="text-[10px] text-muted-foreground">reputation</span>
              {provider.tier && (
                <Badge variant="outline" className={cn("text-[9px] py-0 h-4 gap-1 mt-0.5", tierBadgeClass(provider.tier))}>
                  <span className={cn("inline-block size-1 rounded-full", tierDotClass(provider.tier))} />
                  {provider.tier}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {/* Reputation explorer trigger */}
          <div className="flex justify-end -mt-1">
            <ReputationExplorer providerId={provider.id} />
          </div>
          {/* capabilities + countries */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {provider.capabilities?.map((c) => (
                <Badge key={c} variant="outline" className="text-[10px] py-0 h-4 bg-muted/40">
                  {prettyEnum(c)}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {provider.countries?.map((c) => (
                <Badge key={c} variant="outline" className="text-[10px] py-0 h-4 border-sky-500/30 bg-sky-500/5 text-sky-600 dark:text-sky-300">
                  {c}
                </Badge>
              ))}
            </div>
          </div>

          {/* Onboarding metadata (operators/admins only — present when the API
              returns the full provider view). */}
          {(provider.jurisdiction || provider.contactEmail || provider.apiIntegrationStatus || (provider.supportedAssets && provider.supportedAssets.length > 0)) && (
            <div className="rounded-md border bg-muted/20 p-2 text-[10px] space-y-1">
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                {provider.jurisdiction && (
                  <div className="text-muted-foreground">Jurisdiction <span className="font-mono text-foreground">{provider.jurisdiction}</span></div>
                )}
                {provider.apiIntegrationStatus && (
                  <div className="text-muted-foreground">API <Badge variant="outline" className={cn("text-[9px] py-0 h-3.5 ml-1", provider.apiIntegrationStatus === "CONNECTED" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : provider.apiIntegrationStatus === "PENDING" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>{provider.apiIntegrationStatus}</Badge></div>
                )}
                {provider.contactEmail && (
                  <div className="text-muted-foreground col-span-2 truncate">Contact <span className="font-mono text-foreground">{provider.contactEmail}</span></div>
                )}
                {provider.supportedAssets && provider.supportedAssets.length > 0 && (
                  <div className="text-muted-foreground col-span-2">Assets <span className="font-mono text-foreground">{provider.supportedAssets.join(", ")}</span></div>
                )}
                {provider.settlementMethods && provider.settlementMethods.length > 0 && (
                  <div className="text-muted-foreground col-span-2">Methods <span className="font-mono text-foreground">{provider.settlementMethods.map(prettyEnum).join(", ")}</span></div>
                )}
              </div>
              {provider.onboardingNote && (
                <div className="text-muted-foreground italic mt-1">"{provider.onboardingNote}"</div>
              )}
            </div>
          )}

          {/* Vault */}
          {provider.vault && <VaultCard vault={provider.vault} />}

          <Separator />

          {/* Offers */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                <HandCoins className="size-3" /> Offers
              </div>
              <Badge variant="outline" className="text-[10px] py-0 h-4">{provider.offers.length}</Badge>
            </div>
            <div className="dramp-scroll max-h-64 overflow-y-auto space-y-1.5 pr-1">
              {provider.offers.length === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-2">No active offers.</div>
              ) : (
                provider.offers.map((o) => {
                  const cap = toNum(o.availableCapacity) + toNum(o.reservedCapacity);
                  const resPct = cap > 0 ? Math.round((toNum(o.reservedCapacity) / cap) * 100) : 0;
                  return (
                    <div key={o.id} className="rounded-md border bg-muted/20 p-2 text-xs">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-mono">
                          {o.sourceAsset}:{o.sourceCountry} → {o.destinationAsset}:{o.destinationCountry}
                        </span>
                        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", o.channelType === "MANUAL" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300")}>
                          {o.channelType}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1.5 text-[10px]">
                        <div>Rate <span className="font-mono">{formatRate(o.rate)}</span></div>
                        <div>Fee <span className="font-mono">{formatBps(o.feeBps)}</span></div>
                        <div>Capacity <span className="font-mono">{formatMoney(o.availableCapacity)}</span></div>
                        <div>Reserved <span className="font-mono">{formatMoney(o.reservedCapacity)} ({resPct}%)</span></div>
                        {o.incentiveBps > 0 && (
                          <div className="col-span-2 text-violet-600 dark:text-violet-300">
                            Incentive <span className="font-mono">{formatBps(o.incentiveBps)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Obligations */}
          {provider.obligations && provider.obligations.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-muted-foreground">Obligations</div>
                  <Badge variant="outline" className="text-[10px] py-0 h-4">{provider.obligations.length}</Badge>
                </div>
                <div className="space-y-1.5">
                  {provider.obligations.map((o) => (
                    <ObligationRow
                      key={o.id}
                      obligation={o}
                      busy={busy}
                      onAct={actOnLeg}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function ObligationRow({
  obligation,
  busy,
  onAct,
}: {
  obligation: ProviderObligation;
  busy: string | null;
  onAct: (legId: string, kind: "confirm" | "fail") => void;
}) {
  // Manual confirm / report-failure only makes sense for obligations whose leg is in-flight.
  // The provider list endpoint returns only CREATED/ACTIVE obligations, so all are actionable.
  // We use the obligation's legId to target the correct leg on the backend.
  const actionable = obligation.status === "ACTIVE" || obligation.status === "CREATED";
  const legId = obligation.legId ?? obligation.id;

  return (
    <div className="rounded-md border bg-muted/20 p-2 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-mono">{formatMoney(obligation.amount)} {obligation.asset}</span>
        <StatusBadge status={obligation.status === "ACTIVE" ? "ORIGIN_PENDING" : obligation.status === "FULFILLED" ? "COMPLETED" : obligation.status === "FAILED" ? "FAILED" : obligation.status === "SLASHED" ? "FAILED" : "INTENT_CREATED"} className="text-[10px] py-0 h-4" />
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">
        due {obligation.dueAt ? formatTimestamp(obligation.dueAt) : "—"}
      </div>
      {actionable && (
        <div className="flex gap-1.5 mt-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] flex-1 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
            disabled={!!busy}
            onClick={() => onAct(legId, "confirm")}
          >
            {busy === `${legId}:confirm` ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] flex-1 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
            disabled={!!busy}
            onClick={() => onAct(legId, "fail")}
          >
            {busy === `${legId}:fail` ? <Loader2 className="size-3 animate-spin" /> : <XCircle className="size-3" />}
            Report failure
          </Button>
        </div>
      )}
    </div>
  );
}


