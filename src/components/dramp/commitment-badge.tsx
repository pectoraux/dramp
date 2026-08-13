"use client";

import { Badge } from "@/components/ui/badge";
import { commitmentColor, commitmentExplanation } from "./format";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShieldCheck, ShieldAlert, ShieldOff } from "lucide-react";

interface CommitmentBadgeProps {
  status: string | null | undefined;
  className?: string;
  withTooltip?: boolean;
}

export function CommitmentBadge({ status, className, withTooltip = true }: CommitmentBadgeProps) {
  if (!status) return null;
  const c = commitmentColor(status);
  const Icon =
    status === "REVERSIBLE" ? ShieldCheck : status === "PARTIALLY_COMMITTED" ? ShieldAlert : ShieldOff;
  const badge = (
    <Badge variant="outline" className={cn(c.cls, className)}>
      <Icon className="size-3" />
      {c.label}
    </Badge>
  );
  if (!withTooltip) return badge;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{badge}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
          {commitmentExplanation(status)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
