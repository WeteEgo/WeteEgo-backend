/**
 * Full stack smoke: POST /api/orders → mock OrderCreated → Go state machine → Paycrest mock.
 * Requires Postgres, Redis, and the Go order service; run manually in CI staging when wired.
 */
import { describe, it } from "vitest"

describe.skip("order flow integration (manual / staging)", () => {
  it("PENDING → ESCROWED → PAYOUT_SENT with Redis order:state:{ref}", async () => {
    // TODO: spin services or use testcontainers; drive Go OnOrderCreated with mock PaycrestProvider.
  })
})
