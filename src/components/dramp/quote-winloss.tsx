"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { usePolling } from "@/hooks/use-polling";
import { cn } from "@/lib/utils";
import { formatRatePercent, formatTimestamp, prettyEnum } from "./format";
import { Trophy, XCircle, TrendingUp, Target } from "lucide-react";
import type { QuoteWinLossResponse } from "./types";

const LOSS_REASON_LABEL: Record<string, string> = {
  higher_cost: "Higher cost",
  slower: "Slower",
  less_competitive: "Less competitive",
  higher_risk: "Higher risk",
  manual_channel: "Manual channel",
  lower_reputation: "Lower reputation",
};

export function QuoteWinLoss({ providerId }: { providerId: string | null }) {
  const { data, loading } = usePolling<QuoteWinLossResponse | null>(
    providerId ? `/api/economics/winloss/${encodeURIComponent(providerId)}` : null,
    5000,
  );

  if (!providerId) {
    return (
      <Card className="py-10 border-dashed">
        <CardContent className="text-center text-sm text-muted-foreground">
          Select a provider to view its quote win/loss analytics.
        </CardContent>
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const winRate = data.winRate;
  const winRatePct = Math.round(winRate * 100);

  return (
    <div className="space-y-3">
      {/* Win rate headline */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card className="md:col-span-2 py-3 border-emerald-500/30">
          <CardContent className="py-1">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <Target className="size-3 text-emerald-500" /> Win rate
                </div>
                <div className="text-3xl font-mono tabular-nums font-semibold mt-0.5 text-emerald-600 dark:text-emerald-400">
                  {winRatePct}%
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {data.wins} wins / {data.losses} losses · {data.totalQuotes} total quotes
                </div>
              </div>
              <div className="w-24">
                <Progress value={winRatePct} className="h-2 bg-muted" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="py-3">
          <CardContent className="py-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Trophy className="size-3 text-emerald-500" /> Wins
            </div>
            <div className="text-2xl font-mono tabular-nums mt-0.5 text-emerald-600 dark:text-emerald-400">{data.wins}</div>
          </CardContent>
        </Card>

        <Card className="py-3">
          <CardContent className="py-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <XCircle className="size-3 text-rose-500" /> Losses
            </div>
            <div className="text-2xl font-mono tabular-nums mt-0.5 text-rose-600 dark:text-rose-400">{data.losses}</div>
          </CardContent>
        </Card>
      </div>

      {/* Loss reasons */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="size-4 text-emerald-500" /> Loss reasons
          </CardTitle>
          <CardDescription className="text-xs">Why this provider lost quotes it competed for.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {Object.keys(data.lossReasons).length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No losses recorded yet.</div>
          ) : (
            <div className="space-y-2">
              {Object.entries(data.lossReasons)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => {
                  const total = Object.values(data.lossReasons).reduce((s, v) => s + v, 0);
                  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                  return (
                    <div key={reason} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium">{LOSS_REASON_LABEL[reason] ?? prettyEnum(reason)}</span>
                        <span className="text-muted-foreground">{count} ({pct}%)</span>
                      </div>
                      <Progress value={pct} className="h-1.5 bg-muted" />
                    </div>
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent results */}
      <Card className="py-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Recent results
            <Badge variant="outline" className="text-[10px] py-0 h-4">{data.recentResults.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs">Last 10 quotes this provider competed in.</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {data.recentResults.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No quote results yet.</div>
          ) : (
            <div className="dramp-scroll max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b sticky top-0 bg-card">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">When</th>
                    <th className="text-left font-medium px-2 py-1.5">Corridor</th>
                    <th className="text-left font-medium px-2 py-1.5">Result</th>
                    <th className="text-right font-medium px-2 py-1.5">Our fee</th>
                    <th className="text-right font-medium px-2 py-1.5">Winner fee</th>
                    <th className="text-left font-medium px-2 py-1.5">Reason lost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentResults.map((r, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{formatTimestamp(r.createdAt)}</td>
                      <td className="px-2 py-1.5 font-mono">{r.corridor}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="outline" className={cn("text-[10px] py-0 h-4", r.result === "WON" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : r.result === "LOST" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-border bg-muted text-muted-foreground")}>
                          {r.result}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.ourFeeBps ?? "—"} bps</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.winnerFeeBps ?? "—"} bps</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {r.reasonLost ? (LOSS_REASON_LABEL[r.reasonLost] ?? prettyEnum(r.reasonLost)) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
