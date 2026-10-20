/** How long a guest's emailed link to their booking or stay opens it. */
export const TOKEN_TTL_DAYS = 30

export async function hashReservationCancelToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createReservationCancelToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  return { token, expiresAt }
}

export function readBearerToken(authHeader: string | undefined | null): string {
  const [scheme, token] = String(authHeader || '').split(/\s+/, 2)
  return scheme?.toLowerCase() === 'bearer' ? token || '' : ''
}

/** Recover the same guest capability after an idempotent operator creation retry.
 * Only the hash is persisted, just as for public cancellations.
 */
export async function createReplayableReservationCancelToken(secret: string, requestId: string) {
  if (!secret || !requestId) throw new Error('Cancellation signing secret and request ID are required')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`booking-cancel:v1:${requestId}`)))
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return { token, expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString() }
}
