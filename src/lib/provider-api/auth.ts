// Provider API authentication — resolves an API key (keyId + secret) to a
// provider. Used by the Open Liquidity API (/api/v1/provider/*).
//
// Secrets are bcrypt-hashed at creation; the plaintext is shown ONCE. We never
// store plaintext secrets.

import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

export interface ResolvedProvider {
  providerId: string;
  keyId: string;
  apiKeyId: string;
  scopes: string[];
  label: string;
}

// Create a new API key for a provider. Returns the plaintext secret ONCE.
export async function createApiKey(providerId: string, label: string, scopes: string[]): Promise<{ keyId: string; secret: string; apiKeyId: string }> {
  const keyId = `pk_${randomBytes(12).toString("hex")}`;
  const secret = `sk_${randomBytes(24).toString("hex")}`;
  const secretHash = await bcrypt.hash(secret, 10);
  const rec = await db.apiKey.create({
    data: {
      providerId,
      keyId,
      secretHash,
      label,
      scopes: JSON.stringify(scopes),
      status: "ACTIVE",
    },
  });
  return { keyId, secret, apiKeyId: rec.id };
}

// Revoke an API key.
export async function revokeApiKey(providerId: string, apiKeyId: string): Promise<void> {
  await db.apiKey.updateMany({
    where: { id: apiKeyId, providerId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
}

// Resolve an Authorization header (Bearer pk_xxx:sk_xxx) to a provider.
// Returns null if invalid/revoked.
export async function resolveProviderAuth(authHeader: string | null): Promise<ResolvedProvider | null> {
  if (!authHeader) return null;
  const parts = authHeader.split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  const token = parts[1];
  // Token format: "pk_xxx:sk_xxx" (keyId:secret)
  const colonIdx = token.indexOf(":");
  if (colonIdx < 0) return null;
  const keyId = token.slice(0, colonIdx);
  const secret = token.slice(colonIdx + 1);
  if (!keyId.startsWith("pk_") || !secret.startsWith("sk_")) return null;

  const rec = await db.apiKey.findUnique({ where: { keyId } });
  if (!rec || rec.status !== "ACTIVE") return null;
  const ok = await bcrypt.compare(secret, rec.secretHash);
  if (!ok) return null;

  // Update lastUsedAt (fire-and-forget).
  db.apiKey.update({ where: { id: rec.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return {
    providerId: rec.providerId,
    keyId: rec.keyId,
    apiKeyId: rec.id,
    scopes: JSON.parse(rec.scopes) as string[],
    label: rec.label,
  };
}

export function hasScope(resolved: ResolvedProvider, scope: string): boolean {
  return resolved.scopes.includes(scope) || resolved.scopes.includes("*");
}
