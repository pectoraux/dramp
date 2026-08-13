"use client";

import { Badge } from "@/components/ui/badge";
import { statusColor, prettyStatus, prettyEnum } from "./format";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string | null | undefined;
  className?: string;
  showDot?: boolean;
}

export function StatusBadge({ status, className, showDot = true }: StatusBadgeProps) {
  if (!status) {
    return <Badge variant="outline" className={cn("text-muted-foreground", className)}>—</Badge>;
  }
  const c = statusColor(status);
  return (
    <Badge variant="outline" className={cn(c.cls, className)}>
      {showDot && (
        <span className={cn("inline-block size-1.5 rounded-full", c.dotCls)} aria-hidden />
      )}
      {c.label}
    </Badge>
  );
}

export function EnumBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  if (!value) return null;
  return (
    <Badge variant="outline" className={cn("border-border bg-muted/50 text-muted-foreground", className)}>
      {prettyEnum(value)}
    </Badge>
  );
}
