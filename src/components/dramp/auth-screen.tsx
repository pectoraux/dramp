"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Loader2,
  ShieldCheck,
  UserCog,
  Building2,
  Mail,
  ArrowRight,
  Database,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SeedStatus {
  seeded: boolean;
  needsBootstrap?: boolean;
}

export function AuthScreen({
  seedStatus,
  onSeed,
  seeding,
}: {
  seedStatus: SeedStatus | null | undefined;
  onSeed: () => void;
  seeding: boolean;
}) {
  // Bootstrap mode: no admin exists yet → show seed CTA.
  if (seedStatus?.needsBootstrap) {
    return (
      <div className="min-h-screen flex flex-col bg-background dramp-grid-bg">
        <main className="flex-1 flex items-center justify-center px-4 py-10">
          <Card className="max-w-lg w-full border-emerald-500/30 bg-card/95">
            <CardContent className="py-8 sm:py-10 text-center space-y-4">
              <div className="mx-auto size-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <Database className="size-7 text-emerald-500" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold">Set up the dRamp marketplace</h2>
                <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
                  This is a fresh deployment. Seed the marketplace to create liquidity providers,
                  settlement assets, offers, and the admin + demo accounts.
                </p>
              </div>
              <Button onClick={onSeed} disabled={seeding} size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white">
                {seeding ? <><Loader2 className="size-4 animate-spin" /> Seeding…</> : <><Database className="size-4" /> Seed marketplace</>}
              </Button>
            </CardContent>
          </Card>
        </main>
        <ComplianceFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background dramp-grid-bg">
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-5xl grid lg:grid-cols-2 gap-8 items-center">
          {/* Left: brand + value prop */}
          <div className="hidden lg:block space-y-6 pr-4">
            <div className="flex items-center gap-3">
              <div className="size-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg">
                <span className="text-white font-bold text-xl leading-none">d</span>
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">dRamp</h1>
                <p className="text-xs text-muted-foreground">Open Execution Marketplace for Cross-Border Value</p>
              </div>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Express an execution intent. dRamp discovers, evaluates, waits for, reserves, and
              executes the best route across fiat providers, banks, PSPs, CEXs, DEXs, and
              stablecoin liquidity — subject to hard network risk constraints.
            </p>
            <div className="space-y-2.5">
              {[
                "Dynamic route discovery across a liquidity graph",
                "Collateralized providers with on-chain exposure limits",
                "Immutable, hash-chained audit trail",
                "Waiting policy with automatic route re-evaluation",
              ].map((f) => (
                <div key={f} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-emerald-500 mt-0.5 shrink-0" />
                  <span className="text-foreground/80">{f}</span>
                </div>
              ))}
            </div>
            <Badge variant="outline" className="text-[10px] border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300 uppercase tracking-wide">
              Prototype — all rails simulated
            </Badge>
          </div>

          {/* Right: auth card */}
          <AuthCard />
        </div>
      </main>
      <ComplianceFooter />
    </div>
  );
}

function AuthCard() {
  const [mode, setMode] = useState<"login" | "signup">("login");

  return (
    <Card className="max-w-md w-full mx-auto border-border/60 bg-card/95 backdrop-blur">
      <CardContent className="pt-6 space-y-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {mode === "login" ? "Sign in to dRamp" : "Join the waitlist"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {mode === "login"
              ? "Use a demo account or your approved credentials."
              : "Sign-up adds you to the waitlist. An admin will create your account."}
          </p>
        </div>

        {mode === "login" ? <LoginForm /> : <SignupForm />}

        <div className="text-center">
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {mode === "login" ? "Don't have an account? Join the waitlist →" : "Already approved? Sign in →"}
          </button>
        </div>

        <Separator />

        {/* Demo quick-login */}
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Quick demo login</p>
          <DemoButtons />
        </div>
      </CardContent>
    </Card>
  );
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    if (res?.error) {
      toast.error("Sign in failed", { description: "Check your email and password." });
    } else {
      toast.success("Signed in");
      window.location.reload();
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="email" className="text-xs">Email</Label>
        <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password" className="text-xs">Password</Label>
        <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required autoComplete="current-password" />
      </div>
      <Button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white">
        {loading ? <Loader2 className="size-4 animate-spin" /> : <><ShieldCheck className="size-4" /> Sign in</>}
      </Button>
    </form>
  );
}

function SignupForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"USER" | "PROVIDER_OPERATOR">("USER");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, requestedRole: role, note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Sign up failed");
      setDone(true);
      toast.success("You're on the waitlist!", { description: json.message ?? "An admin will review your request." });
    } catch (err) {
      toast.error("Sign up failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-3 text-center py-2">
        <div className="mx-auto size-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
          <CheckCircle2 className="size-6 text-emerald-500" />
        </div>
        <p className="text-sm font-medium">You're on the waitlist</p>
        <p className="text-xs text-muted-foreground">We'll create your account once an admin approves your request. You'll then be able to sign in.</p>
        <Button variant="outline" size="sm" onClick={() => { setDone(false); setEmail(""); setName(""); setNote(""); }}>
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="su-name" className="text-xs">Name (optional)</Label>
        <Input id="su-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="su-email" className="text-xs">Email</Label>
        <Input id="su-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Account type</Label>
        <div className="grid grid-cols-2 gap-2">
          {([
            { v: "USER", label: "User", icon: <Mail className="size-3.5" /> },
            { v: "PROVIDER_OPERATOR", label: "Provider", icon: <Building2 className="size-3.5" /> },
          ] as const).map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => setRole(o.v)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors",
                role === o.v ? "border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border hover:bg-accent",
              )}
            >
              {o.icon} {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="su-note" className="text-xs">Note (optional)</Label>
        <Input id="su-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What corridor are you interested in?" />
      </div>
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? <Loader2 className="size-4 animate-spin" /> : <>Join waitlist <ArrowRight className="size-4" /></>}
      </Button>
    </form>
  );
}

function DemoButtons() {
  const [loading, setLoading] = useState<string | null>(null);
  const demos = [
    { key: "alice", email: "alice@dramp.demo", password: "Demo1234!", label: "Alice", sub: "User", icon: <Mail className="size-3.5" /> },
    { key: "operator", email: "operator@dramp.demo", password: "Demo1234!", label: "Operator", sub: "Provider", icon: <Building2 className="size-3.5" /> },
    { key: "admin", email: "admin@dramp.demo", password: "Demo1234!", label: "Admin", sub: "Demo admin", icon: <ShieldCheck className="size-3.5" /> },
  ];

  async function go(d: { key: string; email: string; password: string }) {
    setLoading(d.key);
    const res = await signIn("credentials", { email: d.email, password: d.password, redirect: false });
    setLoading(null);
    if (res?.error) {
      toast.error("Demo login failed", { description: "The marketplace may not be seeded yet." });
    } else {
      toast.success(`Signed in as ${d.email}`);
      window.location.reload();
    }
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {demos.map((d) => (
        <button
          key={d.key}
          type="button"
          onClick={() => go(d)}
          disabled={!!loading}
          className="flex flex-col items-center gap-1 rounded-md border border-border bg-background/50 px-2 py-2.5 text-center hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors disabled:opacity-50"
        >
          <div className="text-emerald-500">{loading === d.key ? <Loader2 className="size-3.5 animate-spin" /> : d.icon}</div>
          <span className="text-xs font-medium">{d.label}</span>
          <span className="text-[10px] text-muted-foreground">{d.sub}</span>
        </button>
      ))}
    </div>
  );
}

function ComplianceFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-muted/30">
      <div className="mx-auto max-w-[1600px] px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground justify-center text-center">
          <Badge variant="outline" className="text-[9px] py-0 h-4 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300 uppercase tracking-wide shrink-0">
            Prototype
          </Badge>
          <span className="leading-relaxed">
            dRamp is a prototype. Blockchain, bank and PSP rails are <span className="font-medium">simulated</span>; KYC/AML is <span className="font-medium">mocked</span>; no real money, custody, or smart contracts are involved.
          </span>
        </div>
      </div>
    </footer>
  );
}
