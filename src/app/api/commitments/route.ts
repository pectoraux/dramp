import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createCommitment } from "@/lib/economics/commitments";
import { requireUser, isAuthed, isAdmin } from "@/lib/auth-guard";

// List commitments (admin sees all, operator sees own).
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  const url = new URL(req.url);
  const providerId = url.searchParams.get("providerId");

  let where: any = { };
  if (auth.role === "PROVIDER_OPERATOR") {
    where = { providerId: auth.providerId };
  } else if (auth.role === "ADMIN" && providerId) {
    where = { providerId };
  } else if (auth.role === "ADMIN") {
    // all
  } else {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const commitments = await db.liquidityCommitment.findMany({
    where,
    include: { provider: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    commitments: commitments.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      providerName: c.provider.name,
      corridor: `${c.sourceAsset}:${c.sourceCountry} → ${c.destinationAsset}:${c.destinationCountry}`,
      minimumLiquidity: c.minimumLiquidity.toString(),
      targetExecutionSeconds: c.targetExecutionSeconds,
      status: c.status,
      reliability: Math.round(c.reliabilityPct * 100) / 100,
      samples: c.samples,
      avgAvailable: c.avgAvailable.toString(),
      endDate: c.endDate,
    })),
  });
}

// Create a commitment (operator or admin).
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!isAuthed(auth)) return auth.error;
  if (auth.role !== "PROVIDER_OPERATOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const providerId = auth.role === "PROVIDER_OPERATOR" ? auth.providerId! : body.providerId;
  if (!providerId) return NextResponse.json({ error: "providerId required" }, { status: 400 });
  const { id } = await createCommitment({
    providerId,
    sourceAsset: body.sourceAsset,
    destinationAsset: body.destinationAsset,
    sourceCountry: body.sourceCountry ?? "GLOBAL",
    destinationCountry: body.destinationCountry ?? "GLOBAL",
    minimumLiquidity: body.minimumLiquidity,
    maximumLiquidity: body.maximumLiquidity,
    targetExecutionSeconds: body.targetExecutionSeconds ?? 60,
    operatingHoursStart: body.operatingHoursStart,
    operatingHoursEnd: body.operatingHoursEnd,
    endDate: new Date(body.endDate),
  });
  return NextResponse.json({ id });
}
