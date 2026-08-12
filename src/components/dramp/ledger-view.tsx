"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ArrowLeftRight, BookOpen, ChevronDown, Scale } from "lucide-react";
import { formatMoney, formatTimestamp, prettyEnum } from "./format";
import { cn } from "@/lib/utils";
import { useState } from "react";
import type { LedgerResponse } from "./types";

interface LedgerViewProps {
  /** Accepts either the wrapper {entries, balances} or a raw array of entries. */
  ledger: LedgerResponse | LedgerEntry[] | null | undefined;
  className?: string;
  defaultOpen?: boolean;
}

const ENTRY_TYPE_COLOR: Record<string, string> = {
  MINT: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  BURN: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  TRANSFER: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300",
  LOCK: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300",
  RELEASE: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300",
  SLASH: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  FEE: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
  INCENTIVE: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300",
  COMPENSATION: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  REFUND: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
};

export function LedgerView({ ledger, className, defaultOpen = false }: LedgerViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isWrapper = ledger && !Array.isArray(ledger) && typeof ledger === "object" && "entries" in (ledger as any);
  const entries = Array.isArray(ledger)
    ? ledger
    : (ledger as LedgerResponse | null | undefined)?.entries ?? [];
  const providedBalances = isWrapper
    ? (ledger as LedgerResponse).balances ?? []
    : [];

  // Compute running balances client-side if the API didn't provide them.
  const balances = providedBalances.length > 0
    ? providedBalances
    : computeBalances(entries);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <Card className="py-3">
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-0 cursor-pointer">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <BookOpen className="size-4 text-emerald-500" />
                Double-entry ledger
                <Badge variant="outline" className="text-[10px] py-0 h-4">{entries.length} entries</Badge>
              </span>
              <Button variant="ghost" size="icon" className="size-6">
                <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
              </Button>
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-3 space-y-3">
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Time</th>
                    <th className="text-left font-medium px-2 py-1.5">Type</th>
                    <th className="text-left font-medium px-2 py-1.5">Debit ← Credit</th>
                    <th className="text-right font-medium px-2 py-1.5">Amount</th>
                    <th className="text-left font-medium px-2 py-1.5 hidden md:table-cell">Description</th>
                  </tr>
                </thead>
                <tbody className="dramp-scroll max-h-72 overflow-y-auto block">
                  {entries.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">No ledger entries.</td></tr>
                  )}
                  {entries.map((e, i) => (
                    <tr key={i} className="border-t hover:bg-muted/30">
                      <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground align-top whitespace-nowrap">
                        {formatTimestamp(e.timestamp)}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", ENTRY_TYPE_COLOR[e.entryType] ?? "")}>
                          {e.entryType}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px]">{e.debitAccount}</span>
                          <ArrowLeftRight className="size-2.5 text-muted-foreground" />
                          <span className="font-mono text-[10px]">{e.creditAccount}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 align-top text-right font-mono tabular-nums">
                        {formatMoney(e.amount)} <span className="text-muted-foreground">{e.asset}</span>
                      </td>
                      <td className="px-2 py-1.5 align-top text-muted-foreground hidden md:table-cell text-[10px]">
                        {e.description ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {balances.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Scale className="size-3" /> Account balances
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
                  {balances.map((b, i) => (
                    <div key={i} className="rounded-md border bg-muted/20 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground font-mono truncate">{b.account}</div>
                      <div className="text-xs font-mono tabular-nums">
                        {formatMoney(b.balance)} <span className="text-muted-foreground">{b.asset}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/** Compute running balances per account:asset from a list of ledger entries.
 *  Mirrors the server-side logic in /api/ledger/[executionId]. */
function computeBalances(entries: LedgerEntry[]): { account: string; asset: string; balance: string }[] {
  const map = new Map<string, { asset: string; balance: number }>();
  for (const e of entries) {
    const dKey = `${e.debitAccount}:${e.asset}`;
    const cKey = `${e.creditAccount}:${e.asset}`;
    const amt = Number(e.amount);
    if (!isFinite(amt)) continue;
    const d = map.get(dKey) ?? { asset: e.asset, balance: 0 };
    d.balance += amt;
    map.set(dKey, d);
    const c = map.get(cKey) ?? { asset: e.asset, balance: 0 };
    c.balance -= amt;
    map.set(cKey, c);
  }
  return [...map.entries()].map(([account, v]) => ({
    account,
    asset: v.asset,
    balance: String(Math.round(v.balance * 1e6) / 1e6),
  }));
}
