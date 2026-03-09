import "dotenv/config"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { startIndexer } from "./services/indexer.js"
import rates from "./routes/rates.js"
import quotes from "./routes/quotes.js"
import orders from "./routes/orders.js"
import webhooks from "./routes/webhooks.js"

const app = new Hono()

app.use("*", logger())
app.use(
  "/api/*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
  })
)

app.get("/health", (c) => c.json({ status: "ok" }))

app.route("/api/rates", rates)
app.route("/api/quotes", quotes)
app.route("/api/orders", orders)
app.route("/api/webhooks", webhooks)

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404))
app.onError((err, c) => {
  console.error("[error]", err)
  return c.json({ success: false, error: "Internal server error" }, 500)
})

const port = Number(process.env.PORT ?? 3001)

startIndexer()

serve({ fetch: app.fetch, port }, () => {
  console.log(`WeteEgo backend running on http://localhost:${port}`)
})
