import { NextResponse } from "next/server";
import { getExecutionQueue } from "@/lib/provider-api/ops";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const queue = await getExecutionQueue();
  return NextResponse.json({ queue });
}
