"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { RiskBars } from "./risk-bars";
import type { PreviewRoute } from "./types";
import {
  routeTagColor,
  formatMoney,
  formatRate,
  formatBps,
  formatDuration,
  prettyEnum,
} from "./format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Clock,
  Coins,
  HandCoins,
  Layers,
  Route as RouteIcon,
  Zap,
  AlertTriangle,
} from "lucide-react";

interface RouteCardProps {
  route: PreviewRoute;
  destinationAsset: string;
  sourceAsset: string;
  onExecute?: () => void;
  executing?: boolean;
  disabled?: boolean;
  index?: number;
}

export function RouteCard({
  route,
  destinationAsset,
  sourceAsset,
  onExecute,
  executing,
  disabled,
  index = 0,
}: RouteCardProps) {
  const rejected = !!route.hardFilterRejection;
  const isBest = route.tag === "BEST";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.05, 0.3) }}
    >
      <Card
        className={cn(
          "relative overflow-hidden py-4",
          isBest && !rejected && "border-emerald-500/60 ring-1 ring-emerald-500/30",
          rejected && "opacity-80",
        )}
      >
        {isBest && !rejected && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-emerald-500 to-transparent" />
        )}
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={cn(routeTagColor(route.tag))}>
                {route.tag}
              </Badge>
              {route.split && (
                <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300">
                  <Layers className="size-3" /> Split
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {route.hopCount} {route.hopCount === 1 ? "hop" : "hops"}
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" />
              {formatDuration(route.expectedExecutionSeconds)}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {rejected ? (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300 flex gap-2">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Route rejected by hard filter</div>
                <div className="text-xs opacity-90 mt-0.5">{route.hardFilterRejection}</div>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-foreground/90 leading-relaxed">{route.explanation}</p>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Metric
                  icon={<Coins className="size-3" />}
                  label="Net output"
                  value={`${formatMoney(route.netOutput)} ${destinationAsset}`}
                  highlight={isBest}
                />
                <Metric
                  icon={<HandCoins className="size-3" />}
                  label="Eff. cost"
                  value={`${formatMoney(route.effectiveCost)} ${sourceAsset}`}
                />
                <Metric
                  icon={<RouteIcon className="size-3" />}
                  label="Gross out"
                  value={`${formatMoney(route.grossOutput)} ${destinationAsset}`}
                />
                <Metric
                  icon={<Zap className="size-3" />}
                  label="Incentive"
                  value={route.incentiveBps ? formatBps(route.incentiveBps) : "—"}
                />
              </div>

              <Separator />

              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Risk dimensions</div>
                <RiskBars risk={route.risk} compact />
              </div>

              <Separator />

              <div>
                <div className="text-xs text-muted-foreground mb-2">Leg breakdown</div>
                <div className="space-y-2">
                  {route.legs.map((leg, i) => (
                    <div key={i} className="rounded-md border bg-muted/30 p-2.5">
                      <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          <span className="text-xs font-medium truncate">{leg.providerName}</span>
                          <Badge variant="outline" className="text-[10px] py-0 h-4">
                            {prettyEnum(leg.providerType)}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] py-0 h-4">
                            {prettyEnum(leg.trustModel)}
                          </Badge>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] py-0 h-4",
                            leg.channelType === "MANUAL"
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                          )}
                        >
                          {leg.channelType}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-xs flex-wrap">
                        <span className="font-mono">
                          {formatMoney(leg.amount)} {leg.sourceAsset}
                        </span>
                        <ArrowRight className="size-3 text-muted-foreground" />
                        <span className="font-mono">
                          {leg.destinationAsset}
                        </span>
                        <span className="text-muted-foreground ml-auto">
                          rate {formatRate(leg.rate)}
                          {leg.feeBps ? ` · fee ${leg.feeBps}bps` : ""}
                          {leg.incentiveBps ? ` · inc ${leg.incentiveBps}bps` : ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {onExecute && (
                <Button
                  onClick={onExecute}
                  disabled={disabled || executing}
                  className={cn("w-full", isBest && "bg-emerald-600 hover:bg-emerald-700 text-white")}
                >
                  {executing ? "Executing…" : `Execute ${route.tag} route`}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function Metric({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "text-sm font-mono tabular-nums mt-0.5",
          highlight && "text-emerald-600 dark:text-emerald-400 font-semibold",
        )}
      >
        {value}
      </div>
    </div>
  );
}
