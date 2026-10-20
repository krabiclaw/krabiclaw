const RECEIPT_TTL_MS = 30 * 86400000

async function receiptKey(secret: string, activityId: string) {
  if (!secret || !activityId) throw new Error('Receipt signing secret and activity ID are required')
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** Anchor expiry to the persisted stay creation time so retries recover the same link. */
export async function createStayReceiptToken(secret: string, activityId: string, createdAt: string) {
  const expiresAt = Date.parse(createdAt) + RECEIPT_TTL_MS
  if (!Number.isFinite(expiresAt)) throw new Error('Receipt needs a valid stay creation time')
  const key = await receiptKey(secret, activityId)
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`stay-receipt:v1:${activityId}:${expiresAt}`)))
  const signature = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return { token: `${expiresAt}.${signature}`, expiresAt: new Date(expiresAt).toISOString() }
}

export async function verifyStayReceiptToken(secret: string, activityId: string, token: string): Promise<boolean> {
  const parts = /^([1-9]\d*)\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!parts) return false
  const expiresAt = Number(parts[1])
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt) return false
  const signature = Uint8Array.from(atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/') + '='), char => char.charCodeAt(0))
  const key = await receiptKey(secret, activityId)
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`stay-receipt:v1:${activityId}:${expiresAt}`))
}
