import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { authOptions, hashPassword, ROLE } from "@/lib/auth";
import { serializeWaitlistEntry } from "./serialize";

// Admin-only: list waitlist entries (optionally filtered by status).
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any).role !== ROLE.ADMIN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status"); // PENDING | APPROVED | REJECTED
  const entries = await db.waitlistEntry.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ entries: entries.map(serializeWaitlistEntry) });
}
