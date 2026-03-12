/**
 * On-chain event indexer.
 * Polls for OrderCreated (WeteEgoGateway) or SwapForwarded (WeteEgoRouter) via getLogs.
 * Uses polling instead of watchContractEvent so it works with public RPCs that don't persist filters.
 */

import { parseAbiItem } from "viem"
import { publicClient } from "../lib/viem.js"
import { prisma } from "../lib/prisma.js"

const POLL_INTERVAL_MS = 12_000
const MAX_RANGE_BLOCKS = 10n

async function markOrderForwarded(settlementRef: `0x${string}`, txHash: `0x${string}`, amount?: string) {
  await prisma.order.updateMany({
    where: { settlementRef, status: "PENDING" },
    data: {
      status: "FORWARDED",
      txHash,
      ...(amount !== undefined && { amount }),
    },
  })
}

function parseSettlementRefFromLog(topics: readonly `0x${string}`[], data: `0x${string}`): `0x${string}` | null {
  if (data.length >= 66) return data.slice(0, 66) as `0x${string}`
  return null
}

export function startIndexer(): void {
  const gatewayAddress = process.env.GATEWAY_ADDRESS as `0x${string}` | undefined
  const routerAddress = process.env.ROUTER_ADDRESS as `0x${string}` | undefined

  const hasGateway = gatewayAddress && gatewayAddress !== "0x"
  const hasRouter = routerAddress && routerAddress !== "0x"

  if (!hasGateway && !hasRouter) {
    console.warn("[indexer] GATEWAY_ADDRESS and ROUTER_ADDRESS not set — skipping event indexer")
    return
  }

  let lastBlock = 0n

  const poll = async () => {
    try {
      const block = await publicClient.getBlockNumber()

      // Respect Alchemy free-tier limit: max 10-block eth_getLogs range
      const safeFrom = block > MAX_RANGE_BLOCKS ? block - MAX_RANGE_BLOCKS + 1n : 0n
      const fromBlock = lastBlock === 0n ? safeFrom : lastBlock + 1n
      const toBlock = block
      if (fromBlock > toBlock) {
        setTimeout(poll, POLL_INTERVAL_MS)
        return
      }

      if (hasGateway) {
        const gatewayLogs = await publicClient.getLogs({
          address: gatewayAddress!,
          event: parseAbiItem("event OrderCreated(bytes32 indexed orderId, address indexed sender, address token, uint256 amount, bytes32 settlementRef, uint256 expiresAt)"),
          fromBlock,
          toBlock,
        })
        for (const log of gatewayLogs) {
          const settlementRef = log.args.settlementRef ?? parseSettlementRefFromLog(log.topics, log.data)
          if (!settlementRef) continue
          try {
            await markOrderForwarded(settlementRef, log.transactionHash ?? "0x", log.args.amount?.toString())
            console.log("[indexer] Order forwarded (gateway):", settlementRef, log.transactionHash)
          } catch (err) {
            console.error("[indexer] Failed to update order:", err)
          }
        }
      }

      if (hasRouter) {
        const routerLogs = await publicClient.getLogs({
          address: routerAddress!,
          event: parseAbiItem("event SwapForwarded(address indexed sender, address indexed token, uint256 amount, bytes32 settlementRef, uint256 timestamp)"),
          fromBlock,
          toBlock,
        })
        for (const log of routerLogs) {
          const settlementRef = log.args.settlementRef ?? (log.data.length >= 66 ? (log.data.slice(0, 66) as `0x${string}`) : null)
          if (!settlementRef) continue
          try {
            await markOrderForwarded(settlementRef, log.transactionHash ?? "0x", log.args.amount?.toString())
            console.log("[indexer] Order forwarded (router):", settlementRef, log.transactionHash)
          } catch (err) {
            console.error("[indexer] Failed to update order:", err)
          }
        }
      }

      lastBlock = toBlock
    } catch (err) {
      console.error("[indexer] Poll error:", err)
    }
    setTimeout(poll, POLL_INTERVAL_MS)
  }

  if (hasGateway) console.log("[indexer] Polling OrderCreated on gateway", gatewayAddress)
  if (hasRouter) console.log("[indexer] Polling SwapForwarded on router", routerAddress)
  poll()
}
