/**
 * NUBAN validation and bank code lookup (CBN list).
 * NUBAN = 10-digit Nigerian Uniform Bank Account Number.
 */

const NUBAN_LENGTH = 10
const NUBAN_REGEX = /^[0-9]{10}$/

/** CBN bank codes (3-digit NIP) and SWIFT-style codes (frontend). Source: CBN NIP directory. */
export const BANK_CODES: Record<string, string> = {
  "044": "Access Bank",
  "063": "Access Bank (Diamond)",
  "050": "Ecobank Nigeria",
  "084": "Enterprise Bank",
  "070": "Fidelity Bank",
  "011": "First Bank of Nigeria",
  "214": "First City Monument Bank",
  "058": "Guaranty Trust Bank",
  "030": "Heritage Bank",
  "301": "Jaiz Bank",
  "082": "Keystone Bank",
  "526": "Parallex Bank",
  "076": "Polaris Bank",
  "101": "Providus Bank",
  "221": "Stanbic IBTC Bank",
  "068": "Standard Chartered Bank",
  "232": "Sterling Bank",
  "100": "Suntrust Bank",
  "032": "Union Bank of Nigeria",
  "033": "United Bank for Africa",
  "215": "Unity Bank",
  "035": "Wema Bank",
  "057": "Zenith Bank",
  // Frontend dropdown codes (SWIFT-style) — same banks
  ABNGNGLA: "Access Bank",
  FBNINGLA: "First Bank of Nigeria",
  GTBINGLA: "Guaranty Trust Bank",
  STBINGLA: "Stanbic IBTC Bank",
  UNAFNGLA: "United Bank for Africa",
  ZAIBNGLA: "Zenith Bank",
}

/**
 * Validate 10-digit NUBAN format (digits only).
 */
export function isValidNubanFormat(accountNumber: string): boolean {
  const cleaned = String(accountNumber).replace(/\s/g, "")
  return NUBAN_REGEX.test(cleaned)
}

/**
 * Get bank name from CBN bank code.
 */
export function getBankName(bankCode: string): string | null {
  const code = String(bankCode).trim()
  return BANK_CODES[code] ?? null
}

/**
 * Validate NUBAN with optional bank code (format + known bank).
 */
export function validateNuban(accountNumber: string, bankCode?: string): { valid: boolean; error?: string } {
  if (!isValidNubanFormat(accountNumber)) {
    return { valid: false, error: "Account number must be 10 digits" }
  }
  if (bankCode != null && bankCode !== "" && !getBankName(bankCode)) {
    return { valid: false, error: "Unknown bank code" }
  }
  return { valid: true }
}
