import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { seedDatabase } from "@/lib/engine/seed";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

// GET — check whether the marketplace is seeded (used by the UI to show a
// "seed marketplace" call-to-action). Also reports whether an admin exists yet
// (the bootstrap flag): if no admin exists, seeding is allowed without auth.
export async function GET() {
  const settlementAssets = await db.settlementAsset.count();
  const adminCount = await db.user.count({ where: { role: "ADMIN" } });
  return NextResponse.json({
    seeded: settlementAssets > 0,
    needsBootstrap: adminCount === 0,
    settlementAssets,
  });
}

// POST — seed (or reseed) the marketplace.
// Bootstrap mode: if no admin user exists yet, anyone can seed (first-time
// setup). After bootstrap, reseeding requires admin authentication.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const reset = body?.reset === true;

  const adminCount = await db.user.count({ where: { role: "ADMIN" } });
  const needsBootstrap = adminCount === 0;

  if (!needsBootstrap) {
    const auth = await requireAdmin();
    if (!isAuthed(auth)) {
      return NextResponse.json({ error: "unauthorized — admin login required to reseed" }, { status: 401 });
    }
  }

  try {
    const result = await seedDatabase({ reset });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "seed failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
