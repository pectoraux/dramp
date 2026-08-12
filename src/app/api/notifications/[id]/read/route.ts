import { NextRequest, NextResponse } from "next/server";
import { markNotificationRead } from "@/lib/provider-api/notifications";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const { id } = await params;
  await markNotificationRead(id, auth.id);
  return NextResponse.json({ read: true });
}
