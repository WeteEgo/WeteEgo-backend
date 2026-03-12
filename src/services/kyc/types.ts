/**
 * KYC provider interface. Implementations: Smile ID, Dojah.
 */

export type KYCStatus = "pending" | "approved" | "rejected" | "manual_review"

export interface KYCRequest {
  walletAddress: string
  email?: string
  phone?: string
  userId: string
}

export interface KYCSession {
  sessionId: string
  redirectUrl?: string
  clientId?: string
  expiresAt?: Date
}

export interface KYCResult {
  sessionId: string
  status: KYCStatus
  provider: string
  metadata?: Record<string, unknown>
}

export interface KYCProvider {
  readonly name: string

  initiateVerification(user: KYCRequest): Promise<KYCSession>

  handleCallback(payload: unknown): Promise<KYCResult>

  getVerificationStatus(sessionId: string): Promise<{ status: KYCStatus; metadata?: Record<string, unknown> }>
}
