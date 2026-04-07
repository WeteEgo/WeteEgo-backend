import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../services/paycrest.js", () => ({
  createPaycrestOrder: vi.fn(),
  checkPaycrestHealth: vi.fn(),
}))

describe("paycrestAdapter.createPayout", () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.PAYCREST_API_KEY = "k"
    process.env.CHAIN_ID = "84532"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns success when createPaycrestOrder returns id", async () => {
    const { createPaycrestOrder } = await import("../services/paycrest.js")
    vi.mocked(createPaycrestOrder).mockResolvedValue({ id: "pc_1", status: "pending" })

    const { paycrestAdapter } = await import("../services/psp/paycrest-adapter.js")
    const result = await paycrestAdapter.createPayout({
      orderId: "o1",
      settlementRef: "0xabc",
      amountNgn: 100,
      amountUsdcUnits: "1000000",
      recipient: {
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test User",
        currency: "NGN",
      },
      idempotencyKey: "idem-1",
    })

    expect(result.success).toBe(true)
    expect(result.pspReference).toBe("pc_1")
  })

  it("maps Paycrest failure (null) to failed result", async () => {
    const { createPaycrestOrder } = await import("../services/paycrest.js")
    vi.mocked(createPaycrestOrder).mockResolvedValue(null)

    const { paycrestAdapter } = await import("../services/psp/paycrest-adapter.js")
    const result = await paycrestAdapter.createPayout({
      orderId: "o1",
      settlementRef: "0xabc",
      amountNgn: 100,
      amountUsdcUnits: "1000000",
      recipient: {
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test User",
        currency: "NGN",
      },
      idempotencyKey: "idem-1",
    })

    expect(result.success).toBe(false)
    expect(result.status).toBe("failed")
  })

  it("propagates unexpected errors from createPaycrestOrder", async () => {
    const { createPaycrestOrder } = await import("../services/paycrest.js")
    vi.mocked(createPaycrestOrder).mockRejectedValue(new Error("network down"))

    const { paycrestAdapter } = await import("../services/psp/paycrest-adapter.js")
    await expect(
      paycrestAdapter.createPayout({
        orderId: "o1",
        settlementRef: "0xabc",
        amountNgn: 100,
        amountUsdcUnits: "1000000",
        recipient: {
          accountNumber: "0123456789",
          bankCode: "058",
          accountName: "Test User",
          currency: "NGN",
        },
        idempotencyKey: "idem-1",
      })
    ).rejects.toThrow("network down")
  })
})
