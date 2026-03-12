import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { keccak256, encodePacked } from "viem"
import { prisma } from "../lib/prisma.js"
import { getRedis } from "../lib/redis.js"
import { orderCounter } from "../lib/metrics.js"
import { getRate } from "../services/rates.js"
import { createPayoutWithFailover, verifyBankAccount } from "../services/psp/orchestrator.js"
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
 * Creates an order, generates a settlementRef, and initiates Paycrest payout for NGN.
 * Uses Prisma transaction for atomicity: order + AML alerts + audit log committed together.
 * PSP payout is called after commit (not fire-and-forget — result is tracked).
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

  // Initiate PSP payout SYNCHRONOUSLY (not fire-and-forget)
  if (bankAccount && fiatCurrency.toUpperCase() === "NGN") {
    const idempotencyKey = idemKey ?? `order-${order.id}-${Date.now()}`
    try {
      const { result, provider } = await createPayoutWithFailover({
        orderId: order.id,
        settlementRef,
        amountNgn: fiatAmount,
        amountUsdcUnits: amount,
        recipient: {
          accountNumber: bankAccount.accountNumber,
          bankCode: bankAccount.bankCode,
          accountName: bankAccount.accountName,
          currency: fiatCurrency.toUpperCase(),
        },
        idempotencyKey,
      })

      orderCounter.inc({ status: result.status, psp: provider })

      // Record payment attempt
      await prisma.paymentAttempt.create({
        data: {
          orderId: order.id,
          pspProvider: provider,
          pspReference: result.pspReference ?? null,
          status: result.status,
          amount: String(fiatAmount),
          failureReason: result.failureReason ?? null,
        },
      })

      // Update order with PSP info
      await prisma.order.update({
        where: { id: order.id },
        data: {
          pspProvider: provider,
          pspReference: result.pspReference ?? undefined,
          provider: provider,
        },
      })

      if (result.success) {
        console.log(`[orders] Paycrest payout initiated for ref=${settlementRef}`)
      } else {
        console.error(`[orders] Paycrest payout failed for ref=${settlementRef}: ${result.failureReason}`)
      }
    } catch (err) {
      orderCounter.inc({ status: "psp_exception", psp: "paycrest" })
      console.error("[orders] PSP exception:", err)
      // Order is still created — reconciliation worker will pick it up
    }
  }

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
