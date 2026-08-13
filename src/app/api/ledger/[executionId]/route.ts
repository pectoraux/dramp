import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeLedgerEntry } from "@/lib/engine/serialize";
import { requireUser, isAuthed, requireExecutionOwnership } from "@/lib/auth-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ executionId: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { executionId } = await params;

  // Ownership check.
  const owned = await requireExecutionOwnership(executionId, auth);
  if (!owned.ok) return owned.error;

  const entries = await db.ledgerEntry.findMany({
    where: { executionId },
    orderBy: { timestamp: "asc" },
  });
  const balances = new Map<string, { asset: string; balance: number }>();
  for (const e of entries) {
    const dKey = `${e.debitAccount}:${e.asset}`;
    const cKey = `${e.creditAccount}:${e.asset}`;
    const damt = Number(e.amount.toString());
    balances.set(dKey, { asset: e.asset, balance: (balances.get(dKey)?.balance ?? 0) + damt });
    balances.set(cKey, { asset: e.asset, balance: (balances.get(cKey)?.balance ?? 0) - damt });
  }
  return NextResponse.json({
    entries: entries.map(serializeLedgerEntry),
    balances: [...balances.entries()].map(([account, v]) => ({ account, asset: v.asset, balance: v.balance })),
  });
}
