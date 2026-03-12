/**
 * Order state machine: enforces valid transitions.
 * All order status updates MUST go through transitionOrder() to prevent invalid states.
 */

import { prisma } from "../lib/prisma.js"
import { logOrderTransition } from "./aml/auditLog.js"

export type OrderStatus =
  | "PENDING"
  | "FORWARDED"
  | "ESCROWED"
  | "PAYOUT_SENT"
  | "SETTLED"
  | "FAILED"
  | "REFUNDED"
  | "EXPIRED"
  | "MANUAL_REVIEW"

const VALID_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["FORWARDED", "ESCROWED", "EXPIRED", "FAILED"],
  FORWARDED: ["ESCROWED", "FAILED"],
  ESCROWED: ["PAYOUT_SENT", "FAILED", "REFUNDED"],
  PAYOUT_SENT: ["SETTLED", "FAILED", "MANUAL_REVIEW"],
  SETTLED: [],
  FAILED: [],
  REFUNDED: [],
  EXPIRED: [],
  MANUAL_REVIEW: ["SETTLED", "FAILED", "REFUNDED"],
} as const

export class InvalidTransitionError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly from: string,
    public readonly to: string
  ) {
    super(`Invalid order transition: ${from} → ${to} (order ${orderId})`)
    this.name = "InvalidTransitionError"
  }
}

/**
 * Transition an order to a new status with validation.
 * Uses optimistic locking via `version` field to prevent race conditions.
 *
 * @param orderId - The order ID
 * @param newStatus - Target status
 * @param actor - Who triggered the transition (e.g., "webhook:paycrest", "worker:reconciliation")
 * @param metadata - Additional context for audit log
 * @returns The updated order
 * @throws InvalidTransitionError if transition is not allowed
 */
export async function transitionOrder(
  orderId: string,
  newStatus: OrderStatus,
  actor: string,
  metadata?: Record<string, unknown>
): Promise<{ id: string; status: string; version: number }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, version: true, settlementRef: true },
  })

  if (!order) {
    throw new Error(`Order not found: ${orderId}`)
  }

  const currentStatus = order.status as OrderStatus
  const allowed = VALID_TRANSITIONS[currentStatus]

  if (!allowed || !allowed.includes(newStatus)) {
    throw new InvalidTransitionError(orderId, currentStatus, newStatus)
  }

  // Optimistic lock: only update if version matches
  const updated = await prisma.order.updateMany({
    where: { id: orderId, version: order.version },
    data: {
      status: newStatus,
      version: { increment: 1 },
    },
  })

  if (updated.count === 0) {
    throw new Error(`Optimistic lock conflict on order ${orderId} (version ${order.version})`)
  }

  // Audit log (fire-and-forget is acceptable here since the transition already committed)
  logOrderTransition(orderId, `STATUS_CHANGE`, actor, currentStatus, newStatus, {
    ...metadata,
    settlementRef: order.settlementRef,
  }).catch((err) => {
    console.error(`[state-machine] Failed to log transition for ${orderId}:`, err)
  })

  return { id: orderId, status: newStatus, version: order.version + 1 }
}

/**
 * Transition by settlementRef instead of orderId.
 */
export async function transitionOrderByRef(
  settlementRef: string,
  newStatus: OrderStatus,
  actor: string,
  metadata?: Record<string, unknown>
): Promise<{ id: string; status: string; version: number }> {
  const order = await prisma.order.findUnique({
    where: { settlementRef },
    select: { id: true },
  })

  if (!order) {
    throw new Error(`Order not found for ref: ${settlementRef}`)
  }

  return transitionOrder(order.id, newStatus, actor, metadata)
}

/**
 * Check if a transition is valid without executing it.
 */
export function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  const allowed = VALID_TRANSITIONS[from]
  return allowed ? allowed.includes(to) : false
}
