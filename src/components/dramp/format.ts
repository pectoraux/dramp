// Formatting + color helpers for dRamp UI.

export function formatMoney(
  value: string | number | null | undefined,
  decimals = 2,
): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatRate(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return "—";
  return n.toFixed(4);
}

export function formatBps(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "0";
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return "0";
  return `${n} bps`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", {
    hour12: false,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return "—";
  return id.slice(0, len);
}

export function toNum(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return isFinite(n) ? n : 0;
}

/** Execution status → tailwind classes (text/bg/border) + label. */
export function statusColor(status: string): {
  label: string;
  cls: string;
  dotCls: string;
} {
  switch (status) {
    case "COMPLETED":
      return {
        label: "Completed",
        cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        dotCls: "bg-emerald-500",
      };
    case "SEARCHING":
      return {
        label: "Searching",
        cls: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
        dotCls: "bg-sky-500",
      };
    case "ROUTE_FOUND":
    case "ROUTE_RESERVED":
    case "ORIGIN_PENDING":
    case "ORIGIN_CONFIRMED":
    case "TOKENIZED":
    case "SETTLEMENT_PENDING":
    case "SETTLED":
    case "DESTINATION_PENDING":
    case "DESTINATION_CONFIRMED":
    case "INTENT_CREATED":
      return {
        label: prettyStatus(status),
        cls: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
        dotCls: "bg-emerald-500",
      };
    case "EXPIRED":
      return {
        label: "Expired",
        cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        dotCls: "bg-amber-500",
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
        dotCls: "bg-zinc-500",
      };
    case "FAILED":
    case "DISPUTED":
    case "REFUNDED":
      return {
        label: prettyStatus(status),
        cls: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
        dotCls: "bg-rose-500",
      };
    default:
      return {
        label: status,
        cls: "border-border bg-muted text-muted-foreground",
        dotCls: "bg-muted-foreground",
      };
  }
}

export function prettyStatus(status: string): string {
  if (!status) return "—";
  return status
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function commitmentColor(status: string): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "REVERSIBLE":
      return {
        label: "Reversible",
        cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      };
    case "PARTIALLY_COMMITTED":
      return {
        label: "Partially Committed",
        cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      };
    case "IRREVERSIBLE":
      return {
        label: "Irreversible",
        cls: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
      };
    default:
      return {
        label: status,
        cls: "border-border bg-muted text-muted-foreground",
      };
  }
}

export function commitmentExplanation(status: string): string {
  switch (status) {
    case "REVERSIBLE":
      return "No funds have moved yet. Cancellation is free — the execution is dropped and nothing is committed.";
    case "PARTIALLY_COMMITTED":
      return "The origin leg is in progress (e.g. fiat received, being tokenized). Cancelling may strand inflight value and require manual reconciliation — use caution.";
    case "IRREVERSIBLE":
      return "Settlement has been committed on-chain. The transaction cannot be reversed — funds have left source custody. Any recovery would require a new, separate transaction.";
    default:
      return "";
  }
}

/** Route tag → colored badge class. */
export function routeTagColor(tag: string): string {
  switch (tag) {
    case "BEST":
      return "border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 font-semibold";
    case "CHEAPEST":
      return "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300";
    case "FASTEST":
      return "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300";
    case "SAFEST":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
    case "CANDIDATE":
    default:
      return "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300";
  }
}

/** Risk dimension value (0..1) → tailwind bar color. */
export function riskBarColor(value: number): string {
  if (value >= 0.66) return "bg-rose-500";
  if (value >= 0.4) return "bg-amber-500";
  return "bg-emerald-500";
}

/** Risk dimension label/value display. */
export function riskLabel(value: number): string {
  if (value >= 0.66) return "High";
  if (value >= 0.4) return "Medium";
  return "Low";
}

/** Audit event category for color coding. */
export function auditCategoryColor(eventType: string): string {
  const t = eventType.toLowerCase();
  if (t.includes("fail") || t.includes("slash") || t.includes("dispute"))
    return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300";
  if (t.includes("expire") || t.includes("cancel") || t.includes("refund"))
    return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300";
  if (t.includes("collateral") || t.includes("lock") || t.includes("release"))
    return "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300";
  if (t.includes("settle") || t.includes("payout") || t.includes("complete"))
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
  if (t.includes("intent") || t.includes("route") || t.includes("leg"))
    return "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300";
  if (t.includes("market") || t.includes("signal") || t.includes("liquidity"))
    return "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300";
  return "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300";
}

export function prettyEnum(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const ASSET_OPTIONS = ["USD", "EUR", "USDC", "SC", "WETH"] as const;
export const COUNTRY_OPTIONS = ["US", "EU", "GLOBAL", "PH"] as const;
export const RISK_OPTIONS = ["MAX_RELIABILITY", "BALANCED", "LOWEST_COST"] as const;
export const POLICY_OPTIONS = ["NOW", "WAIT_FOR_BETTER"] as const;
