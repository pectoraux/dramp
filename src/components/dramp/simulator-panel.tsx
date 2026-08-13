"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatMoney, prettyEnum, prettyStatus, prettyCorridor, tierBadgeClass, tierDotClass } from "./format";
import type {
  SimConfig,
  SimScenario,
  SimScenariosResponse,
  SimMetrics,
  SimRunResponse,
  SimCorridor,
  SimProviderResult,
} from "./types";
import {
  Beaker,
  Play,
  Loader2,
  Sparkles,
  RotateCcw,
  Scale,
  CheckCircle2,
  Clock,
  Users,
  Coins,
  TrendingUp,
  Activity,
  Gauge,
  Trophy,
  ArrowRight,
  Zap,
  Diff,
  BarChart3,
  Plus,
  Building2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Equilibrium helpers
// ---------------------------------------------------------------------------
type Equilibrium = "POSITIVE" | "FRAGILE" | "NEGATIVE" | "FORMING" | string;

function equilibriumColor(s: Equilibrium): { cls: string; dot: string; label: string; description: string } {
  switch (s) {
    case "POSITIVE":
      return {
        cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
        dot: "bg-emerald-500",
        label: "Positive",
        description: "Network is in healthy equilibrium — providers are profitable and liquidity is stable.",
      };
    case "FRAGILE":
      return {
        cls: "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300",
        dot: "bg-amber-500",
        label: "Fragile",
        description: "Equilibrium is unstable — providers are exiting or earnings are insufficient.",
      };
    case "NEGATIVE":
      return {
        cls: "border-rose-500/50 bg-rose-500/10 text-rose-600 dark:text-rose-300",
        dot: "bg-rose-500",
        label: "Negative",
        description: "Network is collapsing — too many exits, insufficient liquidity or demand.",
      };
    case "FORMING":
    default:
      return {
        cls: "border-zinc-500/50 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
        dot: "bg-zinc-500",
        label: "Forming",
        description: "Equilibrium is still forming — too few steps to assess.",
      };
  }
}

function providerStatusBadge(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
    case "EXITED":
      return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300";
    case "SUSPENDED":
      return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300";
    default:
      return "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300";
  }
}

function strategyColor(strategy: string): string {
  switch (strategy) {
    case "AGGRESSIVE":
      return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300";
    case "PREMIUM":
      return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300";
    case "MARKET_MAKER":
    case "LIQUIDITY_MAXIMIZER":
      return "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300";
    case "INCENTIVE_SEEKER":
      return "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300";
    case "CONSERVATIVE":
      return "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300";
    case "OPPORTUNISTIC":
    default:
      return "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300";
  }
}

const SHOCK_TYPES: { value: string; label: string }[] = [
  { value: "NONE", label: "None" },
  { value: "LIQUIDITY", label: "Liquidity removal" },
  { value: "PROVIDER_EXIT", label: "Largest provider exit" },
  { value: "ASSET_DEPEG", label: "Stablecoin depeg" },
  { value: "INCENTIVE_END", label: "Incentive campaign end" },
  { value: "DEMAND_SURGE", label: "Demand surge" },
  { value: "REGULATORY", label: "Regulatory suspension" },
];

