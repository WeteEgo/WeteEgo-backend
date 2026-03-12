import { Hono } from "hono"
import { prisma } from "../lib/prisma.js"

const admin = new Hono()

const ADMIN_KEY = process.env.ADMIN_KEY ?? ""

function requireAdmin(c: { req: { header: (k: string) => string | undefined } }) {
  const key = c.req.header("x-admin-key")
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return false
  }
  return true
}

/**
 * GET /admin/orders — paginated order list with status filter
 */
admin.get("/orders", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const status = c.req.query("status")
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100)
  const cursor = c.req.query("cursor")

  const where = status ? { status: status as "PENDING" | "FORWARDED" | "ESCROWED" | "SETTLED" | "FAILED" | "EXPIRED" | "REFUNDED" } : {}
  const orders = await prisma.order.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
  })

  const nextCursor = orders.length > limit ? orders[limit - 1]?.id : null
  const data = orders.slice(0, limit)

  return c.json({ success: true, data, nextCursor })
})

/**
 * GET /admin/orders/:ref — full order detail
 */
admin.get("/orders/:ref", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const ref = c.req.param("ref")
  const order = await prisma.order.findUnique({
    where: { settlementRef: ref },
  })
  if (!order) {
    return c.json({ success: false, error: "Order not found" }, 404)
  }
  return c.json({ success: true, data: order })
})

/**
 * POST /admin/orders/:ref/refund — manual refund trigger (stub; actual refund is on-chain)
 */
admin.post("/orders/:ref/refund", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const ref = c.req.param("ref")
  const order = await prisma.order.findUnique({
    where: { settlementRef: ref },
  })
  if (!order) {
    return c.json({ success: false, error: "Order not found" }, 404)
  }
  return c.json({
    success: true,
    message: "Refund must be triggered on-chain (Gateway.refundOrder). Order ref: " + ref,
  })
})

/**
 * GET /admin/stats — order counts by status, provider, last 24h volume
 */
admin.get("/stats", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [byStatus, byProvider, volume24h] = await Promise.all([
    prisma.order.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
    prisma.order.groupBy({
      by: ["provider"],
      _count: { id: true },
    }),
    prisma.order.aggregate({
      where: { createdAt: { gte: since }, status: "SETTLED" },
      _sum: { fiatAmount: true },
    }),
  ])

  const statusCounts = Object.fromEntries(
    byStatus.map((s: { status: string; _count: { id: number } }) => [s.status, s._count.id])
  )
  const providerCounts = Object.fromEntries(
    byProvider.map((p: { provider: string | null; _count: { id: number } }) => [
      p.provider ?? "unknown",
      p._count.id,
    ])
  )

  return c.json({
    success: true,
    data: {
      byStatus: statusCounts,
      byProvider: providerCounts,
      volume24h: volume24h._sum.fiatAmount ?? 0,
    },
  })
})

/**
 * GET /admin/aml/alerts — paginated AML alerts with filters
 */
admin.get("/aml/alerts", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const status = c.req.query("status")
  const severity = c.req.query("severity")
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100)
  const cursor = c.req.query("cursor")

  const where: { status?: string; severity?: string } = {}
  if (status) where.status = status
  if (severity) where.severity = severity

  const alerts = await prisma.aMLAlert.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
  })

  const nextCursor = alerts.length > limit ? alerts[alerts.length - 1]?.id : null
  return c.json({ success: true, data: alerts.slice(0, limit), nextCursor })
})

/**
 * PATCH /admin/aml/alerts/:id — review or dismiss alert
 */
admin.patch("/aml/alerts/:id", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const id = c.req.param("id")
  const body = (await c.req.json().catch(() => ({}))) as { status?: string; notes?: string }
  const adminKey = c.req.header("x-admin-key") ?? "admin"

  const alert = await prisma.aMLAlert.update({
    where: { id },
    data: {
      status: body.status ?? "reviewed",
      reviewedBy: adminKey,
      notes: body.notes ?? undefined,
    },
  })
  return c.json({ success: true, data: alert })
})

/**
 * GET /admin/audit-log — searchable audit trail with optional export (CSV via ?format=csv)
 */
admin.get("/audit-log", async (c) => {
  if (!requireAdmin(c)) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const entityType = c.req.query("entityType")
  const entityId = c.req.query("entityId")
  const limit = Math.min(Number(c.req.query("limit")) || 50, 500)
  const cursor = c.req.query("cursor")
  const format = c.req.query("format")

  const where: { entityType?: string; entityId?: string } = {}
  if (entityType) where.entityType = entityType
  if (entityId) where.entityId = entityId

  const logs = await prisma.auditLog.findMany({
    where,
    take: format === "csv" ? 10000 : limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
  })

  if (format === "csv") {
    const header = "id,entityType,entityId,action,actor,previousState,newState,createdAt\n"
    const rows = logs
      .map(
        (l) =>
          `${l.id},${l.entityType},${l.entityId},${l.action},${l.actor ?? ""},${(l.previousState ?? "").replace(/,/g, ";")},${(l.newState ?? "").replace(/,/g, ";")},${l.createdAt.toISOString()}`
      )
      .join("\n")
    c.header("Content-Type", "text/csv")
    c.header("Content-Disposition", "attachment; filename=audit-log.csv")
    return c.text(header + rows, 200)
  }

  const nextCursor = logs.length > limit ? logs[limit - 1]?.id : null
  return c.json({ success: true, data: logs.slice(0, limit), nextCursor })
})

export default admin
