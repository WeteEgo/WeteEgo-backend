import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $transaction: vi.fn(),
    order: { findUnique: vi.fn() },
  },
}))

const redisStub = {
  get: vi.fn(),
  setex: vi.fn().mockResolvedValue("OK"),
  duplicate: vi.fn(),
  subscribe: vi.fn(),
  disconnect: vi.fn(),
  unsubscribe: vi.fn(),
  on: vi.fn(),
  publish: vi.fn(),
  ping: vi.fn(),
}

vi.mock("../lib/redis.js", () => ({
  getRedis: () => redisStub,
}))

vi.mock("../services/rates.js", () => ({
  getRate: vi.fn().mockResolvedValue(1500),
}))

vi.mock("../services/aml/rules.js", () => ({
  checkAMLRules: vi.fn().mockResolvedValue({ rules: [], riskScore: 0, blocked: false, flagged: false }),
  recordOrderForAML: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../middleware/guestCheckout.js", () => ({
  checkGuestCheckout: vi.fn().mockResolvedValue({
    allowed: true,
    currentTier: "GUEST",
    requiresKyc: false,
  }),
  recordGuestVolume: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../services/psp/orchestrator.js", () => ({
  verifyBankAccount: vi.fn().mockResolvedValue({ valid: true }),
}))

import orders from "../routes/orders.js"
import { prisma } from "../lib/prisma.js"
import { checkAMLRules } from "../services/aml/rules.js"

const baseBody = {
  walletAddress: "0x1234567890123456789012345678901234567890",
  tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "1000000",
  fiatCurrency: "NGN",
  bankAccount: {
    accountNumber: "0123456789",
    bankCode: "058",
    accountName: "Test User",
  },
}

function testApp() {
  const app = new Hono<{ Variables: { idempotencyKey?: string } }>()
  app.use("/api/orders", async (c, next) => {
    const key = c.req.header("Idempotency-Key")
    if (key && key.length > 0 && key.length <= 128) {
      c.set("idempotencyKey", key)
    }
    await next()
  })
  app.route("/api/orders", orders)
  return app
}

describe("orders routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisStub.get.mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const mockTx = {
        order: {
          create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({
              id: "order_cuid_1",
              status: "PENDING",
              fiatCurrency: data.fiatCurrency,
              ...data,
            })
          ),
        },
        aMLAlert: { create: vi.fn().mockResolvedValue({}) },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      }
      return fn(mockTx as never)
    })
  })

  it("POST /api/orders succeeds and returns 201", async () => {
    const app = testApp()
    const res = await app.request("http://localhost/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { success: boolean; data: { settlementRef: string } }
    expect(json.success).toBe(true)
    expect(json.data.settlementRef).toMatch(/^0x[a-f0-9]{64}$/)
  })

  it("POST rejects invalid NUBAN length", async () => {
    const app = testApp()
    const res = await app.request("http://localhost/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        bankAccount: { ...baseBody.bankAccount, accountNumber: "12345" },
      }),
    })
    expect(res.status).toBe(400)
  })

  it("POST blocks when AML risk score exceeds threshold", async () => {
    vi.mocked(checkAMLRules).mockResolvedValueOnce({
      rules: [{ rule: "high_value", severity: "high", detail: "x", score: 60 }],
      riskScore: 60,
      blocked: true,
      flagged: true,
    })
    const app = testApp()
    const res = await app.request("http://localhost/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    })
    expect(res.status).toBe(403)
  })

  it("POST returns cached body when Idempotency-Key hits Redis", async () => {
    const cached = { data: { success: true, data: { id: "x", settlementRef: "0xabc" } }, status: 201 }
    redisStub.get.mockResolvedValueOnce(JSON.stringify(cached))
    const app = testApp()
    const res = await app.request("http://localhost/api/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-test-1",
      },
      body: JSON.stringify(baseBody),
    })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json).toEqual(cached.data)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("GET /api/orders/:ref returns order", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValueOnce({
      id: "1",
      settlementRef: "0xref",
      walletAddress: "0x12",
      fiatCurrency: "NGN",
      fiatAmount: 100,
      rate: 1500,
      status: "PENDING",
      txHash: null,
      pspProvider: null,
      pspReference: null,
      riskScore: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)

    const app = testApp()
    const res = await app.request("http://localhost/api/orders/0xref")
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; data: { settlementRef: string } }
    expect(json.success).toBe(true)
    expect(json.data.settlementRef).toBe("0xref")
  })
})
