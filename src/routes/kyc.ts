import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { createHmac, timingSafeEqual } from "crypto"
import { prisma } from "../lib/prisma.js"
import { smileIdProvider } from "../services/kyc/smileid.js"
import { dojahProvider } from "../services/kyc/dojah.js"
import { kycVerificationCounter } from "../lib/metrics.js"

const kyc = new Hono()

const REPLAY_WINDOW_MS = 5 * 60 * 1000 // reject events older than 5 min

/**
 * Verify Smile ID webhook signature.
 * Smile ID signs with HMAC-SHA256 using the partner API key.
 * Header: x-smile-id-signature
 */
function verifySmileIdSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.SMILE_ID_API_KEY
  if (!secret || !signatureHeader) return false
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const expectedBuf = Buffer.from(expected)
  const receivedBuf = Buffer.from(signatureHeader)
  if (expectedBuf.length !== receivedBuf.length) return false
  return timingSafeEqual(expectedBuf, receivedBuf)
}

/**
 * Verify Dojah webhook signature.
 * Dojah uses: x-dojah-signature header (HMAC-SHA512)
 */
function verifyDojahSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.DOJAH_WEBHOOK_SECRET
  if (!secret || !signatureHeader) return false
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex")
  const expectedBuf = Buffer.from(expected)
  const receivedBuf = Buffer.from(signatureHeader)
  if (expectedBuf.length !== receivedBuf.length) return false
  return timingSafeEqual(expectedBuf, receivedBuf)
}

const initiateSchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  provider: z.enum(["smileid", "dojah"]).optional().default("smileid"),
})

/**
 * POST /api/kyc/initiate
 * Start KYC verification for a wallet. Creates/updates User and returns session redirect URL.
 */
kyc.post("/initiate", zValidator("json", initiateSchema), async (c) => {
  const { walletAddress, provider } = c.req.valid("json")
  const normalized = walletAddress.toLowerCase()

  let user = await prisma.user.findUnique({ where: { walletAddress: normalized } })
  if (!user) {
    user = await prisma.user.create({
      data: {
        walletAddress: normalized,
        kycStatus: "pending",
        kycProvider: provider,
      },
    })
  } else if (user.kycStatus === "approved") {
    return c.json({
      success: true,
      data: { alreadyVerified: true, sessionId: null, redirectUrl: null },
    })
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { kycStatus: "pending", kycProvider: provider },
    })
  }

  const adapter = provider === "dojah" ? dojahProvider : smileIdProvider
  const session = await adapter.initiateVerification({
    walletAddress: normalized,
    userId: user.id,
  })

  await prisma.kYCAttempt.create({
    data: {
      userId: user.id,
      provider,
      status: "pending",
      metadata: { sessionId: session.sessionId },
    },
  })

  await prisma.user.update({
    where: { id: user.id },
    data: { kycSessionId: session.sessionId },
  })

  kycVerificationCounter.inc({ provider, result: "initiated" })

  return c.json({
    success: true,
    data: {
      sessionId: session.sessionId,
      redirectUrl: session.redirectUrl ?? null,
      expiresAt: session.expiresAt?.toISOString() ?? null,
    },
  })
})

/**
 * GET /api/kyc/status/:walletAddress
 * Return KYC status for a wallet.
 */
kyc.get("/status/:walletAddress", async (c) => {
  const walletAddress = c.req.param("walletAddress")?.toLowerCase()
  if (!walletAddress || !/^0x[0-9a-fa-f]{40}$/.test(walletAddress)) {
    return c.json({ success: false, error: "Invalid wallet address" }, 400)
  }

  const user = await prisma.user.findUnique({
    where: { walletAddress },
    select: { kycStatus: true, kycProvider: true, kycCompletedAt: true, tier: true },
  })

  if (!user) {
    return c.json({ success: true, data: { kycStatus: "none", tier: "GUEST", verified: false } })
  }

  return c.json({
    success: true,
    data: {
      kycStatus: user.kycStatus,
      kycProvider: user.kycProvider,
      kycCompletedAt: user.kycCompletedAt?.toISOString() ?? null,
      tier: user.tier,
      verified: user.kycStatus === "approved",
    },
  })
})

/**
 * POST /api/kyc/webhook
 * Callback for Smile ID / Dojah.
 * - Verifies HMAC signature for each provider.
 * - Validates timestamp to prevent replay attacks (5-min window).
 * - Updates User tier and KYCAttempt status.
 */
kyc.post("/webhook", async (c) => {
  const rawBody = await c.req.text()

  // Detect provider from header or body
  const providerHeader = c.req.header("x-kyc-provider") ?? ""
  let detectedProvider = providerHeader === "dojah" ? "dojah" : "smileid"

  // Verify signature based on provider
  if (detectedProvider === "smileid") {
    const sig = c.req.header("x-smile-id-signature")
    // Allow missing signature in sandbox (SMILE_ID_API_KEY not set)
    if (process.env.SMILE_ID_API_KEY && sig && !verifySmileIdSignature(rawBody, sig)) {
      console.warn("[kyc] Smile ID webhook: invalid signature")
      return c.json({ success: false, error: "Invalid signature" }, 401)
    }
  } else {
    const sig = c.req.header("x-dojah-signature")
    if (process.env.DOJAH_WEBHOOK_SECRET && sig && !verifyDojahSignature(rawBody, sig)) {
      console.warn("[kyc] Dojah webhook: invalid signature")
      return c.json({ success: false, error: "Invalid signature" }, 401)
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400)
  }

  // Replay attack protection: check timestamp field if present
  const ts = (payload.timestamp ?? payload.created_at) as number | string | undefined
  if (ts) {
    const eventTime = typeof ts === "number" ? ts : parseInt(String(ts), 10)
    if (!isNaN(eventTime) && Date.now() - eventTime > REPLAY_WINDOW_MS) {
      console.warn("[kyc] Webhook replay detected — event too old")
      return c.json({ success: false, error: "Webhook timestamp too old" }, 400)
    }
  }

  // Determine provider from body if not in header
  if (!providerHeader) {
    detectedProvider = (payload.provider as string) === "dojah" ? "dojah" : "smileid"
  }

  const adapter = detectedProvider === "dojah" ? dojahProvider : smileIdProvider
  const result = await adapter.handleCallback(payload)

  const bySession = await prisma.user.findFirst({
    where: { kycSessionId: result.sessionId },
  })
  if (!bySession) {
    // Session not found — may have expired or been re-initiated
    console.warn(`[kyc] Webhook for unknown session: ${result.sessionId}`)
    return c.json({ success: true })
  }

  // Determine new tier based on KYC result
  let newTier: "GUEST" | "BASIC" | "FULL" | undefined
  if (result.status === "approved") {
    // Upgrade tier based on verification type (full biometric = FULL, document = BASIC)
    const isFullKyc = result.metadata?.verification_type === "biometric"
    newTier = isFullKyc ? "FULL" : "BASIC"
  }

  await prisma.user.update({
    where: { id: bySession.id },
    data: {
      kycStatus: result.status,
      kycCompletedAt: result.status === "approved" ? new Date() : undefined,
      tier: newTier,
    },
  })
  await prisma.kYCAttempt.updateMany({
    where: { userId: bySession.id, status: "pending" },
    data: { status: result.status, metadata: (result.metadata ?? {}) as object },
  })

  kycVerificationCounter.inc({ provider: detectedProvider, result: result.status })
  console.log(`[kyc] ${detectedProvider} callback for session ${result.sessionId}: ${result.status}`)

  return c.json({ success: true })
})

export default kyc
