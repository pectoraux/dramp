import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { authOptions, hashPassword, ROLE } from "@/lib/auth";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";

// Admin approves a waitlist entry and creates a loginable account.
// Body: { name?, password?, role? } — password defaults to a generated one.
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

  const key = makeKey("approve-waitlist", id);
  const result = await runIdempotent(key, "approve-waitlist", { id, role }, async () => {
    // Create the user (idempotent: if already created, return existing).
    const existing = await db.user.findUnique({ where: { email: entry.email } });
    let user = existing;
    if (!user) {
      const hashed = await hashPassword(password);
      user = await db.user.create({
        data: { email: entry.email, name, password: hashed, role, status: "ACTIVE", isDemo: false },
      });
    }
    await db.waitlistEntry.update({
      where: { id },
      data: { status: "APPROVED", reviewedAt: new Date(), reviewedById: session.user.id, createdUserId: user.id },
    });
    return {
      status: 200,
      body: { approved: true, userId: user.id, email: user.email, name: user.name, role, generatedPassword: existing ? null : password },
    };
  });

  return NextResponse.json(result.body, { status: result.status });
}

// Reject a waitlist entry (no account created).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any).role !== ROLE.ADMIN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
