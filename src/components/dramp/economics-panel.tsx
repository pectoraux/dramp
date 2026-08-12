"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import {
  TrendingUp,
  LineChart,
  Wallet,
  FileText,
  Target,
  Activity,
  BarChart3,
  Filter,
  ShieldCheck,
  Coins,
  Building2,
  Lock,
} from "lucide-react";
import { OpportunityFeed } from "./opportunity-feed";
import { PricingIntelligence } from "./pricing-intelligence";
import { ProviderEconomicsView } from "./provider-economics-view";
import { ProviderStatement } from "./provider-statement";
import { QuoteWinLoss } from "./quote-winloss";
import { NetworkHealthView } from "./network-health-view";
import { UnitEconomicsView } from "./unit-economics-view";
import { AcquisitionFunnel } from "./acquisition-funnel";
import { CommitmentsPanel } from "./commitments-panel";
import type { ProvidersResponse } from "./types";

type EconView =
  | "opportunities"
  | "pricing"
  | "provider-economics"
  | "statement"
  | "winloss"
  | "network-health"
  | "unit-economics"
  | "funnel"
  | "commitments";

interface ViewDef {
  key: EconView;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
  operatorPlus?: boolean; // visible to PROVIDER_OPERATOR + ADMIN
  public?: boolean;       // visible to all authenticated users
}

const VIEWS: ViewDef[] = [
  { key: "opportunities", label: "Opportunities", icon: <TrendingUp className="size-3.5" />, public: true },
  { key: "pricing", label: "Pricing", icon: <LineChart className="size-3.5" />, public: true },
  { key: "provider-economics", label: "Provider economics", icon: <Wallet className="size-3.5" />, operatorPlus: true },
  { key: "statement", label: "Provider statement", icon: <FileText className="size-3.5" />, operatorPlus: true },
  { key: "winloss", label: "Quote win/loss", icon: <Target className="size-3.5" />, operatorPlus: true },
  { key: "commitments", label: "Commitments", icon: <ShieldCheck className="size-3.5" />, operatorPlus: true },
  { key: "network-health", label: "Network health", icon: <Activity className="size-3.5" />, adminOnly: true },
  { key: "unit-economics", label: "Unit economics", icon: <BarChart3 className="size-3.5" />, adminOnly: true },
  { key: "funnel", label: "Funnel", icon: <Filter className="size-3.5" />, adminOnly: true },
];

export function EconomicsPanel() {
  const { data: session } = useSession();
  const user = session?.user as any;
  const isAdmin = user?.role === "ADMIN";
  const isOperator = user?.role === "PROVIDER_OPERATOR";

  const visibleViews = VIEWS.filter((v) => {
    if (v.adminOnly) return isAdmin;
    if (v.operatorPlus) return isAdmin || isOperator;
    return true; // public
  });

  const [view, setView] = useState<EconView>(visibleViews[0]?.key ?? "opportunities");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <BarChart3 className="size-5 text-emerald-500" /> Network economics
        </h2>
        <p className="text-xs text-muted-foreground">
          Transparent marketplace intelligence — opportunities, pricing, provider economics, and network health.
          All metrics derived from observable API data.
        </p>
      </div>

      {/* Sub-nav */}
      <div className="flex overflow-x-auto dramp-scroll gap-1 border-b pb-2">
        {visibleViews.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap",
              view === v.key
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {v.icon}
            {v.label}
            {v.adminOnly && (
              <Lock className="size-2.5 text-amber-500" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {view === "opportunities" && <OpportunityFeed />}
      {view === "pricing" && <PricingIntelligence />}

      {(view === "provider-economics" || view === "statement" || view === "winloss") && (
        <ProviderScopedView view={view} />
      )}

      {view === "commitments" && <CommitmentsPanel />}

      {view === "network-health" && isAdmin && <NetworkHealthView />}
      {view === "unit-economics" && isAdmin && <UnitEconomicsView />}
      {view === "funnel" && isAdmin && <AcquisitionFunnel />}
    </div>
  );
}

function ProviderScopedView({ view }: { view: "provider-economics" | "statement" | "winloss" }) {
  const { data: session } = useSession();
  const user = session?.user as any;
  const isAdmin = user?.role === "ADMIN";
  const isOperator = user?.role === "PROVIDER_OPERATOR";
  const boundProviderId = user?.providerId ?? null;

  const [adminProviderId, setAdminProviderId] = useState<string | null>(null);

  // Load providers list (admin can pick any; operator auto-binds).
  const { data: providersData, loading } = usePolling<ProvidersResponse>(
    isAdmin ? "/api/providers" : null,
    10000,
  );
  const providers = providersData?.providers ?? [];

  const providerId = isOperator ? boundProviderId : isAdmin ? adminProviderId : null;

  return (
    <div className="space-y-3">
      {/* Provider selector for admin */}
      {isAdmin && (
        <Card className="py-3">
          <CardContent className="py-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Building2 className="size-3.5 text-emerald-500" />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Provider</span>
              {loading && providers.length === 0 ? (
                <Skeleton className="h-8 w-56" />
              ) : (
                <Select value={adminProviderId ?? ""} onValueChange={setAdminProviderId}>
                  <SelectTrigger className="h-8 w-56 text-xs">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {providerId && (
                <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                  {providers.find((p) => p.id === providerId)?.name ?? providerId.slice(0, 8)}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {isOperator && (
        <Card className="py-2 bg-sky-500/5 border-sky-500/30">
          <CardContent className="py-1">
            <div className="flex items-center gap-2 text-xs text-sky-700 dark:text-sky-300">
              <Coins className="size-3.5" />
              <span>Showing economics for your provider{boundProviderId ? ` · ${providers.find((p) => p.id === boundProviderId)?.name ?? boundProviderId.slice(0, 8)}` : ""}.</span>
            </div>
          </CardContent>
        </Card>
      )}

      {view === "provider-economics" && <ProviderEconomicsView providerId={providerId} />}
      {view === "statement" && <ProviderStatement providerId={providerId} />}
      {view === "winloss" && <QuoteWinLoss providerId={providerId} />}
    </div>
  );
}
