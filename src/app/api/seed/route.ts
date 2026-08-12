import { NextRequest, NextResponse } from "next/server";
import { seedDatabase } from "@/lib/engine/seed";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const reset = body?.reset === true;
  try {
    const result = await seedDatabase({ reset });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "seed failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const count = await import("@/lib/db").then((m) => m.db.settlementAsset.count());
  return NextResponse.json({ seeded: count > 0, settlementAssets: count });
}
