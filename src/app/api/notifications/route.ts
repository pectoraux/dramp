import { NextResponse } from "next/server";
import { getNotifications, markNotificationRead } from "@/lib/provider-api/notifications";
import { requireUser, isAuthed } from "@/lib/auth-guard";

export async function GET(req: Request) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "true";
  const notifications = await getNotifications(auth.id, unreadOnly);
  return NextResponse.json({ notifications });
}
