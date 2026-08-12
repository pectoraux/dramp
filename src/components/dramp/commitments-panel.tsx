"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { usePolling } from "@/hooks/use-polling";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatMoney, formatDuration, formatTimestamp, toNum, prettyEnum, prettyCorridor } from "./format";
import {
  ShieldCheck,
  Plus,
  Loader2,
  Gauge,
  Activity,
  CheckCircle2,
  XCircle,
  Calendar,
} from "lucide-react";
import type {
  CommitmentsResponse,
  CommitmentItem,
  CommitmentSampleResponse,
  ProvidersResponse,
} from "./types";

const ASSET_OPTIONS = ["USD", "EUR", "USDC", "SC", "WETH"];
const COUNTRY_OPTIONS = ["US", "EU", "GLOBAL", "PH", "NG", "PH"];

function commitmentStatusColor(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
    case "PAUSED":
      return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300";
    case "BREACHED":
      return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300";
    case "EXPIRED":
      return "border-zinc-500/40 bg-zinc-500/10 text-zinc-500";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

interface CommitmentsPanelProps {
  /** When true, render the inner content only (no header). Used inside the Economics panel. */
  bare?: boolean;
}

export function CommitmentsPanel({ bare = false }: CommitmentsPanelProps) {
  const { data: session } = useSession();
  const user = session?.user as any;
  const isAdmin = user?.role === "ADMIN";
  const isOperator = user?.role === "PROVIDER_OPERATOR";
  const boundProviderId = user?.providerId ?? null;

  const [adminProviderId, setAdminProviderId] = useState<string>("");
  const providerIdForUrl = isOperator ? boundProviderId : isAdmin && adminProviderId ? adminProviderId : null;
  const url = providerIdForUrl
    ? `/api/commitments?providerId=${encodeURIComponent(providerIdForUrl)}`
    : isAdmin ? "/api/commitments" : null;

  const { data, loading, refetch } = usePolling<CommitmentsResponse>(url, 5000);

  // For admin "all commitments" view, the API returns them all.
  // For operator, only their own. For admin-with-filter, only that provider's.
  const commitments = data?.commitments ?? [];

  // Providers list for admin selection.
  const { data: providersData } = usePolling<ProvidersResponse>(isAdmin ? "/api/providers" : null, 10000);
  const providers = providersData?.providers ?? [];

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      {!bare && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-medium flex items-center gap-2">
              <ShieldCheck className="size-4 text-emerald-500" />
              Liquidity commitments
            </h3>
            <p className="text-xs text-muted-foreground">
              Provider promises to maintain a service level — distinct from offers. Reliability affects reputation and routing.
            </p>
          </div>
          {(isOperator || isAdmin) && (
            <CreateCommitmentDialog
              open={createOpen}
              onOpenChange={setCreateOpen}
              providers={providers}
              isAdmin={isAdmin}
              defaultProviderId={boundProviderId}
              onCreated={() => {
                refetch();
                setCreateOpen(false);
              }}
            />
          )}
        </div>
      )}

      {/* Admin provider filter */}
      {isAdmin && (
        <Card className="py-3">
          <CardContent className="py-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-[10px] text-muted-foreground">Filter</Label>
              <Select value={adminProviderId} onValueChange={(v) => setAdminProviderId(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-8 w-56 text-xs">
                  <SelectValue placeholder="All providers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All providers</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant="outline" className="text-[10px] py-0 h-4">{commitments.length} commitments</Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {isOperator && !bare && (
        <Badge variant="outline" className="text-[10px] py-0 h-4 border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300">
          Showing your provider's commitments
        </Badge>
      )}

      {/* Commitment cards */}
      {loading && commitments.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[0, 1].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
        </div>
      ) : commitments.length === 0 ? (
        <Card className="py-10 border-dashed">
          <CardContent className="text-center text-sm text-muted-foreground space-y-1">
            <Gauge className="size-5 mx-auto text-muted-foreground/60" />
            <div>No commitments yet</div>
            <div className="text-[10px]">Create a commitment to track liquidity reliability on a corridor.</div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {commitments.map((c) => (
            <CommitmentCard key={c.id} commitment={c} isAdmin={isAdmin} onSampled={refetch} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommitmentCard({
  commitment,
  isAdmin,
  onSampled,
}: {
  commitment: CommitmentItem;
  isAdmin: boolean;
  onSampled: () => void;
}) {
  const [sampling, setSampling] = useState(false);
  const [sampleResult, setSampleResult] = useState<CommitmentSampleResponse | null>(null);

  async function sample() {
    setSampling(true);
    try {
      const res = await fetch(`/api/commitments/${encodeURIComponent(commitment.id)}/sample`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSampleResult(json);
      toast.success("Commitment sampled", {
        description: `${commitment.providerName ?? "Provider"} · ${json.met ? "Met" : "Not met"} · available ${formatMoney(json.available)}`,
      });
      onSampled();
    } catch (err) {
      toast.error("Sample failed", {
        description: err instanceof Error ? err.message : "unknown error",
      });
    } finally {
      setSampling(false);
    }
  }

  const reliabilityPct = Math.round(commitment.reliability * 100);
  const minLiq = toNum(commitment.minimumLiquidity);
  const avgAvail = toNum(commitment.avgAvailable);
  const metRatio = commitment.samples > 0 ? Math.round((commitment.reliability) * 100) : 0;

  return (
    <Card className="py-3 h-full">
      <CardContent className="py-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-mono text-xs truncate">{prettyCorridor(commitment.corridor)}</div>
            {commitment.providerName && (
              <div className="text-[10px] text-muted-foreground truncate">{commitment.providerName}</div>
            )}
          </div>
          <Badge variant="outline" className={cn("text-[10px] py-0 h-4 shrink-0", commitmentStatusColor(commitment.status))}>
            {prettyEnum(commitment.status)}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="rounded-md border bg-muted/20 p-1.5">
            <div className="text-muted-foreground">Min liquidity</div>
            <div className="font-mono tabular-nums text-sm mt-0.5">{formatMoney(minLiq)}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-1.5">
            <div className="text-muted-foreground">Target execution</div>
            <div className="font-mono tabular-nums text-sm mt-0.5">{formatDuration(commitment.targetExecutionSeconds)}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-1.5">
            <div className="text-muted-foreground">Avg available</div>
            <div className="font-mono tabular-nums text-sm mt-0.5">{formatMoney(avgAvail)}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-1.5">
            <div className="text-muted-foreground">Samples</div>
            <div className="font-mono tabular-nums text-sm mt-0.5">{commitment.samples}</div>
          </div>
        </div>

        {/* Reliability bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Reliability</span>
            <span className="font-mono tabular-nums">{reliabilityPct}% · {metRatio}% met</span>
          </div>
          <Progress value={reliabilityPct} className={cn("h-1.5", reliabilityPct >= 75 ? "bg-muted" : reliabilityPct >= 40 ? "bg-muted" : "bg-muted")} />
        </div>

        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="size-3" /> Ends {formatTimestamp(commitment.endDate)}
          </span>
        </div>

        {sampleResult && (
          <div className={cn(
            "rounded-md border p-1.5 text-[10px] flex items-center gap-1.5",
            sampleResult.met
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
              : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
          )}>
            {sampleResult.met ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
            <span>
              Last sample: {sampleResult.met ? "met" : "not met"} · available {formatMoney(sampleResult.available)}
            </span>
          </div>
        )}

        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px]"
            disabled={sampling}
            onClick={sample}
          >
            {sampling ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />}
            Sample now
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function CreateCommitmentDialog({
  open,
  onOpenChange,
  providers,
  isAdmin,
  defaultProviderId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  providers: Array<{ id: string; name: string }>;
  isAdmin: boolean;
  defaultProviderId: string | null;
  onCreated: () => void;
}) {
  const [providerId, setProviderId] = useState<string>(defaultProviderId ?? "");
  const [sourceAsset, setSourceAsset] = useState("USD");
  const [destinationAsset, setDestinationAsset] = useState("EUR");
  const [sourceCountry, setSourceCountry] = useState("US");
  const [destinationCountry, setDestinationCountry] = useState("EU");
  const [minimumLiquidity, setMinimumLiquidity] = useState("10000");
  const [maximumLiquidity, setMaximumLiquidity] = useState("");
  const [targetExecutionSeconds, setTargetExecutionSeconds] = useState("60");
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 3);
    return d.toISOString().slice(0, 10);
  });
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!providerId && isAdmin) {
      toast.error("Select a provider");
      return;
    }
    if (sourceAsset === destinationAsset) {
      toast.error("Source and destination assets must differ");
      return;
    }
    setSubmitting(true);
    try {
      const body: any = {
        sourceAsset,
        destinationAsset,
        sourceCountry,
        destinationCountry,
        minimumLiquidity,
        maximumLiquidity: maximumLiquidity || undefined,
        targetExecutionSeconds: Number(targetExecutionSeconds) || 60,
        endDate,
      };
      if (isAdmin) body.providerId = providerId;

      const res = await fetch("/api/commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Commitment created", {
        description: `${sourceAsset}:${sourceCountry} → ${destinationAsset}:${destinationCountry}`,
      });
      onCreated();
    } catch (err) {
      toast.error("Create failed", {
        description: err instanceof Error ? err.message : "unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="size-3.5" /> New commitment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto dramp-scroll">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-emerald-500" />
            Create liquidity commitment
          </DialogTitle>
          <DialogDescription className="text-xs">
            Commit to maintaining minimum liquidity and target execution time on a corridor.
            Reliability is sampled periodically and affects reputation.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {isAdmin && (
            <div className="space-y-1.5">
              <Label className="text-xs">Provider</Label>
              <Select value={providerId} onValueChange={setProviderId}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select provider" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Source asset</Label>
              <Select value={sourceAsset} onValueChange={setSourceAsset}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Destination asset</Label>
              <Select value={destinationAsset} onValueChange={setDestinationAsset}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Source country</Label>
              <Select value={sourceCountry} onValueChange={setSourceCountry}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Destination country</Label>
              <Select value={destinationCountry} onValueChange={setDestinationCountry}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Minimum liquidity</Label>
              <Input
                type="number"
                step="any"
                min="0"
                value={minimumLiquidity}
                onChange={(e) => setMinimumLiquidity(e.target.value)}
                className="h-9 text-xs"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Maximum liquidity (optional)</Label>
              <Input
                type="number"
                step="any"
                min="0"
                value={maximumLiquidity}
                onChange={(e) => setMaximumLiquidity(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Target execution (seconds)</Label>
              <Input
                type="number"
                min="1"
                value={targetExecutionSeconds}
                onChange={(e) => setTargetExecutionSeconds(e.target.value)}
                className="h-9 text-xs"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">End date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 text-xs"
                required
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={submitting} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Create commitment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
