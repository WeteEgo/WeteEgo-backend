import { Hono } from "hono"
import { createHmac, timingSafeEqual } from "crypto"
import { prisma } from "../lib/prisma.js"
import { webhookCounter } from "../lib/metrics.js"

const webhooks = new Hono()

/**
 * Verify Paycrest HMAC-SHA256 webhook signature.
 * Paycrest sends: X-Paycrest-Signature: sha256=<hex>
 */
async function verifyPaycrestSignature(
  rawBody: string,
  signatureHeader: string | undefined
): Promise<boolean> {
  const secret = process.env.PAYCREST_WEBHOOK_SECRET
  if (!secret) return false // secret is required — startup validation enforces this
  if (!signatureHeader) return false

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`
  const expectedBuf = Buffer.from(expected)
  const receivedBuf = Buffer.from(signatureHeader)

  if (expectedBuf.length !== receivedBuf.length) return false
  return timingSafeEqual(expectedBuf, receivedBuf)
}

/**
 * POST /api/webhooks/paycrest
 * Receives settlement status callbacks from Paycrest.
 *
 * Expected payload shape (Paycrest may vary — adjust when docs are confirmed):
 * {
 *   event: "order.settled" | "order.failed",
 *   data: {
 *     id: string,           // Paycrest order ID (paycrestRef)
 *     settlementRef: string, // bytes32 ref we sent during order creation
 *     status: "settled" | "failed"
 *   }
 * }
 */
webhooks.post("/paycrest", async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header("x-paycrest-signature")

  const valid = await verifyPaycrestSignature(rawBody, signature)
  if (!valid) {
    webhookCounter.inc({ event: "paycrest", status: "invalid" })
    return c.json({ success: false, error: "Invalid signature" }, 401)
  }

  let payload: { event?: string; data?: { settlementRef?: string; status?: string } }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400)
  }

  const { event, data } = payload
  if (!event || !data?.settlementRef) {
    return c.json({ success: false, error: "Missing event or settlementRef" }, 400)
  }

  const newStatus =
    event === "order.settled" ? "SETTLED" : event === "order.failed" ? "FAILED" : null

  if (!newStatus) {
    // Unknown event type — acknowledge but ignore
    return c.json({ success: true })
  }

  await prisma.order.updateMany({
    where: { settlementRef: data.settlementRef },
    data: { status: newStatus },
  })

  webhookCounter.inc({ event: event ?? "unknown", status: newStatus })
  console.log(`[webhook] Order ${data.settlementRef} → ${newStatus}`)
  return c.json({ success: true })
})

export default webhooks
