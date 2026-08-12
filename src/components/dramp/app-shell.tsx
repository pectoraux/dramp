"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SendPanel } from "./send-panel";
import { ExecutionsPanel } from "./executions-panel";
import { ProvidersPanel } from "./providers-panel";
import { MonitorPanel } from "./monitor-panel";
import { AuditPanel } from "./audit-panel";
import { WaitlistPanel } from "./waitlist-panel";
import { MarketplacePanel } from "./marketplace-panel";
import { OpsPanel } from "./ops-panel";
import { ApiPanel } from "./api-panel";
import { EconomicsPanel } from "./economics-panel";
import { AuthScreen } from "./auth-screen";
import { usePolling } from "@/hooks/use-polling";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  ListChecks,
  Building2,
  Activity,
  ScrollText,
  Loader2,
  Database,
  Moon,
  Sun,
  AlertTriangle,
  UserCog,
  LogOut,
  ChevronDown,
  ShieldCheck,
  Store,
  Gauge,
  Terminal,
  BarChart3,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import type { SeedStatusResponse, MonitorResponse } from "./types";

type TabKey =
  | "send"
  | "executions"
  | "providers"
  | "marketplace"
  | "monitor"
  | "audit"
  | "ops"
  | "economics"
  | "api"
  | "waitlist";

interface TabDef {
  key: TabKey;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
  operatorOnly?: boolean; // visible to PROVIDER_OPERATOR + ADMIN
}

const TABS: TabDef[] = [
  { key: "send", label: "Send", icon: <Send className="size-3.5" /> },
  { key: "executions", label: "Executions", icon: <ListChecks className="size-3.5" /> },
  { key: "marketplace", label: "Marketplace", icon: <Store className="size-3.5" /> },
  { key: "providers", label: "Providers", icon: <Building2 className="size-3.5" /> },
  { key: "monitor", label: "Monitor", icon: <Activity className="size-3.5" /> },
  { key: "audit", label: "Audit", icon: <ScrollText className="size-3.5" /> },
  { key: "economics", label: "Economics", icon: <BarChart3 className="size-3.5" /> },
  { key: "ops", label: "Ops", icon: <Gauge className="size-3.5" />, adminOnly: true },
  { key: "api", label: "API", icon: <Terminal className="size-3.5" />, operatorOnly: true },
  { key: "waitlist", label: "Waitlist", icon: <UserCog className="size-3.5" />, adminOnly: true },
];

function readHashTab(): TabKey {
  if (typeof window === "undefined") return "send";
  const h = window.location.hash.replace("#", "").toLowerCase();
  return (TABS.find((t) => t.key === h)?.key ?? "send") as TabKey;
}

