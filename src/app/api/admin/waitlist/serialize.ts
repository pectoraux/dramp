import { Prisma } from "@prisma/client";

export function serializeWaitlistEntry(e: Prisma.WaitlistEntryGetPayload<{}>) {
  return {
    id: e.id,
    email: e.email,
    name: e.name,
    requestedRole: e.requestedRole,
    status: e.status,
    note: e.note,
    createdAt: e.createdAt,
    reviewedAt: e.reviewedAt,
    reviewedById: e.reviewedById,
    createdUserId: e.createdUserId,
  };
}
