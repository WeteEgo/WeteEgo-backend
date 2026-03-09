import { createPublicClient, http } from "viem"
import { base, baseSepolia } from "viem/chains"

const chainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : baseSepolia.id
const rpcUrl = process.env.RPC_URL ?? "https://sepolia.base.org"

export const activeChain = chainId === base.id ? base : baseSepolia

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: http(rpcUrl),
})
