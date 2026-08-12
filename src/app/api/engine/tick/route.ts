import { NextResponse } from "next/server";
import { manualTick, isTickerRunning } from "@/lib/engine/ticker";

export async function POST() {
  const result = await manualTick();
  return NextResponse.json({ ...result, tickerRunning: isTickerRunning() });
}

export async function GET() {
  return NextResponse.json({ tickerRunning: isTickerRunning() });
}
