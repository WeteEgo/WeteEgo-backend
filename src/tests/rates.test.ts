import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("getRates cache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    process.env.PAYCREST_API_KEY = "test-key"
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it("reuses Paycrest response within 60s TTL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "success", data: 1600 }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const { getRates } = await import("../services/rates.js")
    const a = await getRates()
    const b = await getRates()
    expect(a.NGN).toBe(1600)
    expect(b.NGN).toBe(1600)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"))
    await getRates()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
