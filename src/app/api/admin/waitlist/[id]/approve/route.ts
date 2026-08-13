import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { authOptions, hashPassword, ROLE } from "@/lib/auth";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";

// Admin approves a waitlist entry and creates a loginable account.
// Body: { name?, password?, role?, providerId? } — password defaults to a generated one.
// providerId is required when role === PROVIDER_OPERATOR (binds the operator
// to a specific LiquidityProvider so they can only confirm/fail that
// provider's legs).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any).role !== ROLE.ADMIN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const entry = await db.waitlistEntry.findUnique({ where: { id } });
  if (!entry) return NextResponse.json({ error: "not found" }, { status: 404 });

  const role = body.role === "PROVIDER_OPERATOR" ? "PROVIDER_OPERATOR" : body.role === "ADMIN" ? "ADMIN" : entry.requestedRole;
  const name = body.name ? String(body.name) : entry.name ?? entry.email.split("@")[0];
  const password = body.password ? String(body.password) : generatePassword();

  // Validate provider binding for operators.
  let providerId: string | null = null;
  if (role === "PROVIDER_OPERATOR") {
    const pid = body.providerId ? String(body.providerId) : null;
    if (!pid) {
      return NextResponse.json({ error: "providerId is required when creating a PROVIDER_OPERATOR" }, { status: 400 });
    }
    const provider = await db.liquidityProvider.findUnique({ where: { id: pid } });
    if (!provider) {
      return NextResponse.json({ error: "provider not found" }, { status: 400 });
    }
    providerId = pid;
  }

  const key = makeKey("approve-waitlist", id);
  // NOTE: the generated plaintext password is returned to the admin once but
  // is NOT persisted in the IdempotencyRecord (we store a redacted body).
  const result = await runIdempotent(key, "approve-waitlist", { id, role, providerId }, async () => {
    const existing = await db.user.findUnique({ where: { email: entry.email } });
    let user = existing;
    if (!user) {
      const hashed = await hashPassword(password);
      user = await db.user.create({
        data: { email: entry.email, name, password: hashed, role, status: "ACTIVE", isDemo: false, providerId },
      });
    }
    await db.waitlistEntry.update({
      where: { id },
      data: { status: "APPROVED", reviewedAt: new Date(), reviewedById: session.user.id, createdUserId: user.id },
    });
    return {
      status: 200,
      // The password is returned to the caller but redacted before idempotency
      // storage below.
      body: { approved: true, userId: user.id, email: user.email, name: user.name, role, providerId, generatedPassword: existing ? null : password },
    };
  });

  // Redact the plaintext password from any persisted idempotency record so it
  // doesn't sit in the database. The IdempotencyRecord stores the body JSON;
  // overwrite the response we return but keep the record clean.
  if (result.cached === false) {
    const record = await db.idempotencyRecord.findUnique({ where: { key } });
    if (record) {
      const redacted = JSON.parse(record.responseBody ?? "{}");
      if (redacted?.generatedPassword) redacted.generatedPassword = "[redacted]";
      await db.idempotencyRecord.update({
        where: { key },
        data: { responseBody: JSON.stringify(redacted) },
      });
    }
  }

  return NextResponse.json(result.body, { status: result.status });
}

// Reject a waitlist entry (no account created).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any).role !== ROLE.ADMIN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const entry = await db.waitlistEntry.findUnique({ where: { id } });
  if (!entry) return NextResponse.json({ error: "not found" }, { status: 404 });
  await db.waitlistEntry.update({
    where: { id },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewedById: session.user.id },
  });
  return NextResponse.json({ rejected: true });
}

function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
