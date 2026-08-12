import { NextResponse } from "next/server";
import { manualTick, isTickerRunning, advanceActiveExecutions } from "@/lib/engine/ticker";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function POST() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await manualTick();
  return NextResponse.json({ ...result, tickerRunning: isTickerRunning() });
}

export async function GET() {
  return NextResponse.json({ tickerRunning: isTickerRunning() });
}
