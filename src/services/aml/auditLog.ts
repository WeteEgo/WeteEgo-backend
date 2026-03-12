/**
 * Append-only audit log: every order state transition with timestamp, actor, previous/new state.
 */

import { prisma } from "../../lib/prisma.js"
import type { Prisma } from "@prisma/client"

export async function logOrderTransition(
  entityId: string,
  action: string,
  actor: string | null,
  previousState: string | null,
  newState: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      entityType: "Order",
      entityId,
      action,
      actor: actor ?? undefined,
      previousState: previousState ?? undefined,
      newState: newState ?? undefined,
      metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}
