/**
 * Per-PSP circuit breaker with Redis persistence.
 * States: CLOSED (healthy) | OPEN (failing, reject calls) | HALF_OPEN (probing)
 *
 * Transitions:
 *   CLOSED  → OPEN:      failure rate ≥ 40% over 30 requests in 5-min window
 *   OPEN    → HALF_OPEN: after 60s cooldown — allow one probe request
 *   HALF_OPEN → CLOSED:  probe succeeds
 *   HALF_OPEN → OPEN:    probe fails (reset timer)
 *
 * State is persisted to Redis so it survives pod restarts.
 */

import { getRedis } from "../../lib/redis.js"
import { pspHealthGauge } from "../../lib/metrics.js"

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

const WINDOW_MS = 5 * 60 * 1000       // 5-minute rolling window
const FAILURE_RATE_THRESHOLD = 0.40   // 40% failure rate → open circuit
const MIN_REQUESTS = 30               // minimum requests before evaluating
const COOLDOWN_MS = 60_000            // 60s before transitioning OPEN → HALF_OPEN
const REDIS_TTL_SEC = 60 * 60         // 1-hour TTL on Redis keys

// Gauge values: 0=CLOSED, 1=OPEN, 2=HALF_OPEN
const GAUGE_VALUES: Record<CircuitState, number> = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 }

function redisKey(provider: string, field: string): string {
  return `psp:circuit:${provider}:${field}`
}

// In-memory fallback for when Redis is unavailable
const memState = new Map<string, {
  state: CircuitState
  openedAt: number | null
  successCount: number
  failureCount: number
  windowStart: number
}>()

function getMemState(provider: string) {
  if (!memState.has(provider)) {
    memState.set(provider, {
      state: "CLOSED",
      openedAt: null,
      successCount: 0,
      failureCount: 0,
      windowStart: Date.now(),
    })
  }
  return memState.get(provider)!
}

async function persistState(provider: string, state: CircuitState, openedAt: number | null): Promise<void> {
  const redis = getRedis()
  try {
    await redis.setex(redisKey(provider, "state"), REDIS_TTL_SEC, state)
    if (openedAt !== null) {
      await redis.setex(redisKey(provider, "opened_at"), REDIS_TTL_SEC, String(openedAt))
    } else {
      await redis.del(redisKey(provider, "opened_at"))
    }
  } catch {
    // Redis unavailable — in-memory fallback continues
  }
}

async function loadState(provider: string): Promise<{ state: CircuitState; openedAt: number | null }> {
  const redis = getRedis()
  try {
    const [stateRaw, openedAtRaw] = await Promise.all([
      redis.get(redisKey(provider, "state")),
      redis.get(redisKey(provider, "opened_at")),
    ])
    const state = (stateRaw as CircuitState | null) ?? "CLOSED"
    const openedAt = openedAtRaw ? parseInt(openedAtRaw, 10) : null
    return { state, openedAt }
  } catch {
    const mem = getMemState(provider)
    return { state: mem.state, openedAt: mem.openedAt }
  }
}

async function onStateChange(provider: string, from: CircuitState, to: CircuitState): Promise<void> {
  const gaugeValue = GAUGE_VALUES[to]
  pspHealthGauge.set({ provider }, to === "CLOSED" ? 1 : 0)

  // Update extended circuit-state metric if it exists (added in metrics.ts)
  try {
    const { pspCircuitStateGauge } = await import("../../lib/metrics.js")
    pspCircuitStateGauge?.set({ provider }, gaugeValue)
  } catch {
    // metric may not exist yet
  }

  if (to === "OPEN") {
    console.warn(`[circuit-breaker] ${provider}: OPEN (was ${from}) — triggering alert`)
    await sendCircuitAlert(provider, from)
  } else if (to === "CLOSED" && from !== "CLOSED") {
    console.info(`[circuit-breaker] ${provider}: recovered → CLOSED`)
  }
}

async function sendCircuitAlert(provider: string, prevState: CircuitState): Promise<void> {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL
  if (!webhookUrl) return

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `🔴 *WeteEgo Circuit Breaker OPEN*\nProvider: *${provider}*\nPrevious state: ${prevState}\nAction: New orders will fail until service recovers.\nCheck: \`GET /admin/stats\` or Grafana PSP health dashboard.`,
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Alert failure must not affect normal operation
  }
}

export async function recordSuccess(provider: string, latencyMs: number): Promise<void> {
  const mem = getMemState(provider)
  const now = Date.now()

  // Reset window if expired
  if (now - mem.windowStart > WINDOW_MS) {
    mem.successCount = 0
    mem.failureCount = 0
    mem.windowStart = now
  }

  mem.successCount++

  const { state } = await loadState(provider)

  if (state === "HALF_OPEN") {
    // Probe succeeded — close circuit
    mem.state = "CLOSED"
    mem.openedAt = null
    await persistState(provider, "CLOSED", null)
    await onStateChange(provider, "HALF_OPEN", "CLOSED")
  } else if (state === "CLOSED") {
    pspHealthGauge.set({ provider }, 1)
  }
}

export async function recordFailure(provider: string): Promise<void> {
  const mem = getMemState(provider)
  const now = Date.now()

  // Reset window if expired
  if (now - mem.windowStart > WINDOW_MS) {
    mem.successCount = 0
    mem.failureCount = 0
    mem.windowStart = now
  }

  mem.failureCount++

  const { state, openedAt } = await loadState(provider)

  if (state === "HALF_OPEN") {
    // Probe failed — reopen circuit
    mem.state = "OPEN"
    mem.openedAt = now
    await persistState(provider, "OPEN", now)
    await onStateChange(provider, "HALF_OPEN", "OPEN")
    return
  }

  if (state === "OPEN") return

  // Evaluate whether to open circuit (CLOSED → OPEN)
  const total = mem.successCount + mem.failureCount
  const rate = total > 0 ? mem.failureCount / total : 0
  if (rate >= FAILURE_RATE_THRESHOLD && total >= MIN_REQUESTS) {
    mem.state = "OPEN"
    mem.openedAt = now
    await persistState(provider, "OPEN", now)
    await onStateChange(provider, "CLOSED", "OPEN")
  }
}

export async function isCircuitOpen(provider: string): Promise<boolean> {
  const { state, openedAt } = await loadState(provider)

  if (state === "CLOSED") return false

  if (state === "OPEN") {
    if (openedAt && Date.now() - openedAt > COOLDOWN_MS) {
      // Transition to HALF_OPEN for probe
      const mem = getMemState(provider)
      mem.state = "HALF_OPEN"
      mem.openedAt = openedAt
      await persistState(provider, "HALF_OPEN", openedAt)
      await onStateChange(provider, "OPEN", "HALF_OPEN")
      return false // allow probe request through
    }
    return true
  }

  // HALF_OPEN: allow one probe through
  return false
}

export interface PSPHealthState {
  provider: string
  state: CircuitState
  successCount: number
  failureCount: number
  lastLatencyMs: number
  openedAt: number | null
}

export async function getHealthState(provider: string): Promise<PSPHealthState> {
  const mem = getMemState(provider)
  const { state, openedAt } = await loadState(provider)
  return {
    provider,
    state,
    successCount: mem.successCount,
    failureCount: mem.failureCount,
    lastLatencyMs: 0,
    openedAt,
  }
}

export async function getAllHealthStates(): Promise<PSPHealthState[]> {
  const providers = ["paycrest"]
  return Promise.all(providers.map(getHealthState))
}
