/**
 * Settlement reconciliation worker: runs every 5 minutes.
 * - Distributed lock prevents duplicate runs across pods.
 * - Polls Paycrest for order status on FORWARDED/ESCROWED/PAYOUT_SENT orders.
 * - Flags mismatches for MANUAL_REVIEW instead of auto-updating.
 * - Tracks retry count per order with exponential backoff.
 */

import { OrderStatus } from "@prisma/client"
import { prisma } from "../lib/prisma.js"
import { getRedis } from "../lib/redis.js"
import { getAdapters } from "../services/psp/index.js"
import { transitionOrder, InvalidTransitionError } from "../services/orderStateMachine.js"

const RUN_INTERVAL_MS = 5 * 60 * 1000
const LOCK_KEY = "reconciliation:lock"
const LOCK_TTL_SEC = 300
const MAX_RETRIES = 10
const RETRY_KEY_PREFIX = "order:reconcile_retries:"

async function acquireLock(): Promise<boolean> {
  const redis = getRedis()
  try {
    const result = await redis.set(LOCK_KEY, process.pid.toString(), "EX", LOCK_TTL_SEC, "NX")
    return result === "OK"
  } catch {
    return false
  }
}

async function releaseLock(): Promise<void> {
  const redis = getRedis()
  try {
    await redis.del(LOCK_KEY)
  } catch {
    // TTL will expire
  }
}

async function getRetryInfo(orderId: string): Promise<{ count: number; shouldSkip: boolean }> {
  const redis = getRedis()
  try {
    const raw = await redis.get(`${RETRY_KEY_PREFIX}${orderId}`)
    const count = raw ? parseInt(raw, 10) : 0
    if (count >= MAX_RETRIES) return { count, shouldSkip: true }

    const backoffMs = Math.min(10 * 60 * 1000 * Math.pow(2, count), 2 * 60 * 60 * 1000)
    const lastTs = await redis.get(`${RETRY_KEY_PREFIX}${orderId}:ts`)
    if (lastTs && Date.now() - parseInt(lastTs, 10) < backoffMs) {
      return { count, shouldSkip: true }
    }
    return { count, shouldSkip: false }
  } catch {
    return { count: 0, shouldSkip: false }
  }
}

async function recordRetry(orderId: string): Promise<number> {
  const redis = getRedis()
  try {
    const count = await redis.incr(`${RETRY_KEY_PREFIX}${orderId}`)
    await redis.expire(`${RETRY_KEY_PREFIX}${orderId}`, 7 * 24 * 60 * 60)
    await redis.set(`${RETRY_KEY_PREFIX}${orderId}:ts`, String(Date.now()), "EX", 7 * 24 * 60 * 60)
    return count
  } catch {
    return 0
  }
}

export async function runReconciliation(): Promise<void> {
  if (!(await acquireLock())) {
    console.log("[reconciliation] Skipped — another instance holds the lock")
    return
  }

  try {
    const orders = await prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.FORWARDED, OrderStatus.ESCROWED, OrderStatus.PAYOUT_SENT] },
        pspReference: { not: null },
        pspProvider: { not: null },
      },
      select: { id: true, settlementRef: true, pspReference: true, pspProvider: true, status: true },
    })

    const adapters = getAdapters()
    const byProvider = new Map(adapters.map((a) => [a.name, a]))

    for (const order of orders) {
      const ref = order.pspReference!
      const provider = order.pspProvider!
      const adapter = byProvider.get(provider)
      if (!adapter) continue

      const retryInfo = await getRetryInfo(order.id)
      if (retryInfo.shouldSkip) {
        if (retryInfo.count >= MAX_RETRIES) {
          try {
            await transitionOrder(order.id, "MANUAL_REVIEW", "worker:reconciliation", {
              reason: "max_retries_exhausted",
              retryCount: retryInfo.count,
            })
            console.log(`[reconciliation] Order ${order.settlementRef} → MANUAL_REVIEW (max retries)`)
          } catch (err) {
            if (!(err instanceof InvalidTransitionError)) {
              console.error(`[reconciliation] Failed to move ${order.settlementRef} to MANUAL_REVIEW:`, err)
            }
          }
        }
        continue
      }

      try {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const { status, failureReason } = await adapter.getPayoutStatus(ref)

        if (status === "success") {
          try {
            await transitionOrder(order.id, "SETTLED", "worker:reconciliation", {
              pspStatus: status,
              pspProvider: provider,
            })
            console.log(`[reconciliation] Order ${order.settlementRef} synced to SETTLED`)
          } catch (err) {
            if (err instanceof InvalidTransitionError) {
              console.error(`[reconciliation] MISMATCH: PSP=success but order=${order.status} for ${order.settlementRef}`)
              await prisma.aMLAlert.create({
                data: {
                  walletAddress: "system",
                  ruleTriggered: "reconciliation_mismatch",
                  severity: "high",
                  status: "open",
                  notes: `PSP says success but order is ${order.status}. Ref: ${order.settlementRef}`,
                },
              })
            }
          }
        } else if (status === "failed") {
          try {
            await transitionOrder(order.id, "FAILED", "worker:reconciliation", {
              pspStatus: status,
              failureReason,
              pspProvider: provider,
            })
            console.log(`[reconciliation] Order ${order.settlementRef} synced to FAILED`)
          } catch (err) {
            if (err instanceof InvalidTransitionError) {
              console.error(`[reconciliation] MISMATCH: PSP=failed but order=${order.status} for ${order.settlementRef}`)
              await prisma.aMLAlert.create({
                data: {
                  walletAddress: "system",
                  ruleTriggered: "reconciliation_mismatch",
                  severity: "high",
                  status: "open",
                  notes: `PSP says failed but order is ${order.status}. Ref: ${order.settlementRef}. Reason: ${failureReason}`,
                },
              })
            }
          }
        } else {
          await recordRetry(order.id)
        }
      } catch (err) {
        await recordRetry(order.id)
        console.error(`[reconciliation] Failed to check ${provider} ref=${ref}:`, err)
      }
    }

    // Daily totals
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const settled = await prisma.order.aggregate({
      where: { status: OrderStatus.SETTLED, updatedAt: { gte: today } },
      _sum: { fiatAmount: true },
      _count: true,
    })
    console.log(
      `[reconciliation] Daily totals: ${settled._count} orders, NGN ${settled._sum.fiatAmount?.toFixed(0) ?? 0}`
    )
  } finally {
    await releaseLock()
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null

export function startReconciliationWorker(): void {
  if (intervalId) return
  runReconciliation().catch((err) => console.error("[reconciliation] run failed:", err))
  intervalId = setInterval(() => {
    runReconciliation().catch((err) => console.error("[reconciliation] run failed:", err))
  }, RUN_INTERVAL_MS)
  console.log("[reconciliation] Worker started (every 5 min, distributed lock)")
}

export function stopReconciliationWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
