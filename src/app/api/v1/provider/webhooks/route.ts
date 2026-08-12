import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, isAuthed } from "@/lib/auth-guard";
import { registerWebhook } from "@/lib/provider-api/webhooks";

// Webhook endpoint management — for the provider portal (session-auth).

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  if (auth.role !== "PROVIDER_OPERATOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const providerId = req.nextUrl.searchParams.get("providerId");
  if (!providerId) return NextResponse.json({ error: "providerId required" }, { status: 400 });
  if (auth.role === "PROVIDER_OPERATOR" && auth.providerId !== providerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const endpoints = await db.webhookEndpoint.findMany({ where: { providerId }, include: { deliveries: { take: 10, orderBy: { createdAt: "desc" } } } });
  return NextResponse.json({
    endpoints: endpoints.map((e) => ({
      id: e.id,
      url: e.url,
      events: JSON.parse(e.events),
      status: e.status,
      createdAt: e.createdAt,
      recentDeliveries: e.deliveries.map((d) => ({
        id: d.id,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        deliveredAt: d.deliveredAt,
      })),
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
  const { id, secret } = await registerWebhook(providerId, body.url, body.events ?? ["*"]);
  return NextResponse.json({ id, secret, note: "Store the signing secret securely — it will not be shown again." });
}
