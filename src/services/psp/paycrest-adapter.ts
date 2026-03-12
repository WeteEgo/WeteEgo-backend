/**
 * Paycrest as PSP adapter — wraps existing createPaycrestOrder.
 * Implements real verifyAccount and getPayoutStatus via Paycrest API.
 */

import {
  createPaycrestOrder,
  checkPaycrestHealth,
} from "../paycrest.js"
import type {
  PSPAdapter,
  PayoutRequest,
  PayoutResult,
  AccountVerification,
  PayoutStatus,
  WebhookEvent,
} from "./types.js"

const PAYCREST_BASE = "https://api.paycrest.io/v1"

function getHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "API-Key": process.env.PAYCREST_API_KEY ?? "",
  }
}

export const paycrestAdapter: PSPAdapter = {
  name: "paycrest",

  async createPayout(req: PayoutRequest): Promise<PayoutResult> {
    const chainId = Number(process.env.CHAIN_ID ?? 84532)
    const network = chainId === 8453 ? "base" : "base-sepolia"
    const usdcAmount = (BigInt(req.amountUsdcUnits) / BigInt(1_000_000)).toString()

    const result = await createPaycrestOrder({
      amount: usdcAmount,
      token: "USDC",
      network,
      recipient: {
        institution: req.recipient.bankCode,
        accountIdentifier: req.recipient.accountNumber,
        accountName: req.recipient.accountName,
        currency: req.recipient.currency || "NGN",
      },
      reference: req.settlementRef,
    })

    if (!result) {
      return { success: false, status: "failed", failureReason: "Paycrest order creation failed" }
    }

    return {
      success: true,
      pspReference: result.id,
      status: result.status === "completed" ? "success" : "pending",
      estimatedSettlementMs: 120_000,
    }
  },

  async verifyAccount(bankCode: string, accountNumber: string): Promise<AccountVerification> {
    const key = process.env.PAYCREST_API_KEY
    if (!key) {
      return { valid: false, error: "PAYCREST_API_KEY not set" }
    }

    const body = JSON.stringify({
      institution: bankCode,
      accountIdentifier: accountNumber,
    })
    const tryPath = async (path: string): Promise<Response> =>
      fetch(`${PAYCREST_BASE}${path}`, {
        method: "POST",
        headers: getHeaders(),
        body,
        signal: AbortSignal.timeout(5_000),
      })

    try {
      let res = await tryPath("/sender/verify-account")
      if (res.status === 404) {
        res = await tryPath("/verify-account")
      }

      if (!res.ok) {
        const text = await res.text()
        console.error(`[paycrest] verifyAccount failed ${res.status}: ${text}`)
        if (res.status === 404) {
          return { valid: true, accountName: undefined, error: "Verification endpoint not available" }
        }
        return { valid: false, error: `Paycrest verification failed: ${res.status}` }
      }

      const json = (await res.json()) as {
        status?: string
        data?: string | { accountName?: string; bankName?: string; account_name?: string; bank_name?: string }
      }
      const data = json.data
      let accountName: string | undefined
      let bankName: string | undefined
      if (typeof data === "string") {
        accountName = data.trim() || undefined
      } else if (data && typeof data === "object") {
        accountName =
          data.accountName ?? (data as { account_name?: string }).account_name ?? undefined
        bankName =
          data.bankName ?? (data as { bank_name?: string }).bank_name ?? undefined
      }
      return {
        valid: true,
        accountName,
        bankName,
        bankCode,
      }
    } catch (err) {
      console.error("[paycrest] verifyAccount exception:", err)
      // On timeout or network error, allow order to proceed (degrade open)
      return { valid: true, error: "Verification unavailable" }
    }
  },

  async getPayoutStatus(reference: string): Promise<{ status: PayoutStatus; failureReason?: string }> {
    const key = process.env.PAYCREST_API_KEY
    if (!key) {
      return { status: "pending", failureReason: "PAYCREST_API_KEY not set" }
    }

    try {
      const res = await fetch(`${PAYCREST_BASE}/sender/orders/${encodeURIComponent(reference)}`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(5_000),
      })

      if (!res.ok) {
        const text = await res.text()
        console.error(`[paycrest] getPayoutStatus failed ${res.status}: ${text}`)
        return { status: "pending", failureReason: `API error: ${res.status}` }
      }

      const json = (await res.json()) as {
        status?: string
        data?: { status?: string; failureReason?: string }
      }
      const orderStatus = (json.data?.status ?? "").toLowerCase()

      if (orderStatus === "completed" || orderStatus === "settled") {
        return { status: "success" }
      }
      if (orderStatus === "failed" || orderStatus === "cancelled" || orderStatus === "expired") {
        return { status: "failed", failureReason: json.data?.failureReason ?? orderStatus }
      }
      if (orderStatus === "processing" || orderStatus === "matched") {
        return { status: "processing" }
      }
      return { status: "pending" }
    } catch (err) {
      console.error("[paycrest] getPayoutStatus exception:", err)
      return { status: "pending", failureReason: String(err) }
    }
  },

  async handleWebhook(payload: unknown, _signature: string): Promise<WebhookEvent> {
    const body = payload as { event?: string; data?: { reference?: string; id?: string; status?: string } }
    const ref = body.data?.id ?? body.data?.reference ?? ""
    const status = (body.data?.status ?? "").toLowerCase()
    return {
      type: status === "completed" || status === "settled" || status === "success" ? "payout.success" : "payout.failed",
      pspReference: ref,
      status: status === "completed" || status === "settled" || status === "success" ? "success" : "failed",
      rawPayload: payload,
    }
  },

  async healthCheck(): Promise<boolean> {
    const r = await checkPaycrestHealth()
    return r.ok
  },
}
