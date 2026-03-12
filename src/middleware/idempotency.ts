/**
 * Redis-backed idempotency: reads Idempotency-Key header and sets it in context.
 * Routes (e.g. orders) perform cache lookup/set themselves using getRedis() and idempotencyKey.
 */

import type { Context, Next } from "hono"

const HEADER = "Idempotency-Key"

export async function idempotencyMiddleware(c: Context, next: Next): Promise<Response | void> {
  const key = c.req.header(HEADER)
  if (key && key.length > 0 && key.length <= 128) {
    c.set("idempotencyKey", key)
  }
  await next()
}

export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60 // 24h
export const idempotencyCacheKey = (key: string) => `idem:${key}`

/** Get idempotency key from context (set by middleware). */
export function getIdempotencyKey(c: Context): string | undefined {
  return c.get("idempotencyKey")
}
