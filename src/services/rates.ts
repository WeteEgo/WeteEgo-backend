/**
 * Rates service — fetches live USDC→fiat exchange rates.
 * Primary source: Paycrest rates API.
 * Fallback: CoinGecko free API.
 * Cache: in-memory, refreshed every 60 seconds.
 */

interface RateCache {
  rates: Record<string, number>
  fetchedAt: number
}

const CACHE_TTL_MS = 60_000
let cache: RateCache | null = null

const FALLBACK_RATES: Record<string, number> = {
  NGN: 1_550,
  USD: 1,
}

async function fetchFromPaycrest(): Promise<Record<string, number> | null> {
  const apiUrl = process.env.PAYCREST_API_URL
  const apiKey = process.env.PAYCREST_API_KEY
  if (!apiUrl || !apiKey) return null

  try {
    const res = await fetch(`${apiUrl}/v1/rates`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { rates?: Record<string, number> }
    return data.rates ?? null
  } catch {
    return null
  }
}

async function fetchFromCoinGecko(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=ngn,usd",
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return null
    const data = (await res.json()) as { "usd-coin"?: { ngn?: number; usd?: number } }
    const coin = data["usd-coin"]
    if (!coin) return null
    return {
      NGN: coin.ngn ?? FALLBACK_RATES.NGN,
      USD: coin.usd ?? 1,
    }
  } catch {
    return null
  }
}

export async function getRates(): Promise<Record<string, number>> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rates
  }

  const rates =
    (await fetchFromPaycrest()) ??
    (await fetchFromCoinGecko()) ??
    FALLBACK_RATES

  cache = { rates, fetchedAt: now }
  return rates
}

export async function getRate(fiatCurrency: string): Promise<number> {
  const rates = await getRates()
  return rates[fiatCurrency.toUpperCase()] ?? 1
}
