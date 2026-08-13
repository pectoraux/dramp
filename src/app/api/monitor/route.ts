import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeExecution, serializeIntent } from "@/lib/engine/serialize";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;

  const userFilter = isAdmin(auth) ? {} : { intent: { userId: auth.id } };
  const intentFilter = isAdmin(auth) ? {} : { userId: auth.id };

  // Lightweight monitor query — no advancement here (keeps it fast on Neon).
  const activeExecutions = await db.execution.findMany({
    where: { status: { notIn: ["COMPLETED", "EXPIRED", "CANCELLED", "FAILED", "REFUNDED"] }, ...userFilter },
    include: { intent: true },
    orderBy: { startedAt: "desc" },
  });
  const recentIntents = await db.executionIntent.findMany({
    where: intentFilter,
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const providerCount = await db.liquidityProvider.count();
  const offerCount = await db.liquidityOffer.count({ where: { active: true } });
  const tickerRunning = !!(globalThis as any).__drampEngineTicker;

  return NextResponse.json({
    activeExecutions: activeExecutions.map(serializeExecution),
    recentIntents: recentIntents.map(serializeIntent),
    stats: {
      providerCount,
      offerCount,
      tickerRunning,
      activeCount: activeExecutions.length,
    },
  });
}
