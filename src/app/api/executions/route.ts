import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeExecution } from "@/lib/engine/serialize";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const status = url.searchParams.get("status");
  const executions = await db.execution.findMany({
    where: status ? { status } : undefined,
    include: {
      intent: true,
      routes: { include: { legs: { include: { provider: true } } } },
      obligations: { include: { provider: true } },
      legs: { include: { provider: true, offer: true } },
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ executions: executions.map(serializeExecution) });
}
