/**
 * Smile ID KYC adapter (sandbox/production).
 * Env: SMILE_ID_PARTNER_ID, SMILE_ID_API_KEY, SMILE_ID_CALLBACK_URL, SMILE_ID_SERVER (0=sandbox, 1=prod)
 */

import type { KYCProvider, KYCRequest, KYCSession, KYCResult } from "./types.js"

const SMILE_SERVER = process.env.SMILE_ID_SERVER === "1" ? "https://api.smileidentity.com" : "https://testapi.smileidentity.com"

function getHeaders(): HeadersInit {
  const key = process.env.SMILE_ID_API_KEY
  if (!key) throw new Error("SMILE_ID_API_KEY not set")
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
  }
}

export const smileIdProvider: KYCProvider = {
  name: "smileid",

  async initiateVerification(user: KYCRequest): Promise<KYCSession> {
    const partnerId = process.env.SMILE_ID_PARTNER_ID
    const callbackUrl = process.env.SMILE_ID_CALLBACK_URL
    if (!partnerId) throw new Error("SMILE_ID_PARTNER_ID not set")

    const jobId = `weteego-${user.userId}-${Date.now()}`
    const callbackPayload = {
      partner_id: partnerId,
      job_id: jobId,
      user_id: user.walletAddress,
      callback_url: callbackUrl ?? "",
    }

    try {
      const res = await fetch(`${SMILE_SERVER}/v1/upload`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          partner_id: partnerId,
          job_id: jobId,
          user_id: user.walletAddress,
          job_type: 6,
          callback_url: callbackUrl,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        const text = await res.text()
        const redirectUrl = `${SMILE_SERVER}/v1/sdk?payload=${encodeURIComponent(JSON.stringify(callbackPayload))}`
        return {
          sessionId: jobId,
          redirectUrl,
          clientId: user.userId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        }
      }
      const json = (await res.json()) as { job_id?: string; smile_job_id?: string }
      return {
        sessionId: json.job_id ?? json.smile_job_id ?? jobId,
        clientId: user.userId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }
    } catch {
      const redirectUrl = `${SMILE_SERVER}/v1/sdk?payload=${encodeURIComponent(JSON.stringify(callbackPayload))}`
      return {
        sessionId: jobId,
        redirectUrl,
        clientId: user.userId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }
    }
  },

  async handleCallback(payload: unknown): Promise<KYCResult> {
    const body = payload as {
      job_id?: string
      job_success?: boolean
      result?: { ResultCode?: string; ResultText?: string }
      [k: string]: unknown
    }
    const sessionId = body.job_id ?? String(body.job_success ?? "unknown")
    const success = body.job_success === true || body.result?.ResultCode === "1010"
    const status = success ? "approved" : body.result?.ResultCode === "1012" ? "rejected" : "manual_review"
    return {
      sessionId: String(sessionId),
      status: status as "approved" | "rejected" | "manual_review",
      provider: "smileid",
      metadata: body as Record<string, unknown>,
    }
  },

  async getVerificationStatus(sessionId: string): Promise<{ status: "pending" | "approved" | "rejected" | "manual_review"; metadata?: Record<string, unknown> }> {
    try {
      const res = await fetch(`${SMILE_SERVER}/v1/job_status?job_id=${encodeURIComponent(sessionId)}`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return { status: "pending" }
      const json = (await res.json()) as { job_success?: boolean; result?: { ResultCode?: string } }
      const success = json.job_success === true || json.result?.ResultCode === "1010"
      const status = success ? "approved" : json.result?.ResultCode === "1012" ? "rejected" : "pending"
      return { status: status as "approved" | "rejected" | "pending", metadata: json as Record<string, unknown> }
    } catch {
      return { status: "pending" }
    }
  },
}
