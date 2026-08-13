"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
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
import { formatMoney, formatTimestamp, toNum, shortId, prettyEnum } from "./format";
import { FileText, ArrowUpCircle, ArrowDownCircle, ShieldCheck, RefreshCw } from "lucide-react";
import type { ProviderStatementResponse } from "./types";

const DAYS_OPTIONS = ["7", "30", "90"];

const ENTRY_TYPE_COLOR: Record<string, string> = {
  FEE: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  INCENTIVE: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300",
  SLASH: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  COMPENSATION: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  REFUND: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300",
  LOCK: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300",
  RELEASE: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300",
};

export function ProviderStatement({ providerId }: { providerId: string | null }) {
  const [days, setDays] = useState<string>("30");
  const daysNum = Number(days);

  const url = providerId
    ? `/api/economics/statement/${encodeURIComponent(providerId)}?days=${daysNum}`
    : null;
  const { data, loading } = usePolling<ProviderStatementResponse>(url, 10000);

  if (!providerId) {
    return (
      <Card className="py-10 border-dashed">
        <CardContent className="text-center text-sm text-muted-foreground">
          Select a provider to view its statement.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <FileText className="size-4 text-emerald-500" />
            Provider statement
          </h3>
          <p className="text-xs text-muted-foreground">
            Categorized ledger entries — reconciles against the on-disk double-entry ledger.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-[10px] text-muted-foreground">Period</Label>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DAYS_OPTIONS.map((d) => <SelectItem key={d} value={d}>Last {d} days</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !data ? null : (
        <StatementBody data={data} />
      )}
    </div>
  );
}

function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("text-[10px] uppercase tracking-wide", className)}>{children}</span>;
}

function StatementBody({ data }: { data: ProviderStatementResponse }) {
  const s = data.summary;
  const entries = data.entries ?? [];

  // Net change as the closing balance (relative to opening = 0 over the window).
  const opening = 0;
  const closing = toNum(s.netChange);
  const periodStart = data.period?.start ? formatTimestamp(data.period.start) : "—";
  const periodEnd = data.period?.end ? formatTimestamp(data.period.end) : "—";

  return (
    <div className="space-y-3">
      {/* Opening / Closing summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="py-3">
          <CardContent className="py-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Opening balance</div>
            <div className="text-xl font-mono tabular-nums mt-0.5">{formatMoney(opening)}</div>
            <div className="text-[10px] text-muted-foreground">{periodStart}</div>
          </CardContent>
        </Card>
        <Card className="py-3 border-emerald-500/30">
          <CardContent className="py-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Net change</div>
            <div className={cn(
              "text-xl font-mono tabular-nums mt-0.5 font-semibold",
              closing > 0 && "text-emerald-600 dark:text-emerald-400",
              closing < 0 && "text-rose-600 dark:text-rose-400",
              closing === 0 && "text-muted-foreground",
            )}>
              {closing > 0 ? "+" : ""}{formatMoney(closing)}
            </div>
            <div className="text-[10px] text-muted-foreground">{s.entryCount} entries</div>
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardContent className="py-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Closing balance</div>
            <div className="text-xl font-mono tabular-nums mt-0.5">{formatMoney(closing)}</div>
            <div className="text-[10px] text-muted-foreground">{periodEnd}</div>
          </CardContent>
        </Card>
      </div>

      {/* Category summary */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-500" /> Categorized totals
          </CardTitle>
          <CardDescription className="text-xs">Reconciled against ledger entries.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            <SummaryTile label="Execution fees" value={s.executionFees} positive />
            <SummaryTile label="Incentives" value={s.incentives} positive />
            <SummaryTile label="Slashing" value={s.slashing} negative />
            <SummaryTile label="Compensation" value={s.compensation} negative />
            <SummaryTile label="Refunds" value={s.refunds} />
            <SummaryTile label="Net change" value={s.netChange} highlight />
          </div>
        </CardContent>
      </Card>

      {/* Entries table */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <RefreshCw className="size-4 text-emerald-500" /> Ledger entries
            <Badge variant="outline" className="text-[10px] py-0 h-4">{entries.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">Sorted ascending by timestamp.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {entries.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6">No ledger entries in this period.</div>
          ) : (
            <div className="dramp-scroll max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Timestamp</th>
                    <th className="text-left font-medium px-2 py-1.5">Type</th>
                    <th className="text-left font-medium px-2 py-1.5">Asset</th>
                    <th className="text-right font-medium px-2 py-1.5">Amount</th>
                    <th className="text-right font-medium px-2 py-1.5">Signed</th>
                    <th className="text-left font-medium px-2 py-1.5">Execution</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => {
                    const signed = toNum(e.signedAmount);
                    return (
                      <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{formatTimestamp(e.timestamp)}</td>
                        <td className="px-2 py-1.5">
                          <Badge variant="outline" className={cn("text-[10px] py-0 h-4", ENTRY_TYPE_COLOR[e.type] ?? "border-border bg-muted text-muted-foreground")}>
                            {prettyEnum(e.type)}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 font-mono">{e.asset}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(e.amount, 6)}</td>
                        <td className={cn("px-2 py-1.5 text-right font-mono tabular-nums", signed > 0 ? "text-emerald-600 dark:text-emerald-400" : signed < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                          {signed > 0 ? "+" : ""}{formatMoney(signed, 6)}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground font-mono">{e.executionId ? shortId(e.executionId) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  positive,
  negative,
  highlight,
}: {
  label: string;
  value: string;
  positive?: boolean;
  negative?: boolean;
  highlight?: boolean;
}) {
  const n = toNum(value);
  return (
    <div className={cn(
      "rounded-md border bg-muted/20 p-2",
      highlight && "border-emerald-500/40 bg-emerald-500/5",
    )}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={cn(
        "text-sm font-mono tabular-nums mt-0.5",
        positive && n > 0 && "text-emerald-600 dark:text-emerald-400",
        negative && n > 0 && "text-rose-600 dark:text-rose-400",
        highlight && (n > 0 ? "text-emerald-600 dark:text-emerald-400" : n < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"),
      )}>
        {formatMoney(value, 2)}
      </div>
    </div>
  );
}
