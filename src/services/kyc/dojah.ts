/**
 * Dojah KYC adapter (backup). Nigeria: BVN, NIN, address verification.
 * Env: DOJAH_APP_ID, DOJAH_SECRET_KEY, DOJAH_BASE_URL (optional)
 */

import type { KYCProvider, KYCRequest, KYCSession, KYCResult } from "./types.js"

const BASE = process.env.DOJAH_BASE_URL ?? "https://api.dojah.io"

function getHeaders(): HeadersInit {
  const appId = process.env.DOJAH_APP_ID
  const secret = process.env.DOJAH_SECRET_KEY
  if (!appId || !secret) throw new Error("DOJAH_APP_ID and DOJAH_SECRET_KEY required")
  return {
    "Content-Type": "application/json",
    "AppId": appId,
    "Authorization": secret,
  }
}

export const dojahProvider: KYCProvider = {
  name: "dojah",

  async initiateVerification(user: KYCRequest): Promise<KYCSession> {
    const sessionId = `dojah-${user.userId}-${Date.now()}`
    return {
      sessionId,
      clientId: user.userId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }
  },

  async handleCallback(payload: unknown): Promise<KYCResult> {
    const body = payload as { entity?: { status?: string }; status?: string }
    const s = (body.entity?.status ?? body.status ?? "").toLowerCase()
    const status = s === "verified" || s === "success" ? "approved" : s === "failed" ? "rejected" : "manual_review"
    return {
      sessionId: (body as { reference?: string }).reference ?? "unknown",
      status: status as "approved" | "rejected" | "manual_review",
      provider: "dojah",
      metadata: body as Record<string, unknown>,
    }
  },

  async getVerificationStatus(sessionId: string): Promise<{ status: "pending" | "approved" | "rejected" | "manual_review"; metadata?: Record<string, unknown> }> {
    try {
      const res = await fetch(`${BASE}/api/v1/verification/status/${encodeURIComponent(sessionId)}`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return { status: "pending" }
      const json = (await res.json()) as { entity?: { status?: string } }
      const s = (json.entity?.status ?? "").toLowerCase()
      const status = s === "verified" || s === "success" ? "approved" : s === "failed" ? "rejected" : "pending"
      return { status: status as "approved" | "rejected" | "pending", metadata: json as Record<string, unknown> }
    } catch {
      return { status: "pending" }
    }
  },
}
