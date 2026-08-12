import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeExecution } from "@/lib/engine/serialize";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const status = url.searchParams.get("status");

  // Ownership scoping: ordinary users see only their own executions; admins
  // see all. We join through Execution → ExecutionIntent to filter by userId.
  const where = {
    ...(status ? { status } : {}),
    ...(isAdmin(auth) ? {} : { intent: { userId: auth.id } }),
  };

  const executions = await db.execution.findMany({
    where,
    include: { intent: true },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ executions: executions.map(serializeExecution) });
}
