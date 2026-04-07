import { Hono } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { keccak256, encodePacked } from "viem"
import { prisma } from "../lib/prisma.js"
import { getRedis } from "../lib/redis.js"
import { getRate } from "../services/rates.js"
import { verifyBankAccount } from "../services/psp/orchestrator.js"
import { getIdempotencyKey, idempotencyCacheKey, IDEMPOTENCY_TTL_SEC } from "../middleware/idempotency.js"
import { validateNuban } from "../utils/nuban.js"
import { checkGuestCheckout, recordGuestVolume } from "../middleware/guestCheckout.js"
import { checkAMLRules, recordOrderForAML } from "../services/aml/rules.js"
import { amlAlertsCounter } from "../lib/metrics.js"
import { transitionOrder, type OrderStatus } from "../services/orderStateMachine.js"
import type { Prisma } from "@prisma/client"

const orders = new Hono()

const bankAccountSchema = z
  .object({
    accountNumber: z.string(),
    bankCode: z.string(),
    accountName: z.string(),
  })
  .optional()

const createOrderSchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid wallet address"),
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid token address"),
  amount: z.string().refine((v) => !isNaN(Number(v)) && BigInt(v) > 0n, {
    message: "amount must be a positive integer string (wei)",
  }),
  fiatCurrency: z.string().min(2).max(5),
  bankAccount: bankAccountSchema,
})

/**
 * POST /api/orders
 * Creates a PENDING order, generates settlementRef, runs AML/tier checks.
 * Paycrest payout runs in the Go order service after on-chain OrderCreated (not here).
 * Idempotency-Key header supported for duplicate prevention.
 */
orders.post("/", zValidator("json", createOrderSchema), async (c) => {
  const body = c.req.valid("json")
  const { walletAddress, tokenAddress, amount, fiatCurrency, bankAccount } = body

  // Idempotency check
  const idemKey = getIdempotencyKey(c)
  if (idemKey) {
    const redis = getRedis()
    try {
      const cached = await redis.get(idempotencyCacheKey(idemKey))
      if (cached) {
        const parsed = JSON.parse(cached) as { data: unknown; status: number }
        return c.json(parsed.data, parsed.status as 200 | 201)
      }
    } catch {
      // Redis down — proceed without idempotency
    }
  }

  // NUBAN format validation
  if (bankAccount) {
    const nubanCheck = validateNuban(bankAccount.accountNumber, bankAccount.bankCode)
    if (!nubanCheck.valid) {
      return c.json({ success: false, error: nubanCheck.error }, 400)
    }
  }

  // Bank account verification via PSP (best-effort — degrades open)
  if (bankAccount && fiatCurrency.toUpperCase() === "NGN") {
    const verification = await verifyBankAccount(bankAccount.bankCode, bankAccount.accountNumber)
    if (!verification.valid && !verification.error?.includes("unavailable")) {
      return c.json({ success: false, error: verification.error ?? "Bank account verification failed" }, 400)
    }
  }

  const usdcUnits = Number(BigInt(amount)) / 1e6
  const rate = await getRate(fiatCurrency)
  const fiatAmount = usdcUnits * rate
  const orderAmountUsd = usdcUnits

  // Tier limit check (daily + monthly per wallet)
  const guestCheck = await checkGuestCheckout(walletAddress, orderAmountUsd)
  if (!guestCheck.allowed) {
    return c.json({ success: false, error: guestCheck.reason, requiresKyc: guestCheck.requiresKyc }, 403)
  }

  const settlementRef = keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [walletAddress as `0x${string}`, BigInt(amount), BigInt(Date.now())]
    )
  )

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  // AML check (runs before transaction — uses Redis, not DB)
  const amlCheck = await checkAMLRules(walletAddress.toLowerCase(), orderAmountUsd, guestCheck.currentTier)
  const { rules: amlResults, riskScore, blocked: amlBlocked } = amlCheck

  if (amlBlocked) {
    return c.json({
      success: false,
      error: "Order blocked by risk assessment. Please contact support.",
      riskScore,
    }, 403)
  }

  // Atomic transaction: create order + AML alerts + audit log
  const order = await prisma.$transaction(async (tx) => {
    const newOrder = await tx.order.create({
      data: {
        settlementRef,
        walletAddress: walletAddress.toLowerCase(),
        tokenAddress: tokenAddress.toLowerCase(),
        amount,
        fiatCurrency: fiatCurrency.toUpperCase(),
        fiatAmount,
        rate,
        expiresAt,
        bankAccount: bankAccount ? JSON.stringify(bankAccount) : null,
        riskScore,
      },
    })

    // Create AML alerts atomically with order
    for (const r of amlResults) {
      amlAlertsCounter.inc({ rule: r.rule, severity: r.severity })
      await tx.aMLAlert.create({
        data: {
          walletAddress: walletAddress.toLowerCase(),
          ruleTriggered: r.rule,
          severity: r.severity,
          status: "open",
          notes: r.detail,
        },
      })
    }

    // Audit log within same transaction
    await tx.auditLog.create({
      data: {
        entityType: "Order",
        entityId: newOrder.id,
        action: "ORDER_CREATED",
        previousState: undefined,
        newState: newOrder.status,
        metadata: {
          settlementRef,
          walletAddress: walletAddress.toLowerCase(),
          fiatAmount: orderAmountUsd,
          riskScore,
        } as unknown as Prisma.InputJsonValue,
      },
    })

    return newOrder
  })

  // Record AML data in Redis (best-effort, outside transaction)
  recordOrderForAML(walletAddress.toLowerCase(), orderAmountUsd).catch(() => {})

  // Track volume for all tiers (enforces daily + monthly limits)
  recordGuestVolume(walletAddress, orderAmountUsd).catch(() => {})

  const responsePayload = {
    success: true,
    data: {
      id: order.id,
      settlementRef,
      fiatAmount,
      rate,
      fiatCurrency: order.fiatCurrency,
      status: order.status,
      guestCheckout: guestCheck.currentTier === "GUEST",
    },
  }

  // Cache response for idempotency
  if (idemKey) {
    const redis = getRedis()
    try {
      await redis.setex(
        idempotencyCacheKey(idemKey),
        IDEMPOTENCY_TTL_SEC,
        JSON.stringify({ data: responsePayload, status: 201 })
      )
    } catch {
      // Redis down — order still created successfully
    }
  }

  return c.json(responsePayload, 201)
})

