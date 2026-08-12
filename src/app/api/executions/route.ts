import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeExecution } from "@/lib/engine/serialize";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const status = url.searchParams.get("status");
  // Lightweight list query — no advancement here (keeps it fast on Neon).
  // Advancement happens on the detail endpoints via advanceOneOnDemand.
  const executions = await db.execution.findMany({
    where: status ? { status } : undefined,
    include: {
      intent: true,
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ executions: executions.map(serializeExecution) });
}
