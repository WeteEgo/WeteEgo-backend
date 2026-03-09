/**
 * On-chain event indexer.
 * Watches WeteEgoRouter for SwapForwarded events using viem's watchContractEvent.
 * Updates order status in DB when a matching settlementRef is found.
 */

import { publicClient } from "../lib/viem.js"
import { prisma } from "../lib/prisma.js"

const ROUTER_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "settlementRef", type: "bytes32" },
      { indexed: false, name: "timestamp", type: "uint256" },
    ],
    name: "SwapForwarded",
    type: "event",
  },
] as const

export function startIndexer(): void {
  const routerAddress = process.env.ROUTER_ADDRESS as `0x${string}` | undefined
  if (!routerAddress || routerAddress === "0x") {
    console.warn("[indexer] ROUTER_ADDRESS not set — skipping event indexer")
    return
  }

  console.log("[indexer] Watching SwapForwarded events on", routerAddress)

  publicClient.watchContractEvent({
    address: routerAddress,
    abi: ROUTER_ABI,
    eventName: "SwapForwarded",
    onLogs: async (logs) => {
      for (const log of logs) {
        const { settlementRef, amount } = log.args
        const txHash = log.transactionHash

        if (!settlementRef) continue

        try {
          await prisma.order.updateMany({
            where: { settlementRef, status: "PENDING" },
            data: {
              status: "FORWARDED",
              txHash,
              amount: amount?.toString() ?? undefined,
            },
          })
          console.log("[indexer] Order forwarded:", settlementRef, txHash)
        } catch (err) {
          console.error("[indexer] Failed to update order:", err)
        }
      }
    },
    onError: (err) => {
      console.error("[indexer] Watch error:", err)
    },
  })
}