/**
 * GET /api/orders/:ref/stream
 * Server-Sent Events: pushes real-time status updates for an order.
 * Subscribes to Redis pub/sub channel `order:state:<ref>` and streams events.
 * Closes automatically when order reaches a terminal state.
 */
orders.get("/:ref/stream", async (c) => {
  const ref = c.req.param("ref")
  const TERMINAL = new Set(["SETTLED", "FAILED", "REFUNDED"])

  return streamSSE(c, async (stream: SSEStreamingApi) => {
    const redis = getRedis()
    const subscriber = redis.duplicate()

    let closed = false

    const cleanup = () => {
      if (!closed) {
        closed = true
        subscriber.unsubscribe(`order:state:${ref}`).catch(() => {})
        subscriber.disconnect()
      }
    }

    stream.onAbort(cleanup)

    await subscriber.subscribe(`order:state:${ref}`)
    subscriber.on("message", async (_channel: string, message: string) => {
      if (closed) return
      try {
        await stream.writeSSE({ data: message })
        const parsed = JSON.parse(message) as { status?: string }
        if (parsed.status && TERMINAL.has(parsed.status)) {
          cleanup()
          stream.close()
        }
      } catch {
        // stream already closed
      }
    })

    // Heartbeat every 15s to keep connection alive through proxies
    let heartbeatCount = 0
    while (!closed) {
      await stream.sleep(15_000)
      if (closed) break
      heartbeatCount++
      try {
        await stream.writeSSE({ data: "{}", event: "ping", id: String(heartbeatCount) })
      } catch {
        cleanup()
        break
      }
    }
  })
})

/**
 * GET /api/orders/:ref
 * Returns order status by settlementRef (bytes32 hex).
 */
orders.get("/:ref", async (c) => {
  const ref = c.req.param("ref")

  const order = await prisma.order.findUnique({
    where: { settlementRef: ref },
    select: {
      id: true,
      settlementRef: true,
      walletAddress: true,
      fiatCurrency: true,
      fiatAmount: true,
      rate: true,
      status: true,
      txHash: true,
      pspProvider: true,
      pspReference: true,
      riskScore: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!order) {
    return c.json({ success: false, error: "Order not found" }, 404)
  }

  return c.json({ success: true, data: order })
})

export default orders
