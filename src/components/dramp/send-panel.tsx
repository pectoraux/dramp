"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RouteCard } from "./route-card";
import {
  ASSET_OPTIONS,
  COUNTRY_OPTIONS,
  RISK_OPTIONS,
  POLICY_OPTIONS,
} from "./format";
import type { PreviewRoute, RoutesPreviewResponse, CreateIntentResponse } from "./types";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  Sparkles,
  Send,
  Loader2,
  ArrowRight,
  Wand2,
  ShieldCheck,
  Scale,
  CircleDollarSign,
  Zap,
  Hourglass,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SendPanelProps {
  onExecutionCreated: (executionId: string, intentId: string) => void;
  disabled?: boolean;
}

const RISK_META: Record<string, { icon: React.ReactNode; desc: string }> = {
  MAX_RELIABILITY: {
    icon: <ShieldCheck className="size-4" />,
    desc: "Prefer the safest counterparties and assets. Higher cost, lowest risk.",
  },
  BALANCED: {
    icon: <Scale className="size-4" />,
    desc: "Optimize across cost, speed and risk. Recommended for most flows.",
  },
  LOWEST_COST: {
    icon: <CircleDollarSign className="size-4" />,
    desc: "Minimize effective cost. Accepts higher counterparty & asset risk.",
  },
};

const POLICY_META: Record<string, { icon: React.ReactNode; desc: string }> = {
  NOW: {
    icon: <Zap className="size-4" />,
    desc: "Execute immediately with the best available route.",
  },
  WAIT_FOR_BETTER: {
    icon: <Hourglass className="size-4" />,
    desc: "Hold in SEARCHING and re-evaluate as new liquidity enters the market.",
  },
};

