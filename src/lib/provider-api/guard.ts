// Guard helper for provider API routes — resolves the API key from the
// Authorization header and returns the provider context or an error response.

import { NextRequest, NextResponse } from "next/server";
import { resolveProviderAuth, hasScope, type ResolvedProvider } from "./auth";

export type ProviderAuthResult =
  | { ok: true; provider: ResolvedProvider }
  | { ok: false; response: NextResponse };

export async function requireProvider(req: NextRequest, scope: string): Promise<ProviderAuthResult> {
  const auth = req.headers.get("authorization");
  const resolved = await resolveProviderAuth(auth);
  if (!resolved) {
    return { ok: false, response: NextResponse.json({ error: "invalid or missing API key" }, { status: 401 }) };
  }
  if (!hasScope(resolved, scope)) {
    return { ok: false, response: NextResponse.json({ error: `missing scope: ${scope}` }, { status: 403 }) };
  }
  // Verify the provider is ACTIVE.
  const { db } = await import("@/lib/db");
  const provider = await db.liquidityProvider.findUnique({ where: { id: resolved.providerId }, select: { status: true } });
  if (!provider || provider.status !== "ACTIVE") {
    return { ok: false, response: NextResponse.json({ error: "provider not active" }, { status: 403 }) };
  }
  return { ok: true, provider: resolved };
}
