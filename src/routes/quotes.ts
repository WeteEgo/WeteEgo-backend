import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { getRate } from "../services/rates.js"

const quotes = new Hono()

const querySchema = z.object({
  amount: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
    message: "amount must be a positive number",
  }),
  fiat: z.string().min(2).max(5),
})

/**
 * GET /api/quotes?amount=100&fiat=NGN
 * Returns a fiat quote for a given USDC amount.
 * amount is in USDC units (not wei).
 */
quotes.get("/", zValidator("query", querySchema), async (c) => {
  const { amount, fiat } = c.req.valid("query")
  const usdcAmount = Number(amount)
  const rate = await getRate(fiat)
  const fiatAmount = usdcAmount * rate

  return c.json({
    success: true,
    data: {
      usdcAmount,
      fiatCurrency: fiat.toUpperCase(),
      fiatAmount: Math.round(fiatAmount * 100) / 100,
      rate,
      expiresIn: 60, // seconds — quote valid for cache TTL
    },
  })
})

export default quotes
