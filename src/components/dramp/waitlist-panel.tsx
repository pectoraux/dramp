"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { usePolling } from "@/hooks/use-polling";
import { Loader2, UserCheck, UserX, RefreshCw, Mail, Clock, CheckCircle2, XCircle } from "lucide-react";

interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  requestedRole: string;
  status: string;
  note: string | null;
  createdAt: string;
  reviewedAt: string | null;
  createdUserId: string | null;
}

interface WaitlistResponse {
  entries: WaitlistEntry[];
  error?: string;
}

export function WaitlistPanel() {
  const [filter, setFilter] = useState<string>("PENDING");
  const { data, loading, refetch } = usePolling<WaitlistResponse>(
    `/api/admin/waitlist?status=${filter}`,
    5000,
  );
  const [approving, setApproving] = useState<string | null>(null);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [generated, setGenerated] = useState<Record<string, string>>({});

  const entries = data?.entries ?? [];

  async function approve(entry: WaitlistEntry) {
    setApproving(entry.id);
    const pwd = passwords[entry.id]?.trim() || undefined;
    try {
      const res = await fetch(`/api/admin/waitlist/${entry.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: entry.name ?? undefined,
          password: pwd,
          role: entry.requestedRole,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Approval failed");
      if (json.generatedPassword) {
        setGenerated((g) => ({ ...g, [entry.id]: json.generatedPassword }));
        toast.success("Account created", {
          description: `Password: ${json.generatedPassword} — share with ${entry.email}`,
        });
      } else {
        toast.success("Account approved", { description: `${entry.email} can now sign in.` });
      }
      refetch();
    } catch (err) {
      toast.error("Approval failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setApproving(null);
    }
  }

  async function reject(entry: WaitlistEntry) {
    setApproving(entry.id);
    try {
      const res = await fetch(`/api/admin/waitlist/${entry.id}/approve`, { method: "DELETE" });
      if (!res.ok) throw new Error("Reject failed");
      toast.success("Entry rejected");
      refetch();
    } catch (err) {
      toast.error("Reject failed", { description: err instanceof Error ? err.message : "unknown" });
    } finally {
      setApproving(null);
    }
  }

  const filters = [
    { v: "PENDING", label: "Pending" },
    { v: "APPROVED", label: "Approved" },
    { v: "REJECTED", label: "Rejected" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <UserCheck className="size-5 text-emerald-500" /> Waitlist
          </h2>
          <p className="text-xs text-muted-foreground">Review sign-up requests and create accounts.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border overflow-hidden">
            {filters.map((f) => (
              <button
                key={f.v}
                onClick={() => setFilter(f.v)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === f.v ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "hover:bg-accent"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="icon" onClick={() => refetch()} title="Refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No {filter.toLowerCase()} waitlist entries.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2 max-h-[70vh] overflow-y-auto dramp-scroll pr-1">
          {entries.map((e) => (
            <Card key={e.id} className="border-border/60">
              <CardContent className="py-3.5 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{e.name ?? e.email}</span>
                      {e.name && <span className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="size-3" />{e.email}</span>}
                      <Badge
                        variant="outline"
                        className={`text-[9px] py-0 h-4 ${
                          e.requestedRole === "PROVIDER_OPERATOR"
                            ? "border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400"
                            : "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {e.requestedRole === "PROVIDER_OPERATOR" ? "Provider" : "User"}
                      </Badge>
                      <StatusBadge status={e.status} />
                    </div>
                    {e.note && <p className="text-xs text-muted-foreground italic">"{e.note}"</p>}
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock className="size-3" /> {new Date(e.createdAt).toLocaleString()}
                      {e.reviewedAt && <span className="ml-2">reviewed {new Date(e.reviewedAt).toLocaleString()}</span>}
                    </div>
                  </div>
                </div>

                {e.status === "APPROVED" && generated[e.id] && (
                  <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2.5 text-xs">
                    <span className="text-muted-foreground">Generated password for {e.email}: </span>
                    <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{generated[e.id]}</span>
                  </div>
                )}

                {e.status === "PENDING" && (
                  <div className="flex items-end gap-2 flex-wrap">
                    <div className="space-y-1 flex-1 min-w-[180px]">
                      <Label className="text-[10px] text-muted-foreground">Set password (leave blank to auto-generate)</Label>
                      <Input
                        type="text"
                        value={passwords[e.id] ?? ""}
                        onChange={(ev) => setPasswords((p) => ({ ...p, [e.id]: ev.target.value }))}
                        placeholder="auto-generate"
                        className="h-8 text-xs"
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => approve(e)}
                      disabled={approving === e.id}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white h-8"
                    >
                      {approving === e.id ? <Loader2 className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
                      Approve & create
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => reject(e)} disabled={approving === e.id} className="h-8">
                      <UserX className="size-3.5" /> Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "PENDING") return <Badge variant="outline" className="text-[9px] py-0 h-4 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-300"><Clock className="size-2.5" />Pending</Badge>;
  if (status === "APPROVED") return <Badge variant="outline" className="text-[9px] py-0 h-4 border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-2.5" />Approved</Badge>;
  return <Badge variant="outline" className="text-[9px] py-0 h-4 border-rose-500/50 bg-rose-500/10 text-rose-600 dark:text-rose-400"><XCircle className="size-2.5" />Rejected</Badge>;
}
