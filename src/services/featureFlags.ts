/**
 * Redis-backed feature flags for canary and rollout control.
 */

import { getRedis } from "../lib/redis.js"

const PREFIX = "ff:"
const TTL = 60 // 1 min cache

const DEFAULTS: Record<string, boolean> = {
  kyc_required: false,
  guest_checkout_enabled: true,
  sdk_public_access: false,
}

let cache: Record<string, boolean> = { ...DEFAULTS }
let cacheTs = 0

export async function getFlag(name: string): Promise<boolean> {
  if (Date.now() - cacheTs < TTL * 1000 && name in cache) return cache[name]
  const redis = getRedis()
  try {
    const raw = await redis.get(`${PREFIX}${name}`)
    if (raw !== null) {
      const v = raw === "1" || raw === "true"
      cache[name] = v
      return v
    }
  } catch {
    // fallback to cache or default
  }
  const v = DEFAULTS[name] ?? false
  cache[name] = v
  return v
}

export async function setFlag(name: string, value: boolean): Promise<void> {
  const redis = getRedis()
  await redis.set(`${PREFIX}${name}`, value ? "1" : "0")
  cache[name] = value
  cacheTs = Date.now()
}

export async function getAllFlags(): Promise<Record<string, boolean>> {
  const out = { ...DEFAULTS }
  const redis = getRedis()
  for (const key of Object.keys(DEFAULTS)) {
    try {
      const raw = await redis.get(`${PREFIX}${key}`)
      if (raw !== null) out[key] = raw === "1" || raw === "true"
    } catch {
      // keep default
    }
  }
  cache = { ...out }
  cacheTs = Date.now()
  return out
}
