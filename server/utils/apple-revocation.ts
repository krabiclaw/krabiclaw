import { APIError } from 'better-auth'

import type { CloudflareEnv } from '~/server/utils/auth'

// Apple requires an app that offers Sign in with Apple to revoke the user's
// Apple grant when they delete their account (App Review 5.1.1(v)). Krabiclaw
// keeps no Apple tokens: the native app asks Apple to authorize again at
// deletion, sends the fresh authorization code, and Krabiclaw exchanges it for
// a refresh token and revokes that. Better Auth's Apple provider implements
// neither the native code exchange nor revocation, so these two calls are made
// here against Apple's documented endpoints.

const APPLE = 'https://appleid.apple.com'
export const APPLE_AUTHORIZATION_CODE_HEADER = 'x-apple-authorization-code'

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)
  return btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The ES256 client secret Apple's token and revoke endpoints authenticate with. */
async function appleClientSecret(env: CloudflareEnv): Promise<string> {
  const teamId = env.APPLE_TEAM_ID?.trim()
  const keyId = env.APPLE_KEY_ID?.trim()
  const privateKey = env.APPLE_PRIVATE_KEY?.trim()
  if (!teamId || !keyId || !privateKey) {
    throw new APIError('INTERNAL_SERVER_ERROR', { code: 'APPLE_NOT_CONFIGURED', message: 'APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY are required to delete an account signed in with Apple.' })
  }
  const pem = privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), char => char.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const now = Math.floor(Date.now() / 1000)
  const signingInput = `${base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${base64url(JSON.stringify({ iss: teamId, iat: now, exp: now + 300, aud: APPLE, sub: env.APPLE_APP_BUNDLE_ID }))}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(signature)}`
}

/**
 * Exchanges the native app's fresh authorization code and checks it belongs to
 * the Apple account linked to this user. Returns the refresh token to revoke.
 */
export async function exchangeAppleAuthorizationCode(env: CloudflareEnv, code: string, appleAccountId: string): Promise<{ refreshToken: string; clientSecret: string }> {
  const clientSecret = await appleClientSecret(env)
  const response = await fetch(`${APPLE}/auth/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.APPLE_APP_BUNDLE_ID, client_secret: clientSecret, code, grant_type: 'authorization_code' }),
  })
  const tokens = await response.json() as { refresh_token?: string; id_token?: string; error?: string }
  if (!response.ok || !tokens.refresh_token || !tokens.id_token) {
    throw new APIError('BAD_REQUEST', { code: 'APPLE_CODE_EXCHANGE_FAILED', message: `Apple did not accept the authorization code (${response.status}${tokens.error ? `: ${tokens.error}` : ''}). Sign in with Apple again and retry.` })
  }
  // Apple returned this token directly over TLS to Krabiclaw's authenticated
  // request, so its claims are read, not re-verified.
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(tokens.id_token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0)))) as { sub?: string }
  if (claims.sub !== appleAccountId) {
    throw new APIError('FORBIDDEN', { code: 'APPLE_ACCOUNT_MISMATCH', message: 'That Apple ID is not the one linked to this account.' })
  }
  return { refreshToken: tokens.refresh_token, clientSecret }
}

export async function revokeAppleGrant(env: CloudflareEnv, grant: { refreshToken: string; clientSecret: string }): Promise<void> {
  const response = await fetch(`${APPLE}/auth/revoke`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.APPLE_APP_BUNDLE_ID, client_secret: grant.clientSecret, token: grant.refreshToken, token_type_hint: 'refresh_token' }),
  })
  if (!response.ok) {
    throw new APIError('BAD_GATEWAY', { code: 'APPLE_REVOCATION_FAILED', message: `Apple did not revoke the Sign in with Apple grant (${response.status}): ${(await response.text()).slice(0, 300)}` })
  }
}
