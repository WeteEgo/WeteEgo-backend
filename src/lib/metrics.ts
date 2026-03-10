import { Counter, Histogram, register } from "prom-client"

export const orderCounter = new Counter({
  name: "weteego_orders_total",
  help: "Total orders by status and provider",
  labelNames: ["status", "provider"],
})

export const orderLatency = new Histogram({
  name: "weteego_order_duration_seconds",
  help: "Order lifecycle duration",
  buckets: [0.1, 0.5, 1, 5, 30, 60, 90],
})

export const rateCallCounter = new Counter({
  name: "weteego_rate_calls_total",
  help: "Rate API calls by source and status",
  labelNames: ["source", "status"],
})

export const webhookCounter = new Counter({
  name: "weteego_webhooks_total",
  help: "Webhook calls by event and status",
  labelNames: ["event", "status"],
})

export async function getMetrics(): Promise<string> {
  return register.metrics()
}
