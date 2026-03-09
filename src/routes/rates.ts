import { Hono } from "hono"
import { getRates, getRate } from "../services/rates.js"

const rates = new Hono()

/**
 * GET /api/rates
 * Returns all supported USDC→fiat rates.
 * Optional ?currency=NGN to get a single rate.
 */
rates.get("/", async (c) => {
  const currency = c.req.query("currency")

  if (currency) {
    const rate = await getRate(currency)
    return c.json({ success: true, data: { [currency.toUpperCase()]: rate } })
  }

  const data = await getRates()
  return c.json({ success: true, data })
})

export default rates
