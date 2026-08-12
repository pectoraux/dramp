import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runIdempotent, makeKey } from "@/lib/engine/idempotency";

// Sign-up creates a WaitlistEntry. It does NOT create a loginable account.
// An admin must approve the entry (POST /api/admin/waitlist/[id]/approve) to
// create the actual User with a password.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = body.name ? String(body.name).trim() : null;
  const requestedRole = body.requestedRole === "PROVIDER_OPERATOR" ? "PROVIDER_OPERATOR" : "USER";
  const note = body.note ? String(body.note).trim() : null;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const key = makeKey("signup", email);
  const result = await runIdempotent<{ waitlisted: boolean; status?: string; message: string }>(key, "signup", { email }, async () => {
    // If the email is already on the waitlist or already a user, treat as success.
    const existingWait = await db.waitlistEntry.findUnique({ where: { email } });
    if (existingWait) {
      return { status: 200, body: { waitlisted: true, status: existingWait.status, message: "You are already on the waitlist." } };
    }
    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      return { status: 200, body: { waitlisted: false, message: "An account already exists for this email. Please log in." } };
    }
    await db.waitlistEntry.create({
      data: { email, name, requestedRole, note, status: "PENDING" },
    });
    return { status: 200, body: { waitlisted: true, status: "PENDING", message: "You're on the waitlist. We'll email you when your account is ready." } };
  });

  return NextResponse.json(result.body, { status: result.status });
}
