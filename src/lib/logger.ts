/**
 * Structured logger using pino.
 * Outputs JSON with timestamp, level, service, and context fields.
 * Use this everywhere instead of console.log/error.
 */

import pino from "pino"

const isDev = process.env.NODE_ENV !== "production"

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
  base: { service: "weteego-backend" },
  redact: {
    paths: ["req.headers.authorization", "req.headers['x-api-key']", "*.apiKey", "*.password"],
    censor: "[REDACTED]",
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
})

/**
 * Create a child logger with bound context fields.
 * Use per-request or per-order for correlation.
 *
 * @example
 * const log = childLogger({ settlementRef: order.settlementRef, walletAddress })
 * log.info("order created")
 */
export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings)
}

export type Logger = typeof logger
