import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { keccak256, encodePacked } from "viem"
import { prisma } from "../lib/prisma.js"
import { orderCounter } from "../lib/metrics.js"
import { getRate } from "../services/rates.js"
import { createPaycrestOrder } from "../services/paycrest.js"

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
 * Creates an order, generates a settlementRef, and optionally notifies Paycrest.
 * Returns settlementRef (bytes32) to be passed into WeteEgoRouter.forwardERC20().
 */
orders.post("/", zValidator("json", createOrderSchema), async (c) => {
  const body = c.req.valid("json")
  const { walletAddress, tokenAddress, amount, fiatCurrency, bankAccount } = body

  // Generate deterministic bytes32 settlementRef
  const settlementRef = keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [
        walletAddress as `0x${string}`,
        BigInt(amount),
        BigInt(Date.now()),
      ]
    )
  )

  // Compute fiat quote
  const usdcUnits = Number(BigInt(amount)) / 1e6 // USDC has 6 decimals
  const rate = await getRate(fiatCurrency)
  const fiatAmount = usdcUnits * rate

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
  const order = await prisma.order.create({
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
    },
  })

  // Notify Paycrest async — increment metric only on success/failure
  createPaycrestOrder({
    settlementRef,
    walletAddress,
    tokenAddress,
    amount,
    fiatCurrency: fiatCurrency.toUpperCase(),
  }).then((paycrestOrder) => {
    if (paycrestOrder) {
      orderCounter.inc({ status: order.status, provider: "paycrest" })
      prisma.order
        .update({ where: { id: order.id }, data: { paycrestRef: paycrestOrder.id } })
        .catch(() => {})
    }
  }).catch(() => {
    orderCounter.inc({ status: "paycrest_submission_failed", provider: "paycrest" })
  })

  return c.json(
    {
      success: true,
      data: {
        id: order.id,
        settlementRef,
        fiatAmount,
        rate,
        fiatCurrency: order.fiatCurrency,
        status: order.status,
      },
    },
    201
  )
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
