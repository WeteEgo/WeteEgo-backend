/**
 * Paycrest API client.
 * Handles order creation and status queries with the Paycrest aggregator.
 */

export interface PaycrestOrderPayload {
  settlementRef: string
  walletAddress: string
  tokenAddress: string
  amount: string
  fiatCurrency: string
}

export interface PaycrestOrder {
  id: string
  status: string
}

export async function createPaycrestOrder(
  payload: PaycrestOrderPayload
): Promise<PaycrestOrder | null> {
  const apiUrl = process.env.PAYCREST_API_URL
  const apiKey = process.env.PAYCREST_API_KEY
  if (!apiUrl || !apiKey) return null

  try {
    const res = await fetch(`${apiUrl}/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return (await res.json()) as PaycrestOrder
  } catch {
    return null
  }
}
