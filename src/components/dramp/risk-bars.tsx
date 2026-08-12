"use client";

import { riskBarColor, riskLabel, toNum } from "./format";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface RiskBarsProps {
  risk: {
    counterparty?: number;
    settlementAsset?: number;
    liquidity?: number;
    operational?: number;
    duration?: number;
    composite?: number;
  } | null | undefined;
  compact?: boolean;
  className?: string;
}

const DIMENSIONS: { key: keyof NonNullable<RiskBarsProps["risk"]>; label: string }[] = [
  { key: "counterparty", label: "Counterparty" },
  { key: "settlementAsset", label: "Settlement Asset" },
  { key: "liquidity", label: "Liquidity" },
  { key: "operational", label: "Operational" },
  { key: "duration", label: "Duration" },
];

export function RiskBars({ risk, compact = false, className }: RiskBarsProps) {
  if (!risk) return null;

  if (compact) {
    // 5 mini bars
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        {DIMENSIONS.map((d) => {
          const v = toNum(risk[d.key] as number);
          return (
            <TooltipProvider key={d.key} delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex flex-col gap-0.5 items-center">
                    <div className="h-8 w-1.5 rounded-full bg-muted overflow-hidden flex flex-col-reverse">
                      <div
                        className={cn("w-full rounded-full", riskBarColor(v))}
                        style={{ height: `${Math.max(8, Math.min(100, v * 100))}%` }}
                      />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {d.label}: {(v * 100).toFixed(0)}% — {riskLabel(v)}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
        <div className="ml-2 flex flex-col items-center">
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn(
                  "text-xs font-bold tabular-nums",
                  riskBarColor(toNum(risk.composite)).replace("bg-", "text-")
                )}>
                  {(toNum(risk.composite) * 100).toFixed(0)}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                Composite risk
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {DIMENSIONS.map((d) => {
        const v = toNum(risk[d.key] as number);
        return (
          <div key={d.key} className="grid grid-cols-[110px_1fr_44px] items-center gap-2">
            <span className="text-xs text-muted-foreground">{d.label}</span>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full", riskBarColor(v))}
                style={{ width: `${Math.max(2, Math.min(100, v * 100))}%` }}
              />
            </div>
            <span className="text-xs tabular-nums text-right">
              {(v * 100).toFixed(0)}%
            </span>
          </div>
        );
      })}
      <div className="grid grid-cols-[110px_1fr_44px] items-center gap-2 pt-1 border-t">
        <span className="text-xs font-medium">Composite</span>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn("h-full rounded-full", riskBarColor(toNum(risk.composite)))}
            style={{ width: `${Math.max(2, Math.min(100, toNum(risk.composite) * 100))}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-right font-medium">
          {(toNum(risk.composite) * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
