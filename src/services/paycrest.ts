/**
 * Paycrest API client — v1, pinned per docs.paycrest.io
 * Auth: API-Key header (not Bearer)
 * Order endpoint: POST /v1/sender/orders
 * Rate endpoint: GET /v1/provider/rates/{token}/{fiat}
 */

const PAYCREST_BASE = "https://api.paycrest.io/v1"

export interface PaycrestRecipient {
  institution: string   // SWIFT code first 7 chars for banks, e.g. "GTBINGLA"
  accountIdentifier: string  // 10-digit NUBAN
  accountName: string
  currency: string      // ISO 4217, e.g. "NGN"
}

export interface CreatePaycrestOrderParams {
  amount: string          // USDC decimal, e.g. "10.50" (NOT wei)
  token: string           // "USDC"
  network: string         // "base" (mainnet) or "base-sepolia" (testnet)
  recipient: PaycrestRecipient
  reference: string       // our settlementRef bytes32
}

export interface PaycrestOrderResponse {
  id: string
  status: string
}

function getHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "API-Key": process.env.PAYCREST_API_KEY ?? "",
  }
}

/**
 * Create a Paycrest sender order.
 * Returns { id, status } on success, null on any failure.
 * Logs errors with full body for diagnostics.
 */
export async function createPaycrestOrder(
  params: CreatePaycrestOrderParams
): Promise<PaycrestOrderResponse | null> {
  const key = process.env.PAYCREST_API_KEY
  if (!key) {
    console.error("[paycrest] PAYCREST_API_KEY not set")
    return null
  }

  try {
    const body = {
      amount: params.amount,
      token: params.token,
      network: params.network,
      recipient: {
        institution: params.recipient.institution,
        accountIdentifier: params.recipient.accountIdentifier,
        accountName: params.recipient.accountName,
        currency: params.recipient.currency,
      },
      reference: params.reference,
    }

    const res = await fetch(`${PAYCREST_BASE}/sender/orders`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })

    const text = await res.text()

    if (!res.ok) {
      console.error(`[paycrest] createOrder failed ${res.status}: ${text}`)
      return null
    }

    const json = JSON.parse(text) as { status?: string; data?: PaycrestOrderResponse }
    const order = json.data
    if (!order?.id) {
      console.error("[paycrest] createOrder: no id in response:", text)
      return null
    }

    console.log(`[paycrest] order created id=${order.id} status=${order.status}`)
    return order
  } catch (err) {
    console.error("[paycrest] createOrder exception:", err)
    return null
  }
}

/**
 * Fetch live USDC→fiat rate from Paycrest.
 * Returns null on failure (caller should fall back to CoinGecko).
 */
export async function getPaycrestRate(
  token: string,
  fiat: string
): Promise<number | null> {
  const key = process.env.PAYCREST_API_KEY
  if (!key) return null

  try {
    const res = await fetch(
      `${PAYCREST_BASE}/provider/rates/${token.toUpperCase()}/${fiat.toUpperCase()}`,
      {
        headers: getHeaders(),
        signal: AbortSignal.timeout(5_000),
      }
    )
    if (!res.ok) return null
    const json = (await res.json()) as { status?: string; data?: string | number }
    const rate = json.data
    if (rate === undefined || rate === null) return null
    return typeof rate === "number" ? rate : parseFloat(String(rate))
  } catch {
    return null
  }
}

/**
 * Health check: verifies API key is valid and Paycrest is reachable.
 * Returns { ok, stats } or { ok: false, error }.
 */
export async function checkPaycrestHealth(): Promise<{
  ok: boolean
  totalOrders?: number
  totalVolume?: string
  error?: string
}> {
  const key = process.env.PAYCREST_API_KEY
  if (!key) return { ok: false, error: "PAYCREST_API_KEY not set" }

  try {
    const res = await fetch(`${PAYCREST_BASE}/sender/stats`, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      const text = await res.text()
      return { ok: false, error: `${res.status}: ${text}` }
    }
    const json = (await res.json()) as {
      data?: { totalOrders?: number; totalOrderVolume?: string }
    }
    return {
      ok: true,
      totalOrders: json.data?.totalOrders,
      totalVolume: json.data?.totalOrderVolume,
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
