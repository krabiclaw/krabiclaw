// Preview authorization: one signed token, one cookie, one meaning.
//
// A preview token says "the holder may see this site before it is public".
// It is minted for a site id, handed to the browser once in a URL, and then
// lives in an HttpOnly cookie on the tenant host, so every subsequent request
// the preview makes — page navigations and the public shell/page APIs the site
// calls for itself — is authorized without the token being threaded through
// props, routes or query strings.
//
// The cookie is Partitioned (CHIPS) because the dashboard frames the tenant
// host in an iframe: a third-party cookie without it is dropped by the browser.

import { timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'nitro/h3'
import { deleteCookie, getCookie, getQuery, setCookie } from 'nitro/h3'

const textEncoder = new TextEncoder()

/** Set on the tenant host, so the host itself names the site. */
export const PREVIEW_COOKIE_NAME = 'kc_preview'
/** The query parameter that mints the cookie. */
export const PREVIEW_TOKEN_QUERY = 'preview_token'
export const PREVIEW_TOKEN_TTL_MS = 12 * 60 * 60 * 1000
export const PUBLIC_WEBSITE_QUERY = '?view=public'

const previewCookie = { httpOnly: true, secure: true, sameSite: 'none', partitioned: true, path: '/' } as const

export function clearPreviewAuthorization(event: H3Event) {
  deleteCookie(event, PREVIEW_COOKIE_NAME, previewCookie)
}

const base64UrlEncode = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

async function signPreviewPayload(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payload))
  return base64UrlEncode(signature)
}

export async function createPreviewToken(secret: string, organizationId: string, expiresAt: number) {
  const signature = await signPreviewPayload(secret, `organization:${organizationId}.${expiresAt}`)
  return `${expiresAt}.${signature}`
}

export async function verifyPreviewToken(secret: string, organizationId: string, token: string) {
  const [expiresAtRaw, signature] = token.split('.')
  const expiresAt = Number(expiresAtRaw)

  if (!Number.isFinite(expiresAt) || !signature) return false
  if (Date.now() > expiresAt) return false

  const expected = await createPreviewToken(secret, organizationId, expiresAt)

  const tokenBuf = textEncoder.encode(token)
  const expectedBuf = textEncoder.encode(expected)

  // Always compare equal-length buffers to avoid timing leaks
  if (tokenBuf.length !== expectedBuf.length) {
    // Perform a dummy comparison to prevent early exit timing differences
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }

  return timingSafeEqual(tokenBuf, expectedBuf)
}

/**
 * Is this request authorized to preview `organizationId`?
 *
 * Accepts the token from `?preview_token=` and, when it is valid, promotes it
 * to the cookie so the rest of the visit — every link the site renders, every
 * API call it makes — stays authorized without the token in the URL. Reads the
 * cookie on every later request.
 */
export async function resolvePreviewAuthorization(
  event: H3Event,
  organizationId: string,
  previewSecret: string | null,
): Promise<boolean> {
  if (!previewSecret) return false

  const queryToken = getQuery(event)[PREVIEW_TOKEN_QUERY]
  const token = typeof queryToken === 'string' && queryToken ? queryToken : null
  if (token) {
    if (!await verifyPreviewToken(previewSecret, organizationId, token)) return false
    setCookie(event, PREVIEW_COOKIE_NAME, token, {
      ...previewCookie,
      maxAge: Math.floor(PREVIEW_TOKEN_TTL_MS / 1000),
    })
    return true
  }

  const cookieToken = getCookie(event, PREVIEW_COOKIE_NAME)
  if (!cookieToken) return false
  return await verifyPreviewToken(previewSecret, organizationId, cookieToken)
}

/**
 * The signing key, exactly as configured. Never trimmed: createPreviewToken is
 * also called with env.PREVIEW_SECRET directly, and a trimmed copy here would
 * verify against a different HMAC key than the one that signed.
 */
export function previewSecretOf(env: object): string | null {
  const secret = (env as { PREVIEW_SECRET?: unknown }).PREVIEW_SECRET
  return typeof secret === 'string' && secret.trim() ? secret : null
}
