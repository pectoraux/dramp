import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeExecution, serializeIntent } from "@/lib/engine/serialize";

export async function GET() {
  const activeExecutions = await db.execution.findMany({
    where: { status: { notIn: ["COMPLETED", "EXPIRED", "CANCELLED", "FAILED", "REFUNDED"] } },
    include: {
      intent: true,
      routes: { include: { legs: { include: { provider: true } } } },
      legs: { include: { provider: true } },
    },
    orderBy: { startedAt: "desc" },
  });
  const recentIntents = await db.executionIntent.findMany({
    include: { executions: true },
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