export function SendPanel({ onExecutionCreated, disabled }: SendPanelProps) {
  const [sourceAmount, setSourceAmount] = useState("1000");
  const [sourceAsset, setSourceAsset] = useState<string>("USD");
  const [sourceCountry, setSourceCountry] = useState<string>("US");
  const [destinationAsset, setDestinationAsset] = useState<string>("EUR");
  const [destinationCountry, setDestinationCountry] = useState<string>("EU");
  const [riskTolerance, setRiskTolerance] = useState<string>("BALANCED");
  const [executionPolicy, setExecutionPolicy] = useState<string>("WAIT_FOR_BETTER");
  const [maxWaitSeconds, setMaxWaitSeconds] = useState<number>(300);

  const [routes, setRoutes] = useState<PreviewRoute[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);

  const canPreview = !!sourceAmount && Number(sourceAmount) > 0 && !disabled;

  async function handlePreview() {
    if (!canPreview) return;
    setPreviewing(true);
    setRoutes(null);
    try {
      const res = await fetch("/api/routes/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAmount: Number(sourceAmount),
          sourceAsset,
          sourceCountry,
          destinationAsset,
          destinationCountry,
          riskTolerance,
        }),
      });
      const json = (await res.json()) as RoutesPreviewResponse;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const sorted = [...(json.routes || [])].sort((a, b) => {
        // BEST first, then non-rejected by effective cost, rejected last
        if (a.tag === "BEST") return -1;
        if (b.tag === "BEST") return 1;
        const ar = a.hardFilterRejection ? 1 : 0;
        const br = b.hardFilterRejection ? 1 : 0;
        if (ar !== br) return ar - br;
        return Number(a.effectiveCost) - Number(b.effectiveCost);
      });
      setRoutes(sorted);
      const live = sorted.filter((r) => !r.hardFilterRejection).length;
      const rej = sorted.length - live;
      toast.success(`Found ${sorted.length} routes`, {
        description: `${live} viable${rej ? `, ${rej} rejected by hard filters` : ""}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "preview failed";
      toast.error("Route preview failed", { description: msg });
      setRoutes([]);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleExecute() {
    if (!routes) return;
    // Execute the BEST route (or first non-rejected).
    const best = routes.find((r) => r.tag === "BEST" && !r.hardFilterRejection)
      ?? routes.find((r) => !r.hardFilterRejection)
      ?? null;
    if (!best) {
      toast.error("No viable route to execute");
      return;
    }
    setExecuting(true);
    try {
      const res = await fetch("/api/intents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAmount: Number(sourceAmount),
          sourceAsset,
          sourceCountry,
          destinationAsset,
          destinationCountry,
          riskTolerance,
          executionPolicy,
          maxWaitSeconds,
          userEmail: "alice@dramp.dev",
          userName: "Alice Treasury",
        }),
      });
      const json = (await res.json()) as CreateIntentResponse;
      if (!res.ok) throw new Error((json as any).error || `HTTP ${res.status}`);
      toast.success("Intent created", {
        description: `Execution ${json.executionId.slice(0, 8)} — ${best.tag} route`,
      });
      onExecutionCreated(json.executionId, json.intentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "create intent failed";
      toast.error("Failed to create intent", { description: msg });
    } finally {
      setExecuting(false);
    }
  }

  function handleGoldenDemo() {
    setSourceAmount("1000");
    setSourceAsset("USD");
    setSourceCountry("US");
    setDestinationAsset("EUR");
    setDestinationCountry("EU");
    setRiskTolerance("BALANCED");
    setExecutionPolicy("WAIT_FOR_BETTER");
    setMaxWaitSeconds(300);
    setRoutes(null);
    toast.info("Golden demo loaded", {
      description: "$1000 USD → EUR · Balanced · Wait for better · 5 min",
    });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,420px)_1fr] gap-6">
      {/* Left: form */}
      <Card className="py-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Send className="size-4 text-emerald-500" />
                Send value
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                Configure a cross-border intent and preview routes.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleGoldenDemo} className="h-7 text-xs">
              <Wand2 className="size-3" /> Golden demo
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="src-amount" className="text-xs">Source amount</Label>
              <div className="relative">
                <Input
                  id="src-amount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={sourceAmount}
                  onChange={(e) => setSourceAmount(e.target.value)}
                  className="pr-16 font-mono"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
                  {sourceAsset}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Source asset</Label>
              <Select value={sourceAsset} onValueChange={setSourceAsset}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Source country</Label>
              <Select value={sourceCountry} onValueChange={setSourceCountry}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-center py-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{sourceAsset} · {sourceCountry}</span>
              <ArrowRight className="size-3" />
              <span className="font-mono">{destinationAsset} · {destinationCountry}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Destination asset</Label>
              <Select value={destinationAsset} onValueChange={setDestinationAsset}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSET_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Destination country</Label>
              <Select value={destinationCountry} onValueChange={setDestinationCountry}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Risk tolerance</Label>
            <RadioGroup value={riskTolerance} onValueChange={setRiskTolerance} className="grid gap-2">
              {RISK_OPTIONS.map((r) => {
                const meta = RISK_META[r];
                const checked = riskTolerance === r;
                return (
                  <Label
                    key={r}
                    htmlFor={`risk-${r}`}
                    className={cn(
                      "flex items-start gap-2.5 rounded-md border p-2.5 cursor-pointer transition-colors",
                      checked
                        ? "border-emerald-500/60 bg-emerald-500/5"
                        : "border-border hover:bg-muted/40",
                    )}
                  >
                    <RadioGroupItem value={r} id={`risk-${r}`} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="text-emerald-500">{meta.icon}</span>
                        {r.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">{meta.desc}</div>
                    </div>
                  </Label>
                );
              })}
            </RadioGroup>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Execution policy</Label>
            <RadioGroup value={executionPolicy} onValueChange={setExecutionPolicy} className="grid grid-cols-2 gap-2">
              {POLICY_OPTIONS.map((p) => {
                const meta = POLICY_META[p];
                const checked = executionPolicy === p;
                return (
                  <Label
                    key={p}
                    htmlFor={`pol-${p}`}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border p-2.5 cursor-pointer transition-colors",
                      checked
                        ? "border-emerald-500/60 bg-emerald-500/5"
                        : "border-border hover:bg-muted/40",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value={p} id={`pol-${p}`} />
                      <span className="text-emerald-500">{meta.icon}</span>
                      <span className="text-sm font-medium">
                        {p === "NOW" ? "Now" : "Wait for better"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground pl-5">{meta.desc}</div>
                  </Label>
                );
              })}
            </RadioGroup>
          </div>

          <div className={cn("space-y-2 transition-opacity", executionPolicy !== "WAIT_FOR_BETTER" && "opacity-50 pointer-events-none")}>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Max wait</Label>
              <span className="text-xs font-mono tabular-nums text-muted-foreground">{maxWaitSeconds}s</span>
            </div>
            <Slider
              value={[maxWaitSeconds]}
              min={0}
              max={600}
              step={15}
              onValueChange={(v) => setMaxWaitSeconds(v[0] ?? 0)}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>0s</span><span>5m</span><span>10m</span>
            </div>
          </div>

          <Button onClick={handlePreview} disabled={!canPreview || previewing} className="w-full" size="lg">
            {previewing ? <><Loader2 className="size-4 animate-spin" /> Previewing…</> : <><Sparkles className="size-4" /> Preview routes</>}
          </Button>
        </CardContent>
      </Card>

      {/* Right: route cards */}
      <div className="space-y-3 min-w-0">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            {routes === null
              ? "No routes previewed yet"
              : `${routes.length} route${routes.length === 1 ? "" : "s"} evaluated`}
          </h3>
          {routes && routes.some((r) => !r.hardFilterRejection) && (
            <Button onClick={handleExecute} disabled={executing || disabled} size="sm">
              {executing ? <><Loader2 className="size-3 animate-spin" /> Creating intent…</> : <><Send className="size-3" /> Execute best</>}
            </Button>
          )}
        </div>

        {previewing && (
          <div className="grid gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-48 w-full rounded-xl" />
            ))}
          </div>
        )}

        {!previewing && routes && routes.length === 0 && (
          <Card className="py-10">
            <CardContent className="text-center text-sm text-muted-foreground">
              No routes found for this corridor. Try a different asset or country.
            </CardContent>
          </Card>
        )}

        {!previewing && routes && routes.length > 0 && (
          <motion.div
            className="grid gap-3 lg:grid-cols-2"
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
          >
            {routes.map((r, i) => (
              <RouteCard
                key={i}
                route={r}
                sourceAsset={sourceAsset}
                destinationAsset={destinationAsset}
                index={i}
                onExecute={handleExecute}
                executing={executing}
                disabled={!!r.hardFilterRejection}
              />
            ))}
          </motion.div>
        )}

        {!previewing && routes === null && (
          <Card className="py-12 border-dashed">
            <CardContent className="text-center space-y-2">
              <div className="mx-auto size-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <Sparkles className="size-5 text-emerald-500" />
              </div>
              <div className="text-sm font-medium">Preview the marketplace</div>
              <div className="text-xs text-muted-foreground max-w-sm mx-auto">
                Configure your corridor on the left, then click <span className="font-medium text-foreground">Preview routes</span> to see all viable paths ranked by cost, speed and risk.
              </div>
              <Button variant="outline" size="sm" onClick={handleGoldenDemo} className="mt-2">
                <Wand2 className="size-3" /> Load golden demo
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
