import "dotenv/config"

const required = ["DATABASE_URL", "ROUTER_ADDRESS", "PAYCREST_WEBHOOK_SECRET"]
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`)
  }
}
if (process.env.NODE_ENV === "production" && process.env.CORS_ORIGIN === "*") {
  throw new Error("CORS_ORIGIN must not be * in production")
}

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { getMetrics } from "./lib/metrics.js"
import { getRedis } from "./lib/redis.js"
import { prisma } from "./lib/prisma.js"
import { startIndexer } from "./services/indexer.js"
import { startExpireOrdersJob } from "./jobs/expireOrders.js"
import { rateLimitRates, rateLimitOrders } from "./middleware/rateLimit.js"
import rates from "./routes/rates.js"
import quotes from "./routes/quotes.js"
import orders from "./routes/orders.js"
import webhooks from "./routes/webhooks.js"
import admin from "./routes/admin.js"

const app = new Hono()

app.use("*", logger())
app.use(
  "/api/*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
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

app.get("/metrics", async (c) => {
  const metrics = await getMetrics()
  return c.text(metrics, 200, {
    "Content-Type": "text/plain; charset=utf-8",
  })
})

app.use("/api/rates/*", rateLimitRates)
app.use("/api/quotes/*", rateLimitRates)
app.use("/api/orders", rateLimitOrders)
app.route("/api/rates", rates)
app.route("/api/quotes", quotes)
app.route("/api/orders", orders)
app.route("/api/webhooks", webhooks)
app.route("/admin", admin)

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404))
app.onError((err, c) => {
  console.error("[error]", err)
  return c.json({ success: false, error: "Internal server error" }, 500)
})

const port = Number(process.env.PORT ?? 3001)

startIndexer()
startExpireOrdersJob()

serve({ fetch: app.fetch, port }, () => {
  console.log(`WeteEgo backend running on http://localhost:${port}`)
})
