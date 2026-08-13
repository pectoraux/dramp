"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "./status-badge";
import { CommitmentBadge } from "./commitment-badge";
import { ExecutionDetail } from "./execution-detail";
import { usePolling } from "@/hooks/use-polling";
import { formatMoney, formatDuration, shortId, prettyEnum } from "./format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { ArrowRight, Inbox, RefreshCw } from "lucide-react";
import type { ExecutionsListResponse, Execution } from "./types";

interface ExecutionsPanelProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  autoSelectLatest?: boolean;
}

export function ExecutionsPanel({ selectedId, onSelect, autoSelectLatest }: ExecutionsPanelProps) {
  const { data, loading, refetch } = usePolling<ExecutionsListResponse>("/api/executions?limit=50", 2000);
  const executions = data?.executions ?? [];

  // Auto-select latest when asked (e.g. after creating an intent).
  if (autoSelectLatest && !selectedId && executions.length > 0 && executions[0]) {
    // Defer to next tick to avoid setState during render.
    queueMicrotask(() => onSelect(executions[0].id));
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_1fr] gap-4">
      {/* Left: list */}
      <Card className="py-3">
        <div className="flex items-center justify-between px-4 pb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Executions</h3>
            <Badge variant="outline" className="text-[10px] py-0 h-4">{executions.length}</Badge>
          </div>
          <Button variant="ghost" size="icon" className="size-6" onClick={refetch} title="Refresh">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
        <CardContent className="px-2 pb-2">
          {loading && executions.length === 0 ? (
            <div className="space-y-2 px-2">
              {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : executions.length === 0 ? (
            <div className="text-center py-12 px-4">
              <Inbox className="size-8 text-muted-foreground/50 mx-auto mb-2" />
              <div className="text-sm text-muted-foreground">No executions yet.</div>
              <div className="text-xs text-muted-foreground/70 mt-1">
                Head to the <span className="font-medium text-foreground">Send</span> tab to create one.
              </div>
            </div>
          ) : (
            <div className="dramp-scroll max-h-[calc(100vh-220px)] overflow-y-auto space-y-1 px-1">
              {executions.map((ex) => (
                <ExecutionRow
                  key={ex.id}
                  execution={ex}
                  selected={ex.id === selectedId}
                  onSelect={() => onSelect(ex.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Right: detail */}
      <div className="min-w-0">
        <ExecutionDetail executionId={selectedId} />
      </div>
    </div>
  );
}

function ExecutionRow({
  execution,
  selected,
  onSelect,
}: {
  execution: Execution;
  selected: boolean;
  onSelect: () => void;
}) {
  const intent = execution.intent;
  const tag = execution.selectedRoute?.tag;
  return (
    <motion.button
      layout
      onClick={onSelect}
      whileHover={{ x: 2 }}
      className={cn(
        "w-full text-left rounded-md border p-2.5 transition-colors",
        selected
          ? "border-emerald-500/60 bg-emerald-500/5 ring-1 ring-emerald-500/30"
          : "border-border hover:bg-muted/40",
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs font-mono text-muted-foreground">{shortId(execution.id, 10)}</span>
        <StatusBadge status={execution.status} className="text-[10px] py-0 h-4" />
      </div>
      <div className="flex items-center gap-1.5 text-xs flex-wrap">
        <span className="font-mono tabular-nums">{formatMoney(intent?.sourceAmount)} {intent?.sourceAsset}</span>
        <ArrowRight className="size-3 text-muted-foreground" />
        <span className="font-mono">{intent?.destinationAsset}</span>
        <span className="text-muted-foreground text-[10px]">· {intent?.sourceCountry}→{intent?.destinationCountry}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <CommitmentBadge status={execution.commitmentStatus} className="text-[10px] py-0 h-4" withTooltip={false} />
        {tag && (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
            {tag}
          </Badge>
        )}
        {execution.waitedSeconds > 0 && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            waited {formatDuration(execution.waitedSeconds)}
          </span>
        )}
      </div>
    </motion.button>
  );
}
