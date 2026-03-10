import type { Context, Next } from "hono"
import { getRedis } from "../lib/redis.js"

async function checkRateLimit(
  ip: string,
  scope: string,
  max: number,
  windowSeconds: number,
  c: Context,
  next: Next
): Promise<Response> {
  const key = `ratelimit:${scope}:${ip}`
  try {
    const redis = getRedis()
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, windowSeconds)
    }
    if (count > max) {
      return c.json({ error: "Too many requests" }, 429)
    }
  } catch {
    // Redis unavailable — fail open to avoid blocking legitimate traffic
  }
  return next()
}

function getClientIP(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  )
}

/** 60 requests/min per IP for rate and quote endpoints */
export function rateLimitRates(c: Context, next: Next) {
  return checkRateLimit(getClientIP(c), "rates", 60, 60, c, next)
}

/** 10 requests/min per IP for order creation */
export function rateLimitOrders(c: Context, next: Next) {
  return checkRateLimit(getClientIP(c), "orders", 10, 60, c, next)
}
