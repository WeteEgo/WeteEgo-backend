/**
 * Sandbox API keys: store hashed key, environment, permissions, rate limit, expiry.
 * Keys are created via admin; validated via middleware (optional).
 */

import { createHash } from "crypto"
import { getRedis } from "../lib/redis.js"

const REDIS_PREFIX = "apikey:"
const TTL = 24 * 60 * 60 // 24h cache

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

export async function validateApiKey(
  rawKey: string,
  env: "sandbox" | "production"
): Promise<{ valid: boolean; keyId?: string }> {
  if (!rawKey || !rawKey.startsWith("sk_")) return { valid: false }
  const hashed = hashKey(rawKey)
  const redis = getRedis()
  const cached = await redis.get(`${REDIS_PREFIX}${hashed}`)
  if (cached) {
    const data = JSON.parse(cached) as { env: string; keyId: string }
    if (data.env !== env) return { valid: false }
    return { valid: true, keyId: data.keyId }
  }
  return { valid: false }
}

export async function storeApiKey(
  keyId: string,
  hashedKey: string,
  environment: string,
  _permissions: string[]
): Promise<void> {
  const redis = getRedis()
  await redis.setex(
    `${REDIS_PREFIX}${hashedKey}`,
    TTL,
    JSON.stringify({ env: environment, keyId })
  )
}
