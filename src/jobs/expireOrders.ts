import { prisma } from "../lib/prisma.js"

const INTERVAL_MS = 60_000

export function startExpireOrdersJob() {
  const run = async () => {
    const now = new Date()
    const result = await prisma.order.updateMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: now },
      },
      data: { status: "EXPIRED" },
    })
    if (result.count > 0) {
      console.log(`[expireOrders] Marked ${result.count} orders as EXPIRED`)
    }
  }
  run().catch((e) => console.error("[expireOrders]", e))
  setInterval(run, INTERVAL_MS)
}
