/**
 * PSP (Payment Service Provider) adapter interface.
 * PSP adapter interface. Currently Paycrest-only.
 */

export interface BankAccountInfo {
  accountNumber: string
  bankCode: string
  accountName: string
  currency: string
}

export interface PayoutRequest {
  orderId: string
  settlementRef: string
  amountNgn: number // NGN amount (fiat)
  amountUsdcUnits: string // USDC in smallest units (wei-like)
  recipient: BankAccountInfo
  idempotencyKey: string
}

export type PayoutStatus = "pending" | "processing" | "success" | "failed"

export interface PayoutResult {
  success: boolean
  pspReference?: string
  status: PayoutStatus
  failureReason?: string
  estimatedSettlementMs?: number
}

export interface AccountVerification {
  valid: boolean
  accountName?: string
  bankName?: string
  bankCode?: string
  error?: string
}

export type WebhookEventType = "payout.success" | "payout.failed" | "transfer.completed" | "transfer.failed"

export interface WebhookEvent {
  type: WebhookEventType
  pspReference: string
  orderId?: string
  settlementRef?: string
  status: "success" | "failed"
  failureReason?: string
  rawPayload?: unknown
}

export interface PSPAdapter {
  readonly name: string

  createPayout(order: PayoutRequest): Promise<PayoutResult>

  verifyAccount(bankCode: string, accountNumber: string): Promise<AccountVerification>

  getPayoutStatus(reference: string): Promise<{ status: PayoutStatus; failureReason?: string }>

  handleWebhook(payload: unknown, signature: string): Promise<WebhookEvent>

  healthCheck(): Promise<boolean>
}
