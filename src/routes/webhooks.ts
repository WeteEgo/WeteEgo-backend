import { Hono } from "hono"
import { createHmac, timingSafeEqual } from "crypto"
import { webhookCounter } from "../lib/metrics.js"
import { getRedis } from "../lib/redis.js"
import { transitionOrderByRef, InvalidTransitionError } from "../services/orderStateMachine.js"
import type { OrderStatus } from "../services/orderStateMachine.js"

const webhooks = new Hono()

const WEBHOOK_IDEMPOTENCY_TTL = 24 * 60 * 60 // 24 hours

/**
 * Check webhook idempotency: skip duplicate events.
 * Returns true if this event was already processed.
 */
async function isWebhookDuplicate(provider: string, eventId: string): Promise<boolean> {
  if (!eventId) return false
  const redis = getRedis()
  const key = `webhook:idem:${provider}:${eventId}`
  try {
    const existing = await redis.set(key, "1", "EX", WEBHOOK_IDEMPOTENCY_TTL, "NX")
    return existing === null // NX returns null if key already exists
  } catch {
    return false // Redis down — process the event (better duplicate than dropped)
  }
}

/**
 * Verify Paycrest HMAC-SHA256 webhook signature.
 * Paycrest sends: X-Paycrest-Signature: sha256=<hex>
 */
function verifyPaycrestSignature(
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  const secret = process.env.PAYCREST_WEBHOOK_SECRET
  if (!secret) return false
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
 * Idempotent: duplicate events are skipped.
 * Uses state machine for valid transitions only.
 */
webhooks.post("/paycrest", async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header("x-paycrest-signature")

  if (!verifyPaycrestSignature(rawBody, signature)) {
    webhookCounter.inc({ event: "paycrest", status: "invalid_signature" })
    return c.json({ success: false, error: "Invalid signature" }, 401)
  }

  let payload: {
    event?: string
    data?: { id?: string; settlementRef?: string; status?: string; reference?: string }
  }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400)
  }

  const { event, data } = payload
  if (!event || !data?.settlementRef) {
    return c.json({ success: false, error: "Missing event or settlementRef" }, 400)
  }

  // Webhook idempotency: use Paycrest order ID or event+ref as dedup key
  const eventId = data.id ?? `${event}:${data.settlementRef}`
  if (await isWebhookDuplicate("paycrest", eventId)) {
    webhookCounter.inc({ event: event ?? "unknown", status: "duplicate" })
    return c.json({ success: true, message: "Already processed" })
  }

  const newStatus: OrderStatus | null =
    event === "order.settled" ? "SETTLED" : event === "order.failed" ? "FAILED" : null

  if (!newStatus) {
    webhookCounter.inc({ event: event ?? "unknown", status: "ignored" })
    return c.json({ success: true })
  }

  try {
    await transitionOrderByRef(data.settlementRef, newStatus, "webhook:paycrest", {
      event,
      paycrestId: data.id,
      paycrestRef: data.reference,
    })
    webhookCounter.inc({ event: event ?? "unknown", status: newStatus })
    console.log(`[webhook] Order ${data.settlementRef} → ${newStatus}`)
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      // Order already in terminal state — not an error
      webhookCounter.inc({ event: event ?? "unknown", status: "transition_skipped" })
      console.log(`[webhook] Skipped invalid transition for ${data.settlementRef}: ${err.message}`)
    } else {
      webhookCounter.inc({ event: event ?? "unknown", status: "error" })
      console.error(`[webhook] Failed to process ${data.settlementRef}:`, err)
      return c.json({ success: false, error: "Processing failed" }, 500)
    }
  }

  return c.json({ success: true })
})

export default webhooks
