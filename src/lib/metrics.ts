import { Counter, Gauge, Histogram, register } from "prom-client"

export const orderCounter = new Counter({
  name: "weteego_order_total",
  help: "Total orders by status and provider",
  labelNames: ["status", "psp"],
})

export const orderLatency = new Histogram({
  name: "weteego_order_duration_seconds",
  help: "Order lifecycle duration",
  buckets: [0.1, 0.5, 1, 5, 30, 60, 90],
})

export const settlementDuration = new Histogram({
  name: "weteego_settlement_duration_seconds",
  help: "Time from order creation to settled",
  labelNames: ["psp"],
  buckets: [1, 5, 15, 30, 60, 90, 120],
})

export const pspHealthGauge = new Gauge({
  name: "weteego_psp_health",
  help: "PSP health: 1=ok, 0=unhealthy or circuit open",
  labelNames: ["provider"],
})

export const pspCircuitStateGauge = new Gauge({
  name: "weteego_psp_circuit_state",
  help: "PSP circuit breaker state: 0=CLOSED, 1=OPEN, 2=HALF_OPEN",
  labelNames: ["provider"],
})

export const pspCallDuration = new Histogram({
  name: "weteego_psp_call_duration_seconds",
  help: "PSP API call duration by provider and endpoint",
  labelNames: ["provider", "endpoint"],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
})

export const amlAlertsCounter = new Counter({
  name: "weteego_aml_alerts_total",
  help: "AML alerts created by rule and severity",
  labelNames: ["rule", "severity"],
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

export const webhookDuplicateCounter = new Counter({
  name: "weteego_webhook_duplicate_total",
  help: "Duplicate webhook events rejected by idempotency check",
  labelNames: ["provider"],
})

export const kycVerificationCounter = new Counter({
  name: "weteego_kyc_verification_total",
  help: "KYC verification attempts by provider and result",
  labelNames: ["provider", "result"],
})

export const reconciliationMismatchCounter = new Counter({
  name: "weteego_reconciliation_mismatch_total",
  help: "Reconciliation mismatches between PSP and DB",
})

export const orderRiskScoreHistogram = new Histogram({
  name: "weteego_order_risk_score",
  help: "Distribution of AML risk scores on created orders",
  buckets: [0, 10, 20, 30, 50, 70, 100],
})

export async function getMetrics(): Promise<string> {
  return register.metrics()
}
