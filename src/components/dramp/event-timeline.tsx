"use client";

import { auditCategoryColor, formatTimestamp, shortId } from "./format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Hash } from "lucide-react";
import { useState } from "react";
import type { AuditEvent } from "./types";

interface EventTimelineProps {
  events: AuditEvent[] | null | undefined;
  className?: string;
  maxHeight?: string;
}

export function EventTimeline({ events, className, maxHeight = "max-h-96" }: EventTimelineProps) {
  const sorted = [...(events ?? [])].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  if (!sorted.length) {
    return (
      <div className={cn("text-sm text-muted-foreground text-center py-6", className)}>
        No audit events yet.
      </div>
    );
  }

  return (
    <div className={cn("dramp-scroll overflow-y-auto pr-1 space-y-1", maxHeight, className)}>
      {sorted.map((e, i) => (
        <TimelineRow key={e.id ?? i} event={e} />
      ))}
    </div>
  );
}

function TimelineRow({ event }: { event: AuditEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      className="relative pl-4"
    >
      <div className="absolute left-0 top-2 size-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-md border bg-muted/20 hover:bg-muted/40 transition-colors">
          <CollapsibleTrigger asChild>
            <button className="w-full text-left p-2.5 flex items-start gap-2">
              <ChevronRight
                className={cn(
                  "size-3.5 mt-0.5 text-muted-foreground transition-transform shrink-0",
                  open && "rotate-90",
                )}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn("text-[10px] py-0 h-4", auditCategoryColor(event.eventType))}>
                    {event.eventType}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {event.actorType}
                    {event.actorId ? `:${shortId(event.actorId, 6)}` : ""}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {formatTimestamp(event.timestamp)}
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                  <Hash className="size-2.5" />
                  <span className="font-mono">{shortId(event.prevHash, 8)}</span>
                  <span>→</span>
                  <span className="font-mono">{shortId(event.hash, 8)}</span>
                </div>
              </div>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-2.5 pb-2.5 pt-0">
              <pre className="text-[10px] leading-relaxed font-mono bg-muted/60 rounded p-2 overflow-x-auto dramp-scroll">
                {JSON.stringify(event.payload ?? {}, null, 2)}
              </pre>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </motion.div>
  );
}
