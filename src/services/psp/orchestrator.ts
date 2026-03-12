/**
 * PSP orchestrator: Paycrest-only settlement.
 * Health tracking and circuit breaker still apply for Paycrest resilience.
 */

import type { PSPAdapter, PayoutRequest, PayoutResult, AccountVerification } from "./types.js"
import { paycrestAdapter } from "./paycrest-adapter.js"
import { isCircuitOpen, recordSuccess, recordFailure } from "./health.js"

/**
 * Create payout via Paycrest.
 * Returns result + provider name for tracking.
 */
export async function createPayoutWithFailover(req: PayoutRequest): Promise<{
  result: PayoutResult
  provider: string
}> {
  if (await isCircuitOpen("paycrest")) {
    return {
      result: {
        success: false,
        status: "failed",
        failureReason: "Paycrest circuit breaker open — service temporarily unavailable",
      },
      provider: "paycrest",
    }
  }

  const start = Date.now()
  try {
    const result = await paycrestAdapter.createPayout(req)
    const latencyMs = Date.now() - start
    if (result.success) {
      await recordSuccess("paycrest", latencyMs)
    } else {
      await recordFailure("paycrest")
    }
    return { result, provider: "paycrest" }
  } catch (err) {
    await recordFailure("paycrest")
    console.error("[psp] paycrest exception:", err)
    return {
      result: {
        success: false,
        status: "failed",
        failureReason: `Paycrest error: ${err instanceof Error ? err.message : String(err)}`,
      },
      provider: "paycrest",
    }
  }
}

/**
 * Verify bank account via Paycrest.
 */
export async function verifyBankAccount(
  bankCode: string,
  accountNumber: string
): Promise<AccountVerification> {
  return paycrestAdapter.verifyAccount(bankCode, accountNumber)
}

export function getAdapters(): PSPAdapter[] {
  return [paycrestAdapter]
}