// ---------------------------------------------------------------------------
// SimulatorPanel — main export
// ---------------------------------------------------------------------------
export function SimulatorPanel() {
  const [scenarios, setScenarios] = useState<SimScenario[]>([]);
  const [defaultConfig, setDefaultConfig] = useState<SimConfig | null>(null);
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [config, setConfig] = useState<SimConfig | null>(null);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [result, setResult] = useState<SimRunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [compareSlotA, setCompareSlotA] = useState<SimRunResponse | null>(null);
  const [compareSlotB, setCompareSlotB] = useState<SimRunResponse | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Fetch scenarios on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/simulator/scenarios");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: SimScenariosResponse = await res.json();
        if (cancelled) return;
        setScenarios(json.scenarios);
        setDefaultConfig(json.defaultConfig);
        setConfig(json.defaultConfig);
      } catch (err) {
        if (!cancelled) {
          toast.error("Failed to load scenarios", {
            description: err instanceof Error ? err.message : "unknown",
          });
        }
      } finally {
        if (!cancelled) setLoadingScenarios(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectScenario = useCallback(
    (scenario: SimScenario) => {
      setSelectedScenarioId(scenario.id);
      setConfig({ ...scenario.config });
      setResult(null);
      toast.success(`Loaded scenario: ${scenario.name}`, {
        description: scenario.description,
      });
    },
    [],
  );

  const handleResetConfig = useCallback(() => {
    if (defaultConfig) {
      setConfig({ ...defaultConfig });
      setSelectedScenarioId(null);
    }
  }, [defaultConfig]);

  const handleRun = useCallback(async () => {
    if (!config) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/simulator/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setResult(json as SimRunResponse);
      toast.success("Simulation complete", {
        description: `${json.totalIntents} intents · ${json.metrics.activeProviders} active providers · ${json.metrics.equilibriumStatus}`,
      });
      // Scroll to results.
      setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    } catch (err) {
      toast.error("Simulation failed", {
        description: err instanceof Error ? err.message : "unknown",
      });
    } finally {
      setRunning(false);
    }
  }, [config]);

  const handleLoadToCompareSlot = useCallback(
    (slot: "A" | "B") => {
      if (!result) return;
      if (slot === "A") {
        setCompareSlotA(result);
        toast.success("Loaded into comparison slot A");
      } else {
        setCompareSlotB(result);
        toast.success("Loaded into comparison slot B");
      }
    },
    [result],
  );

  const handleRunBoth = useCallback(async (scenarioIdA: string, scenarioIdB: string) => {
    const sA = scenarios.find((s) => s.id === scenarioIdA);
    const sB = scenarios.find((s) => s.id === scenarioIdB);
    if (!sA || !sB) {
      toast.error("Select two scenarios to compare");
      return null;
    }
    try {
      const [rA, rB] = await Promise.all([
        fetch("/api/simulator/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sA.config),
        }).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
          return j as SimRunResponse;
        }),
        fetch("/api/simulator/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sB.config),
        }).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
          return j as SimRunResponse;
        }),
      ]);
      setCompareSlotA(rA);
      setCompareSlotB(rB);
      toast.success("Both simulations complete", {
        description: `${sA.name} vs ${sB.name}`,
      });
      return { a: rA, b: rB } as const;
    } catch (err) {
      toast.error("Comparison run failed", {
        description: err instanceof Error ? err.message : "unknown",
      });
      return null;
    }
  }, [scenarios]);

  const handleClearCompare = useCallback(() => {
    setCompareSlotA(null);
    setCompareSlotB(null);
  }, []);

  if (loadingScenarios || !config) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Tabs defaultValue="single" className="w-full">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <TabsList>
            <TabsTrigger value="single" className="gap-1.5">
              <Beaker className="size-3.5" /> Single run
            </TabsTrigger>
            <TabsTrigger value="compare" className="gap-1.5">
              <Diff className="size-3.5" /> Comparison
            </TabsTrigger>
          </TabsList>
          <div className="text-[11px] text-muted-foreground">
            Network simulator · in-memory · does not touch production DB
          </div>
        </div>

        <TabsContent value="single" className="space-y-5 mt-4">
          {/* Scenario picker */}
          <ScenarioPicker
            scenarios={scenarios}
            selectedId={selectedScenarioId}
            onSelect={handleSelectScenario}
          />

          {/* Config form + run */}
          <ConfigForm
            config={config}
            onChange={setConfig}
            onRun={handleRun}
            onReset={handleResetConfig}
            running={running}
            selectedScenarioId={selectedScenarioId}
          />

          {/* Results */}
          <div ref={resultRef}>
            {running ? (
              <ResultsSkeleton />
            ) : result ? (
              <ResultsDashboard
                result={result}
                onLoadToCompare={handleLoadToCompareSlot}
                compareA={!!compareSlotA}
                compareB={!!compareSlotB}
              />
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="compare" className="mt-4">
          <ComparisonView
            slotA={compareSlotA}
            slotB={compareSlotB}
            onRunBoth={handleRunBoth}
            onClear={handleClearCompare}
            scenarios={scenarios}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenario picker
// ---------------------------------------------------------------------------
function ScenarioPicker({
  scenarios,
  selectedId,
  onSelect,
}: {
  scenarios: SimScenario[];
  selectedId: string | null;
  onSelect: (s: SimScenario) => void;
}) {
  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="size-4 text-emerald-500" /> Scenario library
          <Badge variant="outline" className="text-[10px] py-0 h-4">{scenarios.length}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          Click a scenario to load its config. Edit fields below before running.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {scenarios.map((s) => {
            const active = selectedId === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s)}
                className={cn(
                  "text-left rounded-lg border p-3 transition-all hover:shadow-sm hover:-translate-y-0.5",
                  active
                    ? "border-emerald-500/60 bg-emerald-500/5 shadow-sm ring-1 ring-emerald-500/30"
                    : "border-border bg-card hover:border-emerald-500/30 hover:bg-muted/30",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-sm leading-tight">{s.name}</div>
                  {active && (
                    <Badge variant="outline" className="text-[9px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 shrink-0">
                      Selected
                    </Badge>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                  {s.description}
                </div>
                <div className="flex items-center gap-1 mt-2 flex-wrap text-[10px]">
                  <Badge variant="outline" className="text-[9px] py-0 h-4 font-mono">
                    seed {s.config.seed}
                  </Badge>
                  <Badge variant="outline" className="text-[9px] py-0 h-4 font-mono">
                    {s.config.totalSteps} steps
                  </Badge>
                  <Badge variant="outline" className="text-[9px] py-0 h-4 font-mono">
                    {s.config.initialProviders} prov
                  </Badge>
                  {s.config.shockType && s.config.shockType !== "NONE" && (
                    <Badge variant="outline" className="text-[9px] py-0 h-4 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300">
                      shock @ {s.config.shockStep}
                    </Badge>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Config form
// ---------------------------------------------------------------------------
function ConfigForm({
  config,
  onChange,
  onRun,
  onReset,
  running,
  selectedScenarioId,
}: {
  config: SimConfig;
  onChange: (c: SimConfig) => void;
  onRun: () => void;
  onReset: () => void;
  running: boolean;
  selectedScenarioId: string | null;
}) {
  const update = useCallback(
    <K extends keyof SimConfig>(key: K, value: SimConfig[K]) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Gauge className="size-4 text-emerald-500" /> Configuration
              {selectedScenarioId && (
                <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                  scenario preset
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              All fields editable. Run will execute {config.totalSteps} simulated steps.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onReset} className="gap-1.5">
              <RotateCcw className="size-3.5" /> Reset
            </Button>
            <Button
              onClick={onRun}
              disabled={running}
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            >
              {running ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Simulating…
                </>
              ) : (
                <>
                  <Play className="size-3.5" /> Run simulation
                </>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Numeric grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <NumberField
            label="Seed"
            value={config.seed}
            onChange={(v) => update("seed", v)}
            help="Reproducibility seed"
            min={0}
          />
          <NumberField
            label="Total steps"
            value={config.totalSteps}
            onChange={(v) => update("totalSteps", v)}
            help="Simulation length"
            min={1}
            max={500}
          />
          <NumberField
            label="Initial providers"
            value={config.initialProviders}
            onChange={(v) => update("initialProviders", v)}
            help="Providers at step 0"
            min={1}
            max={200}
          />
          <NumberField
            label="Provider growth rate"
            value={config.providerGrowthRate}
            step={0.01}
            onChange={(v) => update("providerGrowthRate", v)}
            help="Per-step entry probability"
            min={0}
            max={1}
          />
          <NumberField
            label="Demand volume"
            value={config.demandVolume}
            onChange={(v) => update("demandVolume", v)}
            help="Intents per step (baseline)"
            min={0}
          />
          <NumberField
            label="Baseline cost (bps)"
            value={config.baselineCostBps}
            onChange={(v) => update("baselineCostBps", v)}
            help="Conventional remittance baseline"
            min={0}
          />
        </div>

        {/* Shocks */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Shock type</Label>
            <Select
              value={config.shockType ?? "NONE"}
              onValueChange={(v) => update("shockType", v === "NONE" ? null : v)}
            >
              <SelectTrigger className="w-full h-9 text-xs">
                <SelectValue placeholder="Select shock" />
              </SelectTrigger>
              <SelectContent>
                {SHOCK_TYPES.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <NumberField
            label="Shock step"
            value={config.shockStep}
            onChange={(v) => update("shockStep", v)}
            help="Step at which shock fires"
            min={1}
          />
          <NumberField
            label="Shock magnitude"
            value={config.shockMagnitude}
            step={0.05}
            onChange={(v) => update("shockMagnitude", v)}
            help="Fraction / multiplier"
            min={0}
          />
        </div>

        {/* Toggle switches */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <ToggleField
            label="Reputation"
            description="Reputation affects routing"
            checked={config.enableReputation}
            onChange={(v) => update("enableReputation", v)}
          />
          <ToggleField
            label="Commitments"
            description="Provider liquidity commitments"
            checked={config.enableCommitments}
            onChange={(v) => update("enableCommitments", v)}
          />
          <ToggleField
            label="Incentives"
            description="Settlement asset incentives"
            checked={config.enableIncentives}
            onChange={(v) => update("enableIncentives", v)}
          />
        </div>

        {running && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-emerald-500" />
            <span>Running simulation ({config.totalSteps} steps)…</span>
            <Progress value={70} className="h-1.5 flex-1 max-w-xs" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NumberField({
  label,
  value,
  onChange,
  help,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(Number.isFinite(v) ? v : 0);
        }}
        className="h-9 text-xs font-mono tabular-nums"
      />
      {help && <p className="text-[10px] text-muted-foreground">{help}</p>}
    </div>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 flex items-start justify-between gap-3 transition-colors",
        checked ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-muted/20",
      )}
    >
      <div>
        <div className="text-xs font-medium">{label}</div>
        <div className="text-[10px] text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results skeleton
// ---------------------------------------------------------------------------
function ResultsSkeleton() {
  return (
    <div className="space-y-4">
      <Card className="py-3">
        <CardHeader className="pb-2">
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-72 w-full" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results dashboard
// ---------------------------------------------------------------------------
function ResultsDashboard({
  result,
  onLoadToCompare,
  compareA,
  compareB,
}: {
  result: SimRunResponse;
  onLoadToCompare: (slot: "A" | "B") => void;
  compareA: boolean;
  compareB: boolean;
}) {
  const { metrics, config, metricsHistory, corridors, providers } = result;

  return (
    <div className="space-y-4">
      {/* Equilibrium banner */}
      <EquilibriumBanner metrics={metrics} config={config} />

      {/* Stat cards */}
      <StatCardGrid metrics={metrics} baselineCostBps={config.baselineCostBps} />

      {/* Metrics history chart */}
      <MetricsHistoryChart history={metricsHistory} totalSteps={config.totalSteps} />

      {/* Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CorridorTable corridors={corridors} />
        <ProviderLeaderboard providers={providers} />
      </div>

      {/* Compare CTA */}
      <Card className="py-3">
        <CardContent className="flex items-center justify-between gap-3 flex-wrap py-1">
          <div className="text-xs">
            <div className="font-medium">Compare this run side-by-side</div>
            <div className="text-muted-foreground">
              Load this result into a comparison slot, then run another scenario.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={compareA ? "outline" : "default"}
              size="sm"
              onClick={() => onLoadToCompare("A")}
              className="gap-1.5"
            >
              {compareA ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Plus className="size-3.5" />}
              Slot A {compareA && "✓"}
            </Button>
            <Button
              variant={compareB ? "outline" : "default"}
              size="sm"
              onClick={() => onLoadToCompare("B")}
              className="gap-1.5"
            >
              {compareB ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Plus className="size-3.5" />}
              Slot B {compareB && "✓"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EquilibriumBanner({ metrics, config }: { metrics: SimMetrics; config: SimConfig }) {
  const eq = equilibriumColor(metrics.equilibriumStatus);
  return (
    <Card className={cn("py-3 border-2", eq.cls)}>
      <CardContent className="py-1 flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className={cn("size-9 rounded-full flex items-center justify-center", "bg-background/40")}>
            <Activity className={cn("size-5", eq.dot.replace("bg-", "text-"))} />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{eq.label} equilibrium</span>
              <span className={cn("size-2 rounded-full", eq.dot)} />
              <Badge variant="outline" className={cn("text-[10px] py-0 h-4", eq.cls)}>
                {metrics.equilibriumStatus}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 max-w-xl">{eq.description}</div>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground text-right">
          <div>
            seed <span className="font-mono text-foreground">{config.seed}</span> · {config.totalSteps} steps
          </div>
          <div>
            shock: <span className="font-mono text-foreground">{config.shockType ?? "none"}</span>
            {config.shockType ? ` @ step ${config.shockStep} (×${config.shockMagnitude})` : ""}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------
interface StatCardDef {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: "emerald" | "rose" | "amber" | "sky" | "violet" | "zinc";
  sub?: string;
}

function StatCardGrid({
  metrics,
  baselineCostBps,
}: {
  metrics: SimMetrics;
  baselineCostBps: number;
}) {
  const userCards: StatCardDef[] = [
    {
      label: "Total intents",
      value: formatMoney(metrics.totalIntents, 0),
      icon: <Users className="size-4 text-sky-500" />,
      sub: `${metrics.completedIntents} done · ${metrics.expiredIntents} exp · ${metrics.failedIntents} fail`,
    },
    {
      label: "Completion rate",
      value: `${metrics.completionRate.toFixed(1)}%`,
      icon: <CheckCircle2 className="size-4 text-emerald-500" />,
      accent: "emerald",
      sub: `${metrics.completedIntents}/${metrics.totalIntents} executed`,
    },
    {
      label: "Avg cost",
      value: `${metrics.avgCostBps.toFixed(1)} bps`,
      icon: <Coins className="size-4 text-amber-500" />,
      accent: metrics.avgCostBps < baselineCostBps ? "emerald" : "rose",
      sub: `vs ${baselineCostBps} bps baseline`,
    },
    {
      label: "Avg wait",
      value: `${metrics.avgWaitSteps.toFixed(1)} steps`,
      icon: <Clock className="size-4 text-sky-500" />,
      sub: `p50 ${metrics.p50ExecutionSteps} · p95 ${metrics.p95ExecutionSteps}`,
    },
  ];

  const providerCards: StatCardDef[] = [
    {
      label: "Active providers",
      value: formatMoney(metrics.activeProviders, 0),
      icon: <Building2 className="size-4 text-emerald-500" />,
      sub: `${metrics.exitedProviders} exited`,
    },
    {
      label: "Avg earnings",
      value: formatMoney(metrics.avgProviderEarnings),
      icon: <TrendingUp className="size-4 text-emerald-500" />,
      accent: "emerald",
      sub: `median ${formatMoney(metrics.medianProviderEarnings)}`,
    },
    {
      label: "Avg utilization",
      value: `${metrics.avgUtilization.toFixed(1)}%`,
      icon: <Gauge className="size-4 text-amber-500" />,
      accent: metrics.avgUtilization > 80 ? "rose" : "amber",
      sub: "reserved / available",
    },
    {
      label: "Provider volume",
      value: formatMoney(metrics.totalProviderVolume),
      icon: <Coins className="size-4 text-emerald-500" />,
      sub: "total routed",
    },
  ];

  const networkCards: StatCardDef[] = [
    {
      label: "Total liquidity",
      value: formatMoney(metrics.totalLiquidity),
      icon: <Coins className="size-4 text-emerald-500" />,
      sub: "active offers",
    },
    {
      label: "Market concentration",
      value: metrics.marketConcentration.toFixed(3),
      icon: <Scale className="size-4 text-amber-500" />,
      accent: metrics.marketConcentration > 0.5 ? "rose" : metrics.marketConcentration > 0.25 ? "amber" : "emerald",
      sub: "HHI (0=perfect, 1=monopoly)",
    },
    {
      label: "Protocol revenue",
      value: formatMoney(metrics.totalProtocolRevenue),
      icon: <TrendingUp className="size-4 text-emerald-500" />,
      accent: "emerald",
      sub: "fees collected",
    },
    {
      label: "Incentive spend",
      value: formatMoney(metrics.totalIncentiveSpend),
      icon: <Zap className="size-4 text-violet-500" />,
      accent: "violet",
      sub: "campaigns paid",
    },
  ];

  return (
    <div className="space-y-3">
      <StatGroup title="User outcomes" icon={<Users className="size-3.5 text-sky-500" />} cards={userCards} />
      <StatGroup title="Provider outcomes" icon={<Building2 className="size-3.5 text-emerald-500" />} cards={providerCards} />
      <StatGroup title="Network outcomes" icon={<Activity className="size-3.5 text-amber-500" />} cards={networkCards} />
    </div>
  );
}

function StatGroup({
  title,
  icon,
  cards,
}: {
  title: string;
  icon: React.ReactNode;
  cards: StatCardDef[];
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {cards.map((c) => (
          <Card key={c.label} className="py-3">
            <CardContent className="py-1">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {c.icon}
                {c.label}
              </div>
              <div
                className={cn(
                  "text-lg font-mono tabular-nums mt-1 font-semibold",
                  c.accent === "emerald" && "text-emerald-600 dark:text-emerald-400",
                  c.accent === "rose" && "text-rose-600 dark:text-rose-400",
                  c.accent === "amber" && "text-amber-600 dark:text-amber-400",
                  c.accent === "sky" && "text-sky-600 dark:text-sky-400",
                  c.accent === "violet" && "text-violet-600 dark:text-violet-400",
                )}
              >
                {c.value}
              </div>
              {c.sub && <div className="text-[10px] text-muted-foreground mt-0.5">{c.sub}</div>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics history chart (Recharts)
// ---------------------------------------------------------------------------
function MetricsHistoryChart({
  history,
  totalSteps,
}: {
  history: SimMetrics[];
  totalSteps: number;
}) {
  // History records are emitted every 5 steps + final. Reconstruct step numbers
  // using index × 5, capped at totalSteps.
  const data = useMemo(() => {
    return history.map((m, i) => {
      // The engine emits every 5 steps + final; approximate the step.
      const step = i === history.length - 1 ? totalSteps : (i + 1) * 5;
      return {
        step,
        avgCostBps: m.avgCostBps,
        completionRate: m.completionRate,
        activeProviders: m.activeProviders,
        totalLiquidity: m.totalLiquidity,
      };
    });
  }, [history, totalSteps]);

  const hasData = data.length > 0;

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="size-4 text-emerald-500" /> Metrics history
          <Badge variant="outline" className="text-[10px] py-0 h-4">{data.length} samples</Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          Tracked every 5 steps. Hover lines for detail.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="text-xs text-muted-foreground text-center py-12">No metrics history.</div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 5, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis
                  dataKey="step"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  label={{ value: "step", position: "insideBottom", offset: -2, fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  yAxisId="left"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => {
                    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
                    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
                    return String(v);
                  }}
                />
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                    color: "hsl(var(--popover-foreground))",
                  }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))", fontSize: "11px" }}
                  formatter={(value: number | string, name: string) => {
                    const v = typeof value === "string" ? Number(value) : value;
                    if (name === "totalLiquidity") return [formatMoney(v), "Liquidity"];
                    if (name === "avgCostBps") return [`${v.toFixed(1)} bps`, "Avg cost"];
                    if (name === "completionRate") return [`${v.toFixed(1)}%`, "Completion"];
                    if (name === "activeProviders") return [String(v), "Providers"];
                    return [String(v), name];
                  }}
                  labelFormatter={(label) => `step ${label}`}
                />
                <Legend
                  wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}
                  formatter={(value) => {
                    switch (value) {
                      case "avgCostBps": return "Avg cost (bps)";
                      case "completionRate": return "Completion (%)";
                      case "activeProviders": return "Active providers";
                      case "totalLiquidity": return "Total liquidity";
                      default: return value;
                    }
                  }}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="avgCostBps"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="completionRate"
                  stroke="#0ea5e9"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="activeProviders"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="totalLiquidity"
                  stroke="#a78bfa"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Corridor analysis table
// ---------------------------------------------------------------------------
function CorridorTable({ corridors }: { corridors: SimCorridor[] }) {
  const sorted = useMemo(() => [...corridors].sort((a, b) => b.demand - a.demand), [corridors]);
  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ArrowRight className="size-4 text-emerald-500" /> Corridor analysis
          <Badge variant="outline" className="text-[10px] py-0 h-4">{sorted.length}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">Sorted by demand. Top 20 corridors.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {sorted.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No corridor activity.</div>
        ) : (
          <div className="dramp-scroll overflow-x-auto max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="sticky top-0 bg-card z-10">
                  <TableHead className="text-[11px]">Corridor</TableHead>
                  <TableHead className="text-[11px] text-right">Demand</TableHead>
                  <TableHead className="text-[11px] text-right">Done</TableHead>
                  <TableHead className="text-[11px] text-right">Failed</TableHead>
                  <TableHead className="text-[11px] text-right">Avg cost (bps)</TableHead>
                  <TableHead className="text-[11px] text-right">Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((c) => {
                  const rate = c.demand > 0 ? (c.completed / c.demand) * 100 : 0;
                  return (
                    <TableRow key={c.corridor}>
                      <TableCell className="text-[11px] font-mono py-1.5">
                        {prettyCorridor(c.corridor)}
                      </TableCell>
                      <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5">{c.demand}</TableCell>
                      <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5 text-emerald-600 dark:text-emerald-400">{c.completed}</TableCell>
                      <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5 text-rose-600 dark:text-rose-400">{c.failed}</TableCell>
                      <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5">{c.avgCostBps.toFixed(1)}</TableCell>
                      <TableCell className="text-[11px] text-right py-1.5 w-24">
                        <div className="flex items-center gap-1.5 justify-end">
                          <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full",
                                rate >= 80 ? "bg-emerald-500" : rate >= 40 ? "bg-amber-500" : "bg-rose-500",
                              )}
                              style={{ width: `${Math.min(100, rate)}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-mono tabular-nums w-9 text-right">{rate.toFixed(0)}%</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Provider leaderboard
// ---------------------------------------------------------------------------
function ProviderLeaderboard({ providers }: { providers: SimProviderResult[] }) {
  const sorted = useMemo(() => [...providers].sort((a, b) => b.volume - a.volume), [providers]);
  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Trophy className="size-4 text-amber-500" /> Provider leaderboard
          <Badge variant="outline" className="text-[10px] py-0 h-4">{sorted.length}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">Sorted by volume.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {sorted.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No providers.</div>
        ) : (
          <div className="dramp-scroll overflow-x-auto max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="sticky top-0 bg-card z-10">
                  <TableHead className="text-[11px]">#</TableHead>
                  <TableHead className="text-[11px]">Provider</TableHead>
                  <TableHead className="text-[11px]">Tier</TableHead>
                  <TableHead className="text-[11px]">Status</TableHead>
                  <TableHead className="text-[11px] text-right">Rep</TableHead>
                  <TableHead className="text-[11px] text-right">Volume</TableHead>
                  <TableHead className="text-[11px] text-right">Earnings</TableHead>
                  <TableHead className="text-[11px] text-right">Exec</TableHead>
                  <TableHead className="text-[11px] text-right">Util</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((p, i) => (
                  <TableRow key={`${p.name}-${i}`} className={p.status === "EXITED" ? "opacity-60" : ""}>
                    <TableCell className="text-[11px] text-muted-foreground font-mono py-1.5">{i + 1}</TableCell>
                    <TableCell className="py-1.5">
                      <div className="text-[11px] font-medium">{p.name}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Badge variant="outline" className="text-[9px] py-0 h-3.5 px-1">{prettyEnum(p.type)}</Badge>
                        <Badge variant="outline" className={cn("text-[9px] py-0 h-3.5 px-1", strategyColor(p.strategy))}>
                          {prettyEnum(p.strategy)}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Badge variant="outline" className={cn("text-[9px] py-0 h-4 px-1", tierBadgeClass(p.tier))}>
                        <span className={cn("size-1.5 rounded-full", tierDotClass(p.tier))} />
                        {prettyEnum(p.tier)}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Badge variant="outline" className={cn("text-[9px] py-0 h-4 px-1", providerStatusBadge(p.status))}>
                        {prettyStatus(p.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5">{(p.reputation * 100).toFixed(0)}%</TableCell>
                    <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5">{formatMoney(p.volume)}</TableCell>
                    <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5 text-emerald-600 dark:text-emerald-400">{formatMoney(p.earnings)}</TableCell>
                    <TableCell className="text-[11px] text-right font-mono tabular-nums py-1.5">{p.executions}</TableCell>
                    <TableCell className="text-[11px] text-right py-1.5 w-20">
                      <div className="flex items-center gap-1.5 justify-end">
                        <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              p.utilization > 80 ? "bg-rose-500" : p.utilization > 50 ? "bg-amber-500" : "bg-emerald-500",
                            )}
                            style={{ width: `${Math.min(100, p.utilization)}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono tabular-nums w-8 text-right">{p.utilization.toFixed(0)}%</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Comparison view
// ---------------------------------------------------------------------------
function ComparisonView({
  slotA,
  slotB,
  onRunBoth,
  onClear,
  scenarios,
}: {
  slotA: SimRunResponse | null;
  slotB: SimRunResponse | null;
  onRunBoth: (scenarioIdA: string, scenarioIdB: string) => Promise<{ a: SimRunResponse; b: SimRunResponse } | null>;
  onClear: () => void;
  scenarios: SimScenario[];
}) {
  const [presetA, setPresetA] = useState<string>(scenarios[0]?.id ?? "");
  const [presetB, setPresetB] = useState<string>(scenarios[1]?.id ?? "");
  const [runningBoth, setRunningBoth] = useState(false);

  useEffect(() => {
    if (!presetA && scenarios[0]) setPresetA(scenarios[0].id);
    if (!presetB && scenarios[1]) setPresetB(scenarios[1].id);
  }, [scenarios, presetA, presetB]);

  const runBoth = useCallback(async () => {
    setRunningBoth(true);
    try {
      await onRunBoth(presetA, presetB);
    } finally {
      setRunningBoth(false);
    }
  }, [presetA, presetB, onRunBoth]);

  const a = slotA;
  const b = slotB;

  return (
    <div className="space-y-4">
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Diff className="size-4 text-emerald-500" /> Compare two scenarios
          </CardTitle>
          <CardDescription className="text-xs">
            Run two presets head-to-head and view key metrics side-by-side.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Scenario A</Label>
              <Select value={presetA} onValueChange={setPresetA}>
                <SelectTrigger className="w-full h-9 text-xs">
                  <SelectValue placeholder="Select A" />
                </SelectTrigger>
                <SelectContent>
                  {scenarios.map((s) => (
                    <SelectItem key={s.id} value={s.id} className="text-xs">
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Scenario B</Label>
              <Select value={presetB} onValueChange={setPresetB}>
                <SelectTrigger className="w-full h-9 text-xs">
                  <SelectValue placeholder="Select B" />
                </SelectTrigger>
                <SelectContent>
                  {scenarios.map((s) => (
                    <SelectItem key={s.id} value={s.id} className="text-xs">
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={runBoth}
              disabled={runningBoth || !presetA || !presetB}
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            >
              {runningBoth ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Running both…
                </>
              ) : (
                <>
                  <Play className="size-3.5" /> Run both
                </>
              )}
            </Button>
            {(a || b) && (
              <Button
                variant="outline"
                size="sm"
                onClick={onClear}
                className="gap-1.5"
              >
                <RotateCcw className="size-3.5" /> Clear
              </Button>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto hidden sm:block">
              Tip: from the Single run tab, click &ldquo;Slot A&rdquo; / &ldquo;Slot B&rdquo; to load results here too.
            </span>
          </div>
        </CardContent>
      </Card>

      {!a && !b ? (
        <Card className="py-12">
          <CardContent className="text-center text-xs text-muted-foreground py-1">
            <Diff className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            Run two scenarios to see them compared here.
          </CardContent>
        </Card>
      ) : (
        <ComparisonTable a={a} b={b} />
      )}
    </div>
  );
}

function ComparisonTable({ a, b }: { a: SimRunResponse | null; b: SimRunResponse | null }) {
  const rows: {
    label: string;
    av: string;
    bv: string;
    diff?: string;
    better?: "a" | "b" | "tie";
    help?: string;
  }[] = [];

  const m_a = a?.metrics;
  const m_b = b?.metrics;

  function fmt(x: number | undefined, digits = 2): string {
    return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
  }
  function betterForLower(av: number, bv: number): "a" | "b" | "tie" {
    if (av === bv) return "tie";
    return av < bv ? "a" : "b";
  }
  function betterForHigher(av: number, bv: number): "a" | "b" | "tie" {
    if (av === bv) return "tie";
    return av > bv ? "a" : "b";
  }
  function diffPct(av: number, bv: number): string {
    if (bv === 0) return av === 0 ? "0%" : "+∞%";
    const d = ((av - bv) / Math.abs(bv)) * 100;
    const sign = d > 0 ? "+" : "";
    return `${sign}${d.toFixed(1)}%`;
  }
  function diffAbs(av: number, bv: number): string {
    const d = av - bv;
    const sign = d > 0 ? "+" : "";
    return `${sign}${d.toFixed(2)}`;
  }

  rows.push({
    label: "Equilibrium",
    av: m_a ? equilibriumColor(m_a.equilibriumStatus).label : "—",
    bv: m_b ? equilibriumColor(m_b.equilibriumStatus).label : "—",
    help: "POSITIVE > FRAGILE > FORMING > NEGATIVE",
  });
  rows.push({
    label: "Completion rate",
    av: m_a ? `${m_a.completionRate.toFixed(1)}%` : "—",
    bv: m_b ? `${m_b.completionRate.toFixed(1)}%` : "—",
    better: m_a && m_b ? betterForHigher(m_a.completionRate, m_b.completionRate) : undefined,
    diff: m_a && m_b ? diffAbs(m_a.completionRate, m_b.completionRate) + "pp" : undefined,
    help: "Higher is better",
  });
  rows.push({
    label: "Avg cost (bps)",
    av: m_a ? fmt(m_a.avgCostBps, 1) : "—",
    bv: m_b ? fmt(m_b.avgCostBps, 1) : "—",
    better: m_a && m_b ? betterForLower(m_a.avgCostBps, m_b.avgCostBps) : undefined,
    diff: m_a && m_b ? diffAbs(m_a.avgCostBps, m_b.avgCostBps) : undefined,
    help: "Lower is better",
  });
  rows.push({
    label: "Active providers",
    av: m_a ? String(m_a.activeProviders) : "—",
    bv: m_b ? String(m_b.activeProviders) : "—",
    better: m_a && m_b ? betterForHigher(m_a.activeProviders, m_b.activeProviders) : undefined,
    diff: m_a && m_b ? diffAbs(m_a.activeProviders, m_b.activeProviders) : undefined,
    help: "Higher is better",
  });
  rows.push({
    label: "Exited providers",
    av: m_a ? String(m_a.exitedProviders) : "—",
    bv: m_b ? String(m_b.exitedProviders) : "—",
    better: m_a && m_b ? betterForLower(m_a.exitedProviders, m_b.exitedProviders) : undefined,
    diff: m_a && m_b ? diffAbs(m_a.exitedProviders, m_b.exitedProviders) : undefined,
    help: "Lower is better",
  });
  rows.push({
    label: "Avg provider earnings",
    av: m_a ? formatMoney(m_a.avgProviderEarnings) : "—",
    bv: m_b ? formatMoney(m_b.avgProviderEarnings) : "—",
    better: m_a && m_b ? betterForHigher(m_a.avgProviderEarnings, m_b.avgProviderEarnings) : undefined,
    diff: m_a && m_b ? diffPct(m_a.avgProviderEarnings, m_b.avgProviderEarnings) : undefined,
    help: "Higher is better",
  });
  rows.push({
    label: "Total provider volume",
    av: m_a ? formatMoney(m_a.totalProviderVolume) : "—",
    bv: m_b ? formatMoney(m_b.totalProviderVolume) : "—",
    better: m_a && m_b ? betterForHigher(m_a.totalProviderVolume, m_b.totalProviderVolume) : undefined,
    diff: m_a && m_b ? diffPct(m_a.totalProviderVolume, m_b.totalProviderVolume) : undefined,
    help: "Higher is better",
  });
  rows.push({
    label: "Total liquidity",
    av: m_a ? formatMoney(m_a.totalLiquidity) : "—",
    bv: m_b ? formatMoney(m_b.totalLiquidity) : "—",
    better: m_a && m_b ? betterForHigher(m_a.totalLiquidity, m_b.totalLiquidity) : undefined,
    diff: m_a && m_b ? diffPct(m_a.totalLiquidity, m_b.totalLiquidity) : undefined,
    help: "Higher is better",
  });
  rows.push({
    label: "Market concentration (HHI)",
    av: m_a ? fmt(m_a.marketConcentration, 3) : "—",
    bv: m_b ? fmt(m_b.marketConcentration, 3) : "—",
    better: m_a && m_b ? betterForLower(m_a.marketConcentration, m_b.marketConcentration) : undefined,
    diff: m_a && m_b ? diffAbs(m_a.marketConcentration, m_b.marketConcentration) : undefined,
    help: "Lower is better (more competition)",
  });
  rows.push({
    label: "Protocol revenue",
    av: m_a ? formatMoney(m_a.totalProtocolRevenue) : "—",
    bv: m_b ? formatMoney(m_b.totalProtocolRevenue) : "—",
    better: m_a && m_b ? betterForHigher(m_a.totalProtocolRevenue, m_b.totalProtocolRevenue) : undefined,
    diff: m_a && m_b ? diffPct(m_a.totalProtocolRevenue, m_b.totalProtocolRevenue) : undefined,
    help: "Higher is better",
  });
  rows.push({
    label: "Incentive spend",
    av: m_a ? formatMoney(m_a.totalIncentiveSpend) : "—",
    bv: m_b ? formatMoney(m_b.totalIncentiveSpend) : "—",
    better: m_a && m_b ? betterForLower(m_a.totalIncentiveSpend, m_b.totalIncentiveSpend) : undefined,
    diff: m_a && m_b ? diffPct(m_a.totalIncentiveSpend, m_b.totalIncentiveSpend) : undefined,
    help: "Lower is better",
  });
  rows.push({
    label: "Avg wait (steps)",
    av: m_a ? fmt(m_a.avgWaitSteps, 1) : "—",
    bv: m_b ? fmt(m_b.avgWaitSteps, 1) : "—",
    better: m_a && m_b ? betterForLower(m_a.avgWaitSteps, m_b.avgWaitSteps) : undefined,
    diff: m_a && m_b ? diffAbs(m_a.avgWaitSteps, m_b.avgWaitSteps) : undefined,
    help: "Lower is better",
  });
  rows.push({
    label: "p95 execution (steps)",
    av: m_a ? String(m_a.p95ExecutionSteps) : "—",
    bv: m_b ? String(m_b.p95ExecutionSteps) : "—",
    better: m_a && m_b ? betterForLower(m_a.p95ExecutionSteps, m_b.p95ExecutionSteps) : undefined,
    diff: m_a && m_b ? diffAbs(m_a.p95ExecutionSteps, m_b.p95ExecutionSteps) : undefined,
    help: "Lower is better",
  });

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="size-4 text-emerald-500" /> Side-by-side metrics
        </CardTitle>
        <CardDescription className="text-xs">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">Green</span> indicates the better performer for that row.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[11px]">Metric</TableHead>
              <TableHead className="text-[11px] text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <Badge variant="outline" className="text-[9px] py-0 h-4 border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300">A</Badge>
                  <span className="font-medium truncate max-w-[140px]">{a?.config ? scenarioLabelFromConfig(a.config) : "—"}</span>
                </div>
              </TableHead>
              <TableHead className="text-[11px] text-right">Δ</TableHead>
              <TableHead className="text-[11px] text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <Badge variant="outline" className="text-[9px] py-0 h-4 border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300">B</Badge>
                  <span className="font-medium truncate max-w-[140px]">{b?.config ? scenarioLabelFromConfig(b.config) : "—"}</span>
                </div>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="text-[11px] py-1.5">
                  <div className="font-medium">{r.label}</div>
                  {r.help && <div className="text-[10px] text-muted-foreground">{r.help}</div>}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-[11px] text-right font-mono tabular-nums py-1.5",
                    r.better === "a" && "text-emerald-600 dark:text-emerald-400 font-semibold",
                  )}
                >
                  {r.av}
                </TableCell>
                <TableCell className="text-[10px] text-right font-mono tabular-nums py-1.5 text-muted-foreground">
                  {r.diff ?? "—"}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-[11px] text-right font-mono tabular-nums py-1.5",
                    r.better === "b" && "text-emerald-600 dark:text-emerald-400 font-semibold",
                  )}
                >
                  {r.bv}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function scenarioLabelFromConfig(config: SimConfig): string {
  // Best-effort label derived from shock type & initial providers.
  const parts: string[] = [`${config.initialProviders} prov`];
  if (config.shockType) parts.push(`${prettyEnum(config.shockType)} @ ${config.shockStep}`);
  if (!config.enableReputation) parts.push("no-rep");
  if (!config.enableIncentives) parts.push("no-inc");
  if (!config.enableCommitments) parts.push("no-cmt");
  return parts.join(" · ");
}