export function AppShell() {
  const { data: session, status: sessionStatus } = useSession();
  const [tab, setTab] = useState<TabKey>("send");
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [autoSelectLatest, setAutoSelectLatest] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  const user = session?.user as any;
  const isAdmin = user?.role === "ADMIN";
  const isOperator = user?.role === "PROVIDER_OPERATOR";

  // Seed status check — poll until seeded, then stop.
  const seedStatus = usePolling<SeedStatusResponse>("/api/seed", 3000);
  const seeded = !!seedStatus.data?.seeded;

  // Ticker status for header dot — share the monitor poll.
  const monitor = usePolling<MonitorResponse>(seeded && user ? "/api/monitor" : null, 3000);
  const tickerRunning = !!monitor.data?.stats?.tickerRunning;
  const activeCount = monitor.data?.stats?.activeCount ?? 0;

  useEffect(() => {
    setMounted(true);
    setTab(readHashTab());
    const onHash = () => setTab(readHashTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const switchTab = useCallback((t: TabKey) => {
    setTab(t);
    if (typeof window !== "undefined") {
      window.location.hash = t;
    }
  }, []);

  const handleExecutionCreated = useCallback(
    (executionId: string, _intentId: string) => {
      setSelectedExecutionId(executionId);
      setAutoSelectLatest(false);
      switchTab("executions");
      // Refresh monitor + executions via polling (they'll pick up naturally).
    },
    [switchTab],
  );

  const handleJumpToExecution = useCallback(
    (id: string) => {
      setSelectedExecutionId(id);
      setAutoSelectLatest(false);
      switchTab("executions");
    },
    [switchTab],
  );

  async function handleSeed() {
    setSeeding(true);
    try {
      const res = await fetch("/api/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Marketplace seeded", {
        description: `${json.providers ?? 0} providers · ${json.offers ?? 0} offers · ${json.settlementAssets ?? 0} settlement assets`,
      });
      seedStatus.refetch();
    } catch (err) {
      toast.error("Seed failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setSeeding(false);
    }
  }

  // Auth gate — after all hooks so hook order is stable.
  if (sessionStatus !== "authenticated") {
    if (sessionStatus === "loading") {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-3">
          <div className="size-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-sm">
            <span className="text-white font-bold text-base leading-none">d</span>
          </div>
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return (
      <AuthScreen
        seedStatus={seedStatus.data}
        onSeed={handleSeed}
        seeding={seeding}
      />
    );
  }

  const visibleTabs = TABS.filter((t) => {
    if (t.adminOnly) return isAdmin;
    if (t.operatorOnly) return isAdmin || isOperator;
    return true;
  });

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Sticky header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-4 lg:px-6">
          <div className="flex h-14 items-center gap-2 sm:gap-4">
            {/* Wordmark */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="size-7 rounded-md bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-sm">
                <span className="text-white font-bold text-sm leading-none">d</span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="font-semibold text-base tracking-tight">dRamp</span>
                <Badge
                  variant="outline"
                  className="hidden sm:inline-flex text-[9px] py-0 h-4 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300 uppercase tracking-wide"
                >
                  Simulated
                </Badge>
              </div>
            </div>

            {/* Tabs */}
            <nav className="flex-1 min-w-0 overflow-x-auto dramp-scroll">
              <Tabs value={tab} onValueChange={(v) => switchTab(v as TabKey)}>
                <TabsList className="bg-transparent p-0 h-9 gap-0.5">
                  {visibleTabs.map((t) => (
                    <TabsTrigger
                      key={t.key}
                      value={t.key}
                      className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400 data-[state=active]:shadow-none"
                    >
                      {t.icon}
                      <span className="hidden sm:inline">{t.label}</span>
                      {t.key === "executions" && activeCount > 0 && (
                        <Badge variant="outline" className="ml-0.5 text-[9px] py-0 h-3.5 px-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                          {activeCount}
                        </Badge>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </nav>

            {/* Right side: ticker dot + theme toggle */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "relative flex size-2",
                    !mounted && "opacity-0",
                  )}
                  title={tickerRunning ? "Engine ticker running" : "Engine ticker stopped"}
                >
                  {tickerRunning && (
                    <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping", tickerRunning ? "bg-emerald-500" : "bg-rose-500")} />
                  )}
                  <span className={cn("relative inline-flex size-2 rounded-full", tickerRunning ? "bg-emerald-500" : "bg-rose-500")} />
                </span>
                <span className="font-mono">{tickerRunning ? "live" : "halted"}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                title="Toggle theme"
              >
                {mounted && theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
              {/* User menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-1.5 h-8 px-2">
                    <span className={cn("flex size-5 items-center justify-center rounded-full text-[10px] font-semibold", isAdmin ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>
                      {isAdmin ? <ShieldCheck className="size-3" /> : (user?.name?.[0] ?? user?.email?.[0] ?? "U").toUpperCase()}
                    </span>
                    <span className="hidden sm:inline text-xs max-w-[120px] truncate">{user?.name ?? user?.email}</span>
                    <ChevronDown className="size-3 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="text-xs">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium truncate">{user?.name ?? user?.email}</span>
                      <span className="text-muted-foreground font-normal">{user?.email}</span>
                      <Badge variant="outline" className={cn("text-[9px] py-0 h-4 w-fit mt-0.5", isAdmin ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border")}>{user?.role}{user?.isDemo ? " · DEMO" : ""}</Badge>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/" })} className="text-rose-600 dark:text-rose-400 focus:text-rose-600">
                    <LogOut className="size-3.5" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 mx-auto max-w-[1600px] w-full px-3 sm:px-4 lg:px-6 py-4 sm:py-6">
        {/* Seed CTA when unseeded */}
        {seedStatus.loading && !seedStatus.data ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !seeded ? (
          <SeedCta onSeed={handleSeed} seeding={seeding} />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
            >
              <Tabs value={tab} onValueChange={(v) => switchTab(v as TabKey)}>
                <TabsContent value="send" className="focus-visible:outline-none">
                  <SendPanel onExecutionCreated={handleExecutionCreated} />
                </TabsContent>
                <TabsContent value="executions" className="focus-visible:outline-none">
                  <ExecutionsPanel
                    selectedId={selectedExecutionId}
                    onSelect={(id) => { setSelectedExecutionId(id); setAutoSelectLatest(false); }}
                    autoSelectLatest={autoSelectLatest}
                  />
                </TabsContent>
                <TabsContent value="providers" className="focus-visible:outline-none">
                  <ProvidersPanel />
                </TabsContent>
                <TabsContent value="marketplace" className="focus-visible:outline-none">
                  <MarketplacePanel />
                </TabsContent>
                <TabsContent value="monitor" className="focus-visible:outline-none">
                  <MonitorPanel onJumpToExecution={handleJumpToExecution} />
                </TabsContent>
                <TabsContent value="audit" className="focus-visible:outline-none">
                  <AuditPanel />
                </TabsContent>
                <TabsContent value="economics" className="focus-visible:outline-none">
                  <EconomicsPanel />
                </TabsContent>
                {isAdmin && (
                  <TabsContent value="ops" className="focus-visible:outline-none">
                    <OpsPanel />
                  </TabsContent>
                )}
                {(isAdmin || isOperator) && (
                  <TabsContent value="api" className="focus-visible:outline-none">
                    <ApiPanel />
                  </TabsContent>
                )}
                {isAdmin && (
                  <TabsContent value="waitlist" className="focus-visible:outline-none">
                    <WaitlistPanel />
                  </TabsContent>
                )}
              </Tabs>
            </motion.div>
          </AnimatePresence>
        )}
      </main>

      {/* Sticky footer */}
      <footer className="mt-auto border-t border-border bg-muted/30">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-4 lg:px-6 py-3">
          <div className="flex items-start sm:items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
            <Badge variant="outline" className="text-[9px] py-0 h-4 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300 uppercase tracking-wide shrink-0">
              <AlertTriangle className="size-2.5" /> Prototype
            </Badge>
            <span className="leading-relaxed">
              <span className="font-medium text-foreground">dRamp</span> is a prototype execution marketplace. Blockchain, bank and PSP rails are <span className="font-medium">simulated</span>; KYC/AML is <span className="font-medium">mocked</span>; no real money, custody, or smart contracts are involved.
            </span>
            <a
              href="#"
              className="ml-auto inline-flex items-center gap-1 hover:text-foreground transition-colors shrink-0"
              onClick={(e) => e.preventDefault()}
              title="Prototype — no external link"
            >
              v0.2
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SeedCta({ onSeed, seeding }: { onSeed: (reset?: boolean) => void; seeding: boolean }) {
  return (
    <div className="dramp-grid-bg">
      <Card className="max-w-2xl mx-auto mt-8 sm:mt-16 border-emerald-500/30 bg-card/95">
        <CardContent className="py-8 sm:py-10 text-center space-y-4">
          <div className="mx-auto size-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
            <Database className="size-7 text-emerald-500" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold">Welcome to dRamp</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              The marketplace is empty. Seed the demo data to get 7 liquidity providers,
              4 settlement assets (including a volatile token that is hard-excluded from collateral),
              and 12 active offers across cheap, fast, safe, manual, and incentivized corridors.
            </p>
          </div>
          <Button onClick={() => onSeed(false)} disabled={seeding} size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {seeding ? <><Loader2 className="size-4 animate-spin" /> Seeding…</> : <><Database className="size-4" /> Seed marketplace</>}
          </Button>
          <p className="text-[10px] text-muted-foreground">
            After seeding, the golden demo is one click away on the Send tab.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
