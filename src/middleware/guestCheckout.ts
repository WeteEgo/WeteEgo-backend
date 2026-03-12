/**
 * Tier-based checkout enforcement.
 * 4 tiers with daily + monthly limits tracked in Redis.
 *
 * Tier limits (USD):
 *   GUEST:    $500/day,    $2,000/month
 *   BASIC:    $2,000/day, $10,000/month  (BVN verified)
 *   STANDARD: $5,000/day, $20,000/month  (document verified)
 *   FULL:     unlimited                  (biometric verified)
 */

import { getRedis } from "../lib/redis.js"
import { prisma } from "../lib/prisma.js"

type Tier = "GUEST" | "BASIC" | "STANDARD" | "FULL"

const TIER_LIMITS: Record<Tier, { dailyUsd: number | null; monthlyUsd: number | null; requiredKyc: boolean }> = {
  GUEST:    { dailyUsd: 500,   monthlyUsd: 2_000,  requiredKyc: false },
  BASIC:    { dailyUsd: 2_000, monthlyUsd: 10_000, requiredKyc: true },
  STANDARD: { dailyUsd: 5_000, monthlyUsd: 20_000, requiredKyc: true },
  FULL:     { dailyUsd: null,  monthlyUsd: null,   requiredKyc: true },
}

const DAILY_KEY_PREFIX = "tier_vol_daily:"
const MONTHLY_KEY_PREFIX = "tier_vol_monthly:"
const DAY_SEC = 24 * 60 * 60

export interface TierCheckResult {
  allowed: boolean
  reason?: string
  requiresKyc: boolean
  currentTier: Tier
  requiredTier?: Tier
}

function getCurrentMonthKey(wallet: string): string {
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  return `${MONTHLY_KEY_PREFIX}${wallet}:${ym}`
}

// Seconds until end of current month
function secondsUntilMonthEnd(): number {
  const now = new Date()
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return Math.ceil((nextMonth.getTime() - now.getTime()) / 1000)
}

// Determine the minimum tier required for a given order amount
function requiredTierForAmount(amountUsd: number): Tier {
  if (amountUsd <= 500) return "GUEST"
  if (amountUsd <= 2000) return "BASIC"
  if (amountUsd <= 5000) return "STANDARD"
  return "FULL"
}

export async function checkTierLimits(
  walletAddress: string,
  orderAmountUsd: number
): Promise<TierCheckResult> {
  const normalized = walletAddress.toLowerCase()
  const redis = getRedis()

  const user = await prisma.user.findUnique({
    where: { walletAddress: normalized },
    select: { kycStatus: true, tier: true },
  })

  const tier = (user?.tier ?? "GUEST") as Tier
  const limits = TIER_LIMITS[tier]

  // FULL tier: no limits
  if (limits.dailyUsd === null) {
    return { allowed: true, requiresKyc: false, currentTier: tier }
  }

  // Check if the order amount itself exceeds tier's single-order capability
  const neededTier = requiredTierForAmount(orderAmountUsd)
  const tierOrder: Tier[] = ["GUEST", "BASIC", "STANDARD", "FULL"]
  if (tierOrder.indexOf(neededTier) > tierOrder.indexOf(tier)) {
    return {
      allowed: false,
      reason: `Order amount $${orderAmountUsd} requires ${neededTier} tier. Current tier: ${tier}. Complete KYC to upgrade.`,
      requiresKyc: true,
      currentTier: tier,
      requiredTier: neededTier,
    }
  }

  // Check daily volume
  const dailyKey = `${DAILY_KEY_PREFIX}${normalized}`
  const rawDaily = await redis.get(dailyKey)
  const dailyVolume = rawDaily ? parseFloat(rawDaily) : 0
  if (dailyVolume + orderAmountUsd > limits.dailyUsd) {
    return {
      allowed: false,
      reason: `Daily limit ($${limits.dailyUsd}) reached. Used: $${dailyVolume.toFixed(0)}. Complete KYC to increase limits.`,
      requiresKyc: tier === "GUEST",
      currentTier: tier,
      requiredTier: tier === "GUEST" ? "BASIC" : undefined,
    }
  }

  // Check monthly volume
  const monthlyKey = getCurrentMonthKey(normalized)
  const rawMonthly = await redis.get(monthlyKey)
  const monthlyVolume = rawMonthly ? parseFloat(rawMonthly) : 0
  if (limits.monthlyUsd !== null && monthlyVolume + orderAmountUsd > limits.monthlyUsd) {
    return {
      allowed: false,
      reason: `Monthly limit ($${limits.monthlyUsd}) reached. Used: $${monthlyVolume.toFixed(0)}. Complete KYC to increase limits.`,
      requiresKyc: tier === "GUEST",
      currentTier: tier,
      requiredTier: tier === "GUEST" ? "BASIC" : undefined,
    }
  }

  return { allowed: true, requiresKyc: false, currentTier: tier }
}

export async function recordTierVolume(walletAddress: string, amountUsd: number): Promise<void> {
  const normalized = walletAddress.toLowerCase()
  const redis = getRedis()

  const dailyKey = `${DAILY_KEY_PREFIX}${normalized}`
  await redis.incrbyfloat(dailyKey, amountUsd)
  await redis.expire(dailyKey, DAY_SEC)

  const monthlyKey = getCurrentMonthKey(normalized)
  await redis.incrbyfloat(monthlyKey, amountUsd)
  await redis.expire(monthlyKey, secondsUntilMonthEnd())
}

// Legacy compat — used in orders.ts
export { checkTierLimits as checkGuestCheckout, recordTierVolume as recordGuestVolume }
