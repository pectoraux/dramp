"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePolling } from "@/hooks/use-polling";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatTimestamp, shortId, prettyEnum } from "./format";
import type {
  ApiKeysResponse,
  ApiKey,
  CreateApiKeyResponse,
  WebhooksResponse,
  WebhookEndpoint,
  CreateWebhookResponse,
  ProvidersResponse,
} from "./types";
import {
  Key,
  Webhook,
  BookOpen,
  Plus,
  Loader2,
  Copy,
  Check,
  Trash2,
  ShieldAlert,
  Terminal,
  ArrowRight,
  Lock,
} from "lucide-react";

const API_SCOPES = ["offers", "executions", "obligations", "reconcile"];
const WEBHOOK_EVENTS = ["execution.created", "execution.completed", "execution.failed", "obligation.created", "obligation.fulfilled", "dispute.opened", "*"];

export function ApiPanel() {
  const { data: session } = useSession();
  const user = session?.user as any;
  const isAdmin = user?.role === "ADMIN";
  const isOperator = user?.role === "PROVIDER_OPERATOR";
  const boundProviderId = user?.providerId ?? null;

  // Admin provider selector — admins can pick any provider.
  const [adminProviderId, setAdminProviderId] = useState<string | null>(null);
  const { data: providersData } = usePolling<ProvidersResponse>("/api/providers", 10000);
  const providers = providersData?.providers ?? [];

  const providerId = isAdmin ? adminProviderId : isOperator ? boundProviderId : null;

  const [sub, setSub] = useState<string>("keys");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Terminal className="size-5 text-emerald-500" /> Open Liquidity API
          </h2>
          <p className="text-xs text-muted-foreground">
            Manage API keys, webhook endpoints, and view the API contract.
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Label className="text-[10px] text-muted-foreground">Provider</Label>
            <Select value={adminProviderId ?? ""} onValueChange={setAdminProviderId}>
              <SelectTrigger className="w-[200px] h-8 text-xs"><SelectValue placeholder="Select provider" /></SelectTrigger>
              <SelectContent>
                {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {!providerId ? (
        <Card className="py-12 border-dashed">
          <CardContent className="text-center text-sm text-muted-foreground space-y-2">
            <Lock className="size-6 text-muted-foreground/60 mx-auto" />
            <div>
              {isOperator
                ? "Your account is not bound to a provider. Contact an admin."
                : "Select a provider to manage their API keys and webhooks."}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Tabs value={sub} onValueChange={setSub}>
          <TabsList className="bg-transparent p-0 h-9 gap-0.5">
            <TabsTrigger value="keys" className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400">
              <Key className="size-3.5" /> <span className="hidden sm:inline">API keys</span>
            </TabsTrigger>
            <TabsTrigger value="webhooks" className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400">
              <Webhook className="size-3.5" /> <span className="hidden sm:inline">Webhooks</span>
            </TabsTrigger>
            <TabsTrigger value="docs" className="gap-1.5 data-[state=active]:bg-emerald-500/10 data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400">
              <BookOpen className="size-3.5" /> <span className="hidden sm:inline">Docs</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="keys" className="focus-visible:outline-none mt-4">
            <KeysView providerId={providerId} />
          </TabsContent>
          <TabsContent value="webhooks" className="focus-visible:outline-none mt-4">
            <WebhooksView providerId={providerId} />
          </TabsContent>
          <TabsContent value="docs" className="focus-visible:outline-none mt-4">
            <DocsView providerId={providerId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------
function KeysView({ providerId }: { providerId: string }) {
  const { data, loading, refetch } = usePolling<ApiKeysResponse>(`/api/v1/provider/keys?providerId=${providerId}`, 5000);
  const keys = data?.keys ?? [];
  const [revoking, setRevoking] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<CreateApiKeyResponse | null>(null);

  async function revoke(k: ApiKey) {
    setRevoking(k.id);
    try {
      const res = await fetch(`/api/v1/provider/keys?id=${k.id}&providerId=${providerId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("API key revoked", { description: k.label });
      refetch();
    } catch (err) {
      toast.error("Revoke failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Key className="size-4 text-emerald-500" /> API keys
            <Badge variant="outline" className="text-[10px] py-0 h-4">{keys.length}</Badge>
          </CardTitle>
          <CreateKeyDialog providerId={providerId} onCreated={(resp) => { setCreatedSecret(resp); refetch(); }} />
        </div>
        <CardDescription className="text-xs">
          Authenticate API requests with <span className="font-mono text-foreground">Authorization: Bearer pk_xxx:sk_xxx</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        {loading && keys.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : keys.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No API keys yet. Create one to get started.</div>
        ) : (
          <div className="dramp-scroll overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                <tr>
                  <th className="text-left font-medium px-2 py-1.5">Label</th>
                  <th className="text-left font-medium px-2 py-1.5">Key ID</th>
                  <th className="text-left font-medium px-2 py-1.5">Scopes</th>
                  <th className="text-center font-medium px-2 py-1.5">Status</th>
                  <th className="text-right font-medium px-2 py-1.5">Last used</th>
                  <th className="text-right font-medium px-2 py-1.5">Created</th>
                  <th className="text-right font-medium px-2 py-1.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-2 py-1.5 font-medium">{k.label}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px]">{k.keyId}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1 flex-wrap">
                        {k.scopes.map((s) => <Badge key={s} variant="outline" className="text-[9px] py-0 h-3.5">{s}</Badge>)}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <Badge variant="outline" className={cn("text-[10px] py-0 h-4", k.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300")}>
                        {prettyEnum(k.status)}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 text-right text-[10px] text-muted-foreground">{k.lastUsedAt ? formatTimestamp(k.lastUsedAt) : "never"}</td>
                    <td className="px-2 py-1.5 text-right text-[10px] text-muted-foreground">{formatTimestamp(k.createdAt)}</td>
                    <td className="px-2 py-1.5 text-right">
                      {k.status === "ACTIVE" ? (
                        <Button size="sm" variant="ghost" className="h-7 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10" onClick={() => revoke(k)} disabled={revoking === k.id}>
                          {revoking === k.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />} Revoke
                        </Button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">revoked {k.revokedAt ? formatTimestamp(k.revokedAt) : ""}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* Secret shown ONCE dialog */}
      <Dialog open={!!createdSecret} onOpenChange={(o) => !o && setCreatedSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-amber-500" /> API key created
            </DialogTitle>
            <DialogDescription>Copy the secret now. It will not be shown again.</DialogDescription>
          </DialogHeader>
          {createdSecret && (
            <div className="space-y-3 py-2">
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300 flex gap-2">
                <ShieldAlert className="size-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Store this secret securely.</div>
                  <div className="opacity-90 mt-0.5">Treat it like a password — anyone with this secret can manage offers, executions, and obligations for this provider.</div>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Key ID (public)</Label>
                <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs flex items-center justify-between gap-2">
                  <span className="truncate">{createdSecret.keyId}</span>
                  <CopyButton text={createdSecret.keyId} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Secret (shown once)</Label>
                <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs flex items-center justify-between gap-2">
                  <span className="truncate">{createdSecret.secret}</span>
                  <CopyButton text={createdSecret.secret} />
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Authorization header format: <span className="font-mono">Bearer {createdSecret.keyId}:{createdSecret.secret}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setCreatedSecret(null)} className="bg-emerald-600 hover:bg-emerald-700 text-white">I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CreateKeyDialog({ providerId, onCreated }: { providerId: string; onCreated: (resp: CreateApiKeyResponse) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(API_SCOPES);
  const [saving, setSaving] = useState(false);

  function toggleScope(s: string) {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function submit() {
    if (!label.trim()) {
      toast.error("Enter a label");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/v1/provider/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, label, scopes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("API key created");
      onCreated(json);
      setOpen(false);
      setLabel("");
      setScopes(API_SCOPES);
    } catch (err) {
      toast.error("Create failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="size-3.5" /> Create key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>The secret will be shown once after creation.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production server" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Scopes</Label>
            <div className="flex items-center gap-2 flex-wrap">
              {API_SCOPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleScope(s)}
                  className={cn(
                    "px-2.5 py-1 rounded-md border text-xs font-medium transition-colors",
                    scopes.includes(s) ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border hover:bg-muted/50",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving ? <><Loader2 className="size-4 animate-spin" /> Creating…</> : <><Key className="size-4" /> Create</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
function WebhooksView({ providerId }: { providerId: string }) {
  const { data, loading, refetch } = usePolling<WebhooksResponse>(`/api/v1/provider/webhooks?providerId=${providerId}`, 5000);
  const endpoints = data?.endpoints ?? [];
  const [createdSecret, setCreatedSecret] = useState<CreateWebhookResponse | null>(null);

  return (
    <Card className="py-3">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Webhook className="size-4 text-emerald-500" /> Webhook endpoints
            <Badge variant="outline" className="text-[10px] py-0 h-4">{endpoints.length}</Badge>
          </CardTitle>
          <RegisterWebhookDialog providerId={providerId} onCreated={(resp) => { setCreatedSecret(resp); refetch(); }} />
        </div>
        <CardDescription className="text-xs">Receive signed event deliveries for executions, obligations, and disputes.</CardDescription>
      </CardHeader>
      <CardContent className="pt-2 space-y-3 max-h-[70vh] overflow-y-auto dramp-scroll">
        {loading && endpoints.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : endpoints.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">No webhook endpoints registered.</div>
        ) : endpoints.map((e) => <WebhookRow key={e.id} endpoint={e} />)}
      </CardContent>

      <Dialog open={!!createdSecret} onOpenChange={(o) => !o && setCreatedSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-amber-500" /> Webhook registered
            </DialogTitle>
            <DialogDescription>Copy the signing secret now. It will not be shown again.</DialogDescription>
          </DialogHeader>
          {createdSecret && (
            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label className="text-xs">Endpoint ID</Label>
                <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs flex items-center justify-between gap-2">
                  <span className="truncate">{createdSecret.id}</span>
                  <CopyButton text={createdSecret.id} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Signing secret</Label>
                <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs flex items-center justify-between gap-2">
                  <span className="truncate">{createdSecret.secret}</span>
                  <CopyButton text={createdSecret.secret} />
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Verify deliveries by checking the <span className="font-mono">X-dRamp-Signature</span> header against <span className="font-mono">HMAC-SHA256(secret, body)</span>.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setCreatedSecret(null)} className="bg-emerald-600 hover:bg-emerald-700 text-white">I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function WebhookRow({ endpoint }: { endpoint: WebhookEndpoint }) {
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-0.5 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-xs truncate max-w-[400px]">{endpoint.url}</span>
            <Badge variant="outline" className={cn("text-[10px] py-0 h-4", endpoint.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300")}>
              {prettyEnum(endpoint.status)}
            </Badge>
          </div>
          <div className="flex items-center gap-1 flex-wrap mt-1">
            {endpoint.events.map((ev) => <Badge key={ev} variant="outline" className="text-[9px] py-0 h-3.5">{ev}</Badge>)}
          </div>
        </div>
      </div>
      {endpoint.recentDeliveries.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground mb-1">Recent deliveries</div>
          <div className="space-y-1 max-h-32 overflow-y-auto dramp-scroll">
            {endpoint.recentDeliveries.map((d) => (
              <div key={d.id} className="flex items-center justify-between text-[10px] font-mono">
                <span className="truncate">{d.eventType}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={cn("text-[9px] py-0 h-3.5", d.status === "DELIVERED" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : d.status === "FAILED" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300")}>
                    {prettyEnum(d.status)}
                  </Badge>
                  <span className="text-muted-foreground">{d.attempts}x</span>
                  <span className="text-muted-foreground">{d.deliveredAt ? formatTimestamp(d.deliveredAt) : "—"}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RegisterWebhookDialog({ providerId, onCreated }: { providerId: string; onCreated: (resp: CreateWebhookResponse) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["*"]);
  const [saving, setSaving] = useState(false);

  function toggleEvent(e: string) {
    setEvents((cur) => {
      if (e === "*") return ["*"];
      const next = cur.filter((x) => x !== "*");
      return next.includes(e) ? next.filter((x) => x !== e) : [...next, e];
    });
  }

  async function submit() {
    if (!url.trim()) {
      toast.error("Enter a webhook URL");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/v1/provider/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, url, events }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Webhook registered");
      onCreated(json);
      setOpen(false);
      setUrl("");
      setEvents(["*"]);
    } catch (err) {
      toast.error("Register failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="size-3.5" /> Register webhook
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register webhook</DialogTitle>
          <DialogDescription>Receive signed event deliveries. The signing secret will be shown once.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">URL</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server.com/dramp/webhook" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Events</Label>
            <div className="flex items-center gap-2 flex-wrap">
              {WEBHOOK_EVENTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggleEvent(e)}
                  className={cn(
                    "px-2.5 py-1 rounded-md border text-xs font-medium transition-colors",
                    events.includes(e) ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border hover:bg-muted/50",
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving ? <><Loader2 className="size-4 animate-spin" /> Registering…</> : <><Webhook className="size-4" /> Register</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// API documentation
// ---------------------------------------------------------------------------
function DocsView({ providerId }: { providerId: string }) {
  const baseUrl = "/api/v1/provider";
  const authHeader = "Authorization: Bearer pk_xxx:sk_xxx";

  const endpoints: { method: string; path: string; desc: string }[] = [
    { method: "GET", path: "/offers", desc: "List your provider's active offers." },
    { method: "POST", path: "/offers", desc: "Publish a new liquidity offer." },
    { method: "PATCH", path: "/offers/[id]", desc: "Update an existing offer (rate, capacity, active)." },
    { method: "DELETE", path: "/offers/[id]", desc: "Deactivate an offer." },
    { method: "GET", path: "/executions", desc: "List executions that involve your provider." },
    { method: "POST", path: "/executions/[id]/accept", desc: "Accept a leg assigned to your provider." },
    { method: "POST", path: "/executions/[id]/reject", desc: "Reject a leg." },
    { method: "POST", path: "/executions/[id]/settle", desc: "Mark a leg as settled." },
    { method: "POST", path: "/executions/[id]/fail", desc: "Report a leg failure." },
    { method: "GET", path: "/obligations", desc: "List your provider's outstanding obligations." },
    { method: "POST", path: "/obligations/[id]/fulfill", desc: "Fulfill an obligation." },
    { method: "GET", path: "/reconcile", desc: "Detect reconciliation discrepancies." },
    { method: "POST", path: "/reconcile", desc: "Create a reconciliation item manually." },
  ];

  const curlExample = `curl -X POST ${baseUrl}/offers \\
  -H "Authorization: Bearer pk_xxx:sk_xxx" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: unique-key-123" \\
  -d '{
    "capability": "FIAT_IN",
    "sourceAsset": "USD",
    "destinationAsset": "USDC",
    "sourceCountry": "US",
    "destinationCountry": "US",
    "rate": "1.0001",
    "feeBps": 30,
    "minimumAmount": "100",
    "maximumAmount": "50000",
    "availableCapacity": "25000",
    "channelType": "AUTOMATIC",
    "expectedExecutionSeconds": 30,
    "settlementAssetId": "${shortId(providerId, 0) || "settlement-asset-id"}"
  }'`;

  return (
    <div className="space-y-4">
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BookOpen className="size-4 text-emerald-500" /> Open Liquidity API contract
          </CardTitle>
          <CardDescription className="text-xs">
            Programmatic access for providers to publish offers and operate executions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Base URL</div>
              <div className="font-mono text-xs">{baseUrl}</div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Authentication</div>
              <div className="font-mono text-xs break-all">{authHeader}</div>
            </div>
          </div>
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
            <div className="font-medium text-emerald-700 dark:text-emerald-300 mb-1">Idempotency</div>
            <div className="text-foreground/80">
              Pass an <span className="font-mono">Idempotency-Key</span> header (or <span className="font-mono">idempotencyKey</span> in the body) on every write. Duplicate keys return the original response instead of creating a second resource — safe to retry on network failures.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Terminal className="size-4 text-emerald-500" /> Endpoints
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="dramp-scroll overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                <tr>
                  <th className="text-left font-medium px-2 py-1.5 w-20">Method</th>
                  <th className="text-left font-medium px-2 py-1.5">Path</th>
                  <th className="text-left font-medium px-2 py-1.5">Description</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((e, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-2 py-1.5">
                      <Badge variant="outline" className={cn("text-[10px] py-0 h-4 font-mono",
                        e.method === "GET" ? "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300" :
                        e.method === "POST" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" :
                        e.method === "PATCH" ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" :
                        "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
                      )}>
                        {e.method}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px]">{e.path}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{e.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Terminal className="size-4 text-emerald-500" /> Example: publish an offer
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <CodeBlock code={curlExample} />
        </CardContent>
      </Card>

      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ArrowRight className="size-4 text-emerald-500" /> Lifecycle
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2 text-xs text-muted-foreground space-y-2">
          <div>
            <span className="font-medium text-foreground">Offer lifecycle:</span>{" "}
            <span className="font-mono">POST /offers <ArrowRight className="inline size-2.5" /> PATCH /offers/[id] <ArrowRight className="inline size-2.5" /> DELETE /offers/[id]</span>
          </div>
          <div>
            <span className="font-medium text-foreground">Execution lifecycle (provider side):</span>{" "}
            <span className="font-mono">accept <ArrowRight className="inline size-2.5" /> settle | fail | reject</span>
          </div>
          <div>
            <span className="font-medium text-foreground">Obligation lifecycle:</span>{" "}
            <span className="font-mono">GET /obligations <ArrowRight className="inline size-2.5" /> POST /obligations/[id]/fulfill</span>
          </div>
          <div>
            <span className="font-medium text-foreground">Reconciliation:</span>{" "}
            <span className="font-mono">GET /reconcile <ArrowRight className="inline size-2.5" /> POST /reconcile</span> — detect discrepancies between expected and reported amounts.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="relative rounded-md border bg-zinc-950 text-zinc-100 dark:bg-zinc-950 p-3 overflow-x-auto dramp-scroll">
      <Button variant="ghost" size="icon" className="absolute top-1 right-1 size-7 text-zinc-400 hover:text-zinc-100" onClick={copy} title="Copy">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <pre className="text-[11px] leading-relaxed font-mono whitespace-pre">{code}</pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Copied to clipboard");
    });
  }
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={copy}>
            {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">Copy</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
