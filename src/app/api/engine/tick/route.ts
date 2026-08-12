import { NextResponse } from "next/server";
import { manualTick, isTickerRunning } from "@/lib/engine/ticker";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function POST() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  const result = await manualTick();
  return NextResponse.json({ ...result, tickerRunning: isTickerRunning() });
}

// Ticker status — admin-only (consistent with POST). Returns only a boolean.
export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;
  return NextResponse.json({ tickerRunning: isTickerRunning() });
}
