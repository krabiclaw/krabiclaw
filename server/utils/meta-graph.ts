/**
 * The one HTTP boundary to Meta's Graph APIs, shared by the Facebook Page and
 * Instagram adapters. It classifies every failure, because what a caller may do
 * next depends on it:
 *
 * - `rejected`: Meta answered with a Graph error. The request did not take
 *   effect — for a preparation call, nothing was created.
 * - `authorization`: the token or permission is the problem. The connection is
 *   in error; nothing about the content is known from it.
 * - `transport`: no answer, a timeout, or a server error without a Graph body.
 *   The request may or may not have taken effect.
 * - `invalid-response`: Meta answered successfully, but the response is missing
 *   required data or has an invalid shape.
 *
 * No request here is retried. A caller that needs to know what happened after a
 * `transport` failure reads the object it addressed.
 */

export type MetaGraphFailure = 'rejected' | 'authorization' | 'transport' | 'invalid-response'

export interface MetaGraphErrorDetails { status: number | null; code: number | null; subcode: number | null; fbtraceId: string | null }

export class MetaGraphError extends Error {
  readonly failure: MetaGraphFailure
  readonly details: MetaGraphErrorDetails
  constructor(failure: MetaGraphFailure, message: string, details: MetaGraphErrorDetails = { status: null, code: null, subcode: null, fbtraceId: null }, options?: { cause?: unknown }) {
    // Meta's code, subcode and trace id are what tell an expired token from a
    // revoked permission, so they travel with the message to logs and callers.
    const identifiers = [
      details.code !== null ? `code ${details.code}${details.subcode !== null ? `/${details.subcode}` : ''}` : null,
      details.fbtraceId ? `fbtrace_id ${details.fbtraceId}` : null,
    ].filter(Boolean)
    super(identifiers.length ? `${message} (Meta ${identifiers.join(', ')})` : message, options)
    this.name = 'MetaGraphError'
    this.failure = failure
    this.details = details
  }

  /** Graph code 100 / subcode 33: the object named does not exist (or is not visible to this token). */
  get objectMissing(): boolean {
    return this.failure === 'rejected' && this.details.code === 100 && this.details.subcode === 33
  }
}

// OAuthException codes and permission codes Meta documents for token and
// access problems.
const AUTHORIZATION_CODES = new Set([102, 190, 10, 200, 294, 368])

function redact(text: string): string {
  return text.replace(/access_token=[^&\s"]+/g, 'access_token=[redacted]')
}

export async function metaGraphRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new MetaGraphError('transport', `Meta could not be reached: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error })
  }
  const text = await response.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  const graphError = body && typeof body === 'object' && 'error' in body ? (body as { error?: Record<string, unknown> }).error : undefined
  if (graphError && typeof graphError === 'object') {
    const code = typeof graphError.code === 'number' ? graphError.code : null
    const subcode = typeof graphError.error_subcode === 'number' ? graphError.error_subcode : null
    const details = { status: response.status, code, subcode, fbtraceId: typeof graphError.fbtrace_id === 'string' ? graphError.fbtrace_id : null }
    const message = redact(typeof graphError.message === 'string' ? graphError.message : `Meta answered ${response.status}`)
    // A Graph error with a transient flag, or a 5xx, did not say what happened.
    if (graphError.is_transient === true || response.status >= 500) throw new MetaGraphError('transport', message, details)
    throw new MetaGraphError(code !== null && AUTHORIZATION_CODES.has(code) ? 'authorization' : 'rejected', message, details)
  }
  if (!response.ok) {
    throw new MetaGraphError(response.status >= 500 ? 'transport' : 'rejected', `Meta answered ${response.status}: ${redact(text.slice(0, 300))}`,
      { status: response.status, code: null, subcode: null, fbtraceId: response.headers.get('x-fb-trace-id') })
  }
  if (body === null || typeof body !== 'object') throw new MetaGraphError('transport', `Meta answered ${response.status} without a JSON body`)
  return body as T
}

export function formBody(fields: Record<string, string | number | boolean | undefined>): RequestInit {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) params.set(key, String(value))
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() }
}

/**
 * Meta signs the payload it posts to the deauthorize and data-deletion
 * callbacks rather than authenticating the request any other way, so verifying
 * the signature is the authorization check for those endpoints.
 *
 * Facebook Login and Instagram Login are separate apps with separate secrets.
 * Which one verified the signature is part of the answer: the same bare user id
 * in two apps is two different people. When more than one configured app
 * verifies it, which person it names is unknowable, and it is refused.
 */
export interface MetaApp { channel: 'facebook' | 'instagram'; appId: string; appSecret: string }

export interface VerifiedMetaRequest {
  channel: 'facebook' | 'instagram'
  providerAppId: string
  providerSubjectId: string
  issuedAt: number | null
}

export async function verifyMetaSignedRequest(signedRequest: string, apps: readonly MetaApp[]): Promise<VerifiedMetaRequest | null> {
  const [encodedSignature, encodedPayload] = signedRequest.split('.')
  if (!encodedSignature || !encodedPayload) return null
  const base64UrlDecode = (value: string): ArrayBuffer => {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
    const buffer = new ArrayBuffer(binary.length)
    const bytes = new Uint8Array(buffer)
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
    return buffer
  }
  let signature: ArrayBuffer
  try { signature = base64UrlDecode(encodedSignature) } catch { return null }
  const payloadBytes = new TextEncoder().encode(encodedPayload)
  const verifying: MetaApp[] = []
  for (const app of apps) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(app.appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    if (await crypto.subtle.verify('HMAC', key, signature, payloadBytes)) verifying.push(app)
  }
  if (verifying.length !== 1) return null
  let payload: { user_id?: unknown; algorithm?: unknown; issued_at?: unknown }
  try { payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) } catch { return null }
  // Meta only signs HMAC-SHA256; anything else is a payload this verification did not cover.
  if (typeof payload.algorithm === 'string' && payload.algorithm.toUpperCase() !== 'HMAC-SHA256') return null
  if (typeof payload.user_id !== 'string' || !payload.user_id) return null
  const app = verifying[0]!
  return { channel: app.channel, providerAppId: app.appId, providerSubjectId: payload.user_id, issuedAt: typeof payload.issued_at === 'number' ? payload.issued_at : null }
}

/** The claim that makes a Better Auth JWT a data-deletion confirmation code and nothing else. */
export const META_DELETION_PURPOSE = 'meta-data-deletion'
/** How long the status URL Meta hands the person keeps answering. */
export const META_DELETION_STATUS_SECONDS = 365 * 24 * 60 * 60

/** The Meta apps this deployment is configured with, by the channel each one signs for. */
export function configuredMetaApps(env: Record<string, unknown>): MetaApp[] {
  const app = (channel: MetaApp['channel'], id: unknown, secret: unknown): MetaApp[] =>
    typeof id === 'string' && id && typeof secret === 'string' && secret ? [{ channel, appId: id, appSecret: secret }] : []
  return [...app('facebook', env.FACEBOOK_APP_ID, env.FACEBOOK_APP_SECRET), ...app('instagram', env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET)]
}
