"use client";

import { HAPPY_PATH } from "@/lib/engine/types";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const FAILURE_STATES = new Set(["EXPIRED", "CANCELLED", "FAILED", "DISPUTED", "REFUNDED"]);

// Compact labels for the 12 happy-path states.
const SHORT_LABELS: Record<string, string> = {
  INTENT_CREATED: "Intent",
  SEARCHING: "Search",
  ROUTE_FOUND: "Found",
  ROUTE_RESERVED: "Reserved",
  ORIGIN_PENDING: "Origin",
  ORIGIN_CONFIRMED: "Origin ✓",
  TOKENIZED: "Tokenized",
  SETTLEMENT_PENDING: "Settle",
  SETTLED: "Settled",
  DESTINATION_PENDING: "Dest",
  DESTINATION_CONFIRMED: "Dest ✓",
  COMPLETED: "Done",
};

interface StateStepperProps {
  status: string;
  className?: string;
}

export function StateStepper({ status, className }: StateStepperProps) {
  const failed = FAILURE_STATES.has(status);
  const currentIndex = HAPPY_PATH.indexOf(status);

  if (failed) {
    return (
      <div className={cn("rounded-md border border-rose-500/50 bg-rose-500/10 px-3 py-2", className)}>
        <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-300">
          <X className="size-4" />
          <span className="font-medium">Terminal failure: {status}</span>
        </div>
        <div className="text-xs text-rose-600/80 dark:text-rose-300/80 mt-0.5">
          This execution did not complete via the happy path.
        </div>
      </div>
    );
  }

  return (
    <div className={cn("w-full overflow-x-auto dramp-scroll", className)}>
      <div className="flex items-center min-w-max gap-0 py-1">
        {HAPPY_PATH.map((s, i) => {
          const done = i < currentIndex || status === "COMPLETED";
          const active = i === currentIndex && status !== "COMPLETED";
          const isLast = i === HAPPY_PATH.length - 1;
          return (
            <TooltipProvider key={s} delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center">
                    <motion.div
                      initial={false}
                      animate={{
                        scale: active ? 1.05 : 1,
                      }}
                      transition={{ duration: 0.2 }}
                      className={cn(
                        "flex flex-col items-center gap-1",
                      )}
                    >
                      <div
                        className={cn(
                          "flex size-6 items-center justify-center rounded-full border text-[10px] font-medium transition-colors",
                          done && "border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
                          active && "border-emerald-500 bg-emerald-500 text-white dramp-pulse",
                          !done && !active && "border-border bg-muted text-muted-foreground",
                        )}
                      >
                        {done ? <Check className="size-3" /> : i + 1}
                      </div>
                      <span
                        className={cn(
                          "text-[10px] whitespace-nowrap",
                          active ? "text-emerald-600 dark:text-emerald-300 font-medium" : "text-muted-foreground",
                        )}
                      >
                        {SHORT_LABELS[s] ?? s}
                      </span>
                    </motion.div>
                    {!isLast && (
                      <div
                        className={cn(
                          "h-px w-5 sm:w-8 mx-0.5 -mt-4",
                          i < currentIndex ? "bg-emerald-500/50" : "bg-border",
                        )}
                      />
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {s.replace(/_/g, " ")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </div>
    </div>
  );
}
