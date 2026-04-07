import "dotenv/config"

const required = ["DATABASE_URL", "PAYCREST_WEBHOOK_SECRET"]
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`)
  }
}

// CORS hardening: require explicit origin in production; never allow wildcard
if (process.env.NODE_ENV === "production") {
  if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "*") {
    throw new Error("CORS_ORIGIN must be explicitly set (not *) in production")
  }
}

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger as honoLogger } from "hono/logger"
import { logger } from "./lib/logger.js"
import { getMetrics } from "./lib/metrics.js"
import { getRedis } from "./lib/redis.js"
import { prisma } from "./lib/prisma.js"
import { checkPaycrestHealth } from "./services/paycrest.js"
import { startExpireOrdersJob } from "./jobs/expireOrders.js"
import { startReconciliationWorker } from "./workers/reconciliation.js"
import { rateLimitRates, rateLimitOrders, rateLimitBankVerify } from "./middleware/rateLimit.js"
import { idempotencyMiddleware } from "./middleware/idempotency.js"
import rates from "./routes/rates.js"
import quotes from "./routes/quotes.js"
import orders from "./routes/orders.js"
import bank from "./routes/bank.js"
import webhooks from "./routes/webhooks.js"
import admin from "./routes/admin.js"
import kyc from "./routes/kyc.js"

type AppVariables = { idempotencyKey?: string }
const app = new Hono<{ Variables: AppVariables }>()

app.use("*", honoLogger())

// CORS: explicit allowed origins, never wildcard in production
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
  : ["*"]

app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (allowedOrigins.includes("*")) return origin ?? "*"
      return allowedOrigins.includes(origin ?? "") ? origin! : allowedOrigins[0]
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-API-Key"],
  })
)

app.get("/health", async (c) => {
  const [dbStatus, cacheStatus] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => "ok" as const).catch(() => "fail" as const),
    getRedis().ping().then(() => "ok" as const).catch(() => "fail" as const),
  ])
  const healthy = dbStatus === "ok" && cacheStatus === "ok"
  return c.json({ db: dbStatus, cache: cacheStatus }, healthy ? 200 : 503)
})

app.get("/api/health/paycrest", async (c) => {
  const result = await checkPaycrestHealth()
  return c.json(result, result.ok ? 200 : 503)
})

app.get("/metrics", async (c) => {
  const metrics = await getMetrics()
  return c.text(metrics, 200, {
    "Content-Type": "text/plain; charset=utf-8",
  })
})

app.use("/api/rates/*", rateLimitRates)
app.use("/api/quotes/*", rateLimitRates)
app.use("/api/orders", idempotencyMiddleware, rateLimitOrders)
app.use("/api/bank/*", rateLimitBankVerify)
app.route("/api/rates", rates)
app.route("/api/quotes", quotes)
app.route("/api/orders", orders)
app.route("/api/bank", bank)
app.route("/api/kyc", kyc)
app.route("/api/webhooks", webhooks)
app.route("/admin", admin)

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404))
app.onError((err, c) => {
  logger.error({ err, path: c.req.path, method: c.req.method }, "Unhandled error")
  return c.json({ success: false, error: "Internal server error" }, 500)
})

const port = Number(process.env.PORT ?? 3001)

// Event indexing and Paycrest payout after escrow are handled by the Go order service
// (internal/chain/listener.go + statemachine). startIndexer() disabled to avoid duplicate DB updates.
startExpireOrdersJob()
startReconciliationWorker()

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, env: process.env.NODE_ENV }, "WeteEgo backend started")
})
