import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, isAuthed } from "@/lib/auth-guard";
import { createApiKey, revokeApiKey } from "@/lib/provider-api/auth";

// API key management — for the provider portal (session-auth, not API-key auth).
// The operator must be bound to a provider.

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  if (auth.role !== "PROVIDER_OPERATOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const providerId = req.nextUrl.searchParams.get("providerId");
  if (!providerId) return NextResponse.json({ error: "providerId required" }, { status: 400 });
  // Operators can only manage their own provider's keys.
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const keys = await db.apiKey.findMany({ where: { providerId }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      keyId: k.keyId,
      label: k.label,
      scopes: JSON.parse(k.scopes),
      status: k.status,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  if (auth.role !== "PROVIDER_OPERATOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const providerId = body.providerId;
  if (!providerId) return NextResponse.json({ error: "providerId required" }, { status: 400 });
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { keyId, secret, apiKeyId } = await createApiKey(providerId, body.label ?? "Default", body.scopes ?? ["offers", "executions", "obligations", "reconcile"]);
  return NextResponse.json({ keyId, secret, apiKeyId, note: "Store the secret securely — it will not be shown again." });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  if (auth.role !== "PROVIDER_OPERATOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const apiKeyId = url.searchParams.get("id");
  const providerId = url.searchParams.get("providerId");
  if (!apiKeyId || !providerId) return NextResponse.json({ error: "id and providerId required" }, { status: 400 });
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await revokeApiKey(providerId, apiKeyId);
  return NextResponse.json({ revoked: true });
}
