/**
 * Bank account verification (resolve account name from account number + bank code).
 * Used by the frontend so users can confirm the verified name instead of typing it.
 */

import { Hono } from "hono"
import { verifyBankAccount } from "../services/psp/orchestrator.js"
import { validateNuban } from "../utils/nuban.js"

const bank = new Hono()

/**
 * GET /api/bank/verify-account?bankCode=GTBINGLA&accountNumber=0123456789
 * Returns resolved account name (and bank name) for NGN accounts.
 * Frontend calls this when user has entered 10-digit NUBAN; user then confirms the name to proceed.
 */
bank.get("/verify-account", async (c) => {
  const bankCode = c.req.query("bankCode")?.trim() ?? ""
  const accountNumber = (c.req.query("accountNumber") ?? "").replace(/\D/g, "")

  const nubanCheck = validateNuban(accountNumber, bankCode)
  if (!nubanCheck.valid) {
    return c.json({ success: false, error: nubanCheck.error }, 400)
  }

  const verification = await verifyBankAccount(bankCode, accountNumber)

  if (!verification.valid) {
    return c.json(
      { success: false, error: verification.error ?? "Could not verify account" },
      400
    )
  }

  const accountName = verification.accountName ?? null
  const bankName = verification.bankName ?? null
  if (!accountName) {
    console.warn("[bank] verify-account: no accountName in response", { bankCode, accountNumber })
  }

  return c.json({
    success: true,
    data: {
      accountName,
      bankName,
      bankCode: verification.bankCode ?? bankCode,
    },
  })
})

export default bank
