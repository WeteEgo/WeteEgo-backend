/**
 * AML streaming rules: velocity, high value, cumulative daily, rapid sequential.
 * Risk scoring: composite score determines block/flag/pass outcome.
 * Thresholds scale with KYC tier.
 */

import { getRedis } from "../../lib/redis.js"

const REDIS_PREFIX = "aml:"
const VELOCITY_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const CUMULATIVE_WINDOW_SEC = 24 * 60 * 60
const RAPID_SECONDS = 30

// Score weights per rule
const SCORES = {
  velocity: 25,
  rapid_sequential: 30,
  high_value: 40,
  cumulative_daily: 20,
}

// Thresholds per KYC tier
const THRESHOLDS = {
  GUEST: {
    velocityCount: 5,
    highValueUsd: 2000,
    cumulativeDailyUsd: 5000,
  },
  BASIC: {
    velocityCount: 10,
    highValueUsd: 5000,
    cumulativeDailyUsd: 15000,
  },
  STANDARD: {
    velocityCount: 15,
    highValueUsd: 7500,
    cumulativeDailyUsd: 20000,
  },
  FULL: {
    velocityCount: 20,
    highValueUsd: 10000,
    cumulativeDailyUsd: 50000,
  },
}

export type KYCTier = "GUEST" | "BASIC" | "STANDARD" | "FULL"

export interface AMLRuleResult {
  rule: string
  severity: "low" | "medium" | "high"
  detail: string
  score: number
}

export interface AMLCheckResult {
  rules: AMLRuleResult[]
  riskScore: number
  blocked: boolean // score > 50
  flagged: boolean // score 30-50
}

export async function checkAMLRules(
  walletAddress: string,
  orderAmountUsd: number,
  tier: KYCTier = "GUEST"
): Promise<AMLCheckResult> {
  const normalized = walletAddress.toLowerCase()
  const redis = getRedis()
  const now = Date.now()
  const thresholds = THRESHOLDS[tier] ?? THRESHOLDS.GUEST

  const orderKey = `${REDIS_PREFIX}orders:${normalized}`
  const volumeKey = `${REDIS_PREFIX}volume:${normalized}`

  const rawVolume = await redis.get(volumeKey)
  const dailyVolume = rawVolume ? parseFloat(rawVolume) : 0
  const newVolume = dailyVolume + orderAmountUsd

  const recentOrders = await redis.lrange(orderKey, 0, -1)
  const timestamps = recentOrders.map((s) => parseInt(s, 10)).filter((t) => now - t < VELOCITY_WINDOW_MS)
  const velocityCount = timestamps.length + 1

  const results: AMLRuleResult[] = []

  if (velocityCount > thresholds.velocityCount) {
    results.push({
      rule: "velocity",
      severity: "high",
      detail: `More than ${thresholds.velocityCount} orders in 1 hour (${velocityCount})`,
      score: SCORES.velocity,
    })
  }

  if (orderAmountUsd > thresholds.highValueUsd) {
    results.push({
      rule: "high_value",
      severity: orderAmountUsd > thresholds.highValueUsd * 5 ? "high" : "medium",
      detail: `Single order > $${thresholds.highValueUsd} ($${orderAmountUsd})`,
      score: SCORES.high_value,
    })
  }

  if (newVolume > thresholds.cumulativeDailyUsd) {
    results.push({
      rule: "cumulative_daily",
      severity: "medium",
      detail: `24h volume would exceed $${thresholds.cumulativeDailyUsd} ($${newVolume.toFixed(0)})`,
      score: SCORES.cumulative_daily,
    })
  }

  const lastTs = timestamps[timestamps.length - 1]
  if (lastTs && now - lastTs < RAPID_SECONDS * 1000) {
    results.push({
      rule: "rapid_sequential",
      severity: "medium",
      detail: `Order within ${RAPID_SECONDS}s of previous`,
      score: SCORES.rapid_sequential,
    })
  }

  const riskScore = results.reduce((sum, r) => sum + r.score, 0)

  return {
    rules: results,
    riskScore,
    blocked: riskScore > 50,
    flagged: riskScore >= 30 && riskScore <= 50,
  }
}

export async function recordOrderForAML(walletAddress: string, orderAmountUsd: number): Promise<void> {
  const normalized = walletAddress.toLowerCase()
  const redis = getRedis()
  const now = Date.now()

  const orderKey = `${REDIS_PREFIX}orders:${normalized}`
  const volumeKey = `${REDIS_PREFIX}volume:${normalized}`

  await redis.lpush(orderKey, String(now))
  await redis.ltrim(orderKey, 0, 99)
  await redis.expire(orderKey, VELOCITY_WINDOW_MS / 1000 + 60)

  await redis.incrbyfloat(volumeKey, orderAmountUsd)
  await redis.expire(volumeKey, CUMULATIVE_WINDOW_SEC)
}
