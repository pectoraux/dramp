// Auth guards for API routes.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, ROLE } from "@/lib/auth";
import { db } from "@/lib/db";

export interface AuthedUser {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  isDemo: boolean;
  providerId: string | null;
}

export type AuthResult = AuthedUser | { error: NextResponse };

export async function requireUser(): Promise<AuthResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const u = session.user as any;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isDemo: u.isDemo,
    providerId: u.providerId ?? null,
  };
}

export async function requireAdmin(): Promise<AuthResult> {
  const r = await requireUser();
  if ("error" in r) return r;
  if (r.role !== ROLE.ADMIN) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return r;
}

export async function requireOperatorOrAdmin(): Promise<AuthResult> {
  const r = await requireUser();
  if ("error" in r) return r;
  if (r.role !== ROLE.ADMIN && r.role !== ROLE.PROVIDER_OPERATOR) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return r;
}

export function isAuthed(r: AuthResult): r is AuthedUser {
  return !("error" in r);
}

export function isAdmin(r: AuthedUser): boolean {
  return r.role === ROLE.ADMIN;
}

// ---- Ownership helpers ---------------------------------------------------

// Verify the authenticated user owns the given intent (or is an admin).
// Returns the intent if allowed, or { error } if not. A 404 (not 403) is
// returned on mismatch to avoid leaking existence.
export async function requireIntentOwnership(intentId: string, user: AuthedUser): Promise<{ ok: true; intent: any } | { ok: false; error: NextResponse }> {
  const intent = await db.executionIntent.findUnique({
    where: { id: intentId },
    select: { id: true, userId: true },
  });
  if (!intent) {
    return { ok: false, error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  if (intent.userId !== user.id && !isAdmin(user)) {
    return { ok: false, error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  return { ok: true, intent };
}

// Verify the authenticated user owns the execution (via its intent) or is admin.
export async function requireExecutionOwnership(executionId: string, user: AuthedUser): Promise<{ ok: true; execution: any } | { ok: false; error: NextResponse }> {
  const execution = await db.execution.findUnique({
    where: { id: executionId },
    select: { id: true, intent: { select: { userId: true } } },
  });
  if (!execution) {
    return { ok: false, error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  if (execution.intent.userId !== user.id && !isAdmin(user)) {
    return { ok: false, error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  return { ok: true, execution };
}

// Verify the authenticated operator owns the provider for the given leg (or is admin).
export async function requireLegOwnership(legId: string, user: AuthedUser): Promise<{ ok: true; leg: any } | { ok: false; error: NextResponse }> {
  const leg = await db.leg.findUnique({
    where: { id: legId },
    select: { id: true, providerId: true },
  });
  if (!leg) {
    return { ok: false, error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  if (isAdmin(user)) return { ok: true, leg };
  if (user.role !== ROLE.PROVIDER_OPERATOR || !user.providerId || user.providerId !== leg.providerId) {
    return { ok: false, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, leg };
}

// Verify the authenticated operator owns the provider (or is admin).
export async function requireProviderOwnership(providerId: string, user: AuthedUser): Promise<{ ok: true; provider: any } | { ok: false; error: NextResponse }> {
  const provider = await db.liquidityProvider.findUnique({
    where: { id: providerId },
    select: { id: true },
  });
  if (!provider) {
    return { ok: false, error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  if (isAdmin(user)) return { ok: true, provider };
  if (user.role !== ROLE.PROVIDER_OPERATOR || !user.providerId || user.providerId !== providerId) {
    return { ok: false, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, provider };
}
