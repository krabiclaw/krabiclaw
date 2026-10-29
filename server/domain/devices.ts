import { HTTPError, type H3Event } from 'nitro'
import { execute, queryAll, type DbClient } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'

/**
 * Devices belong to the actual Better Auth session, independently of its
 * organizations. The app presents its bearer session; the dashboard its cookie.
 */
export async function requireDeviceSession(event: H3Event) {
  const env = cloudflareEnv(event)
  if (!env.DB) {
    throw new HTTPError({ statusCode: 503, message: 'Database is not available', data: { code: 'DATABASE_UNAVAILABLE', field: 'DB' } })
  }
  const session = await createAuth(env).api.getSession({
    headers: event.req.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  })
  if (!session) {
    throw new HTTPError({ statusCode: 401, message: 'A current session is required to register a device', data: { code: 'UNAUTHORIZED', field: 'session' } })
  }
  return { db: env.DB, userId: session.user.id, sessionId: session.session.id }
}

export function deviceToken(value: unknown): string {
  // Apple device tokens have variable byte lengths; validate hexadecimal bytes rather than one fixed size.
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new HTTPError({ statusCode: 422, message: 'deviceToken must contain hexadecimal bytes', data: { code: 'INVALID_DEVICE_TOKEN', field: 'deviceToken' } })
  }
  return value.toLowerCase()
}

export function deviceEnvironment(value: unknown): 'sandbox' | 'production' {
  if (value !== 'sandbox' && value !== 'production') {
    throw new HTTPError({ statusCode: 422, message: 'environment must be sandbox or production', data: { code: 'INVALID_DEVICE_ENVIRONMENT', field: 'environment' } })
  }
  return value
}

/**
 * The push services browsers subscribe through: Chrome, Edge, Firefox and Safari
 * (FCM, WNS, Mozilla autopush, Apple). The server POSTs to a registered
 * endpoint, so anything else is refused rather than becoming a destination.
 */
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'notify.windows.com', 'push.services.mozilla.com', 'push.apple.com']

export function subscriptionEndpoint(value: unknown): string {
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : null
  if (!url || url.protocol !== 'https:' || !PUSH_SERVICE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new HTTPError({ statusCode: 422, message: 'endpoint must be a browser push service\'s https URL', data: { code: 'INVALID_PUSH_ENDPOINT', field: 'endpoint' } })
  }
  return url.href
}

function subscriptionKey(value: unknown, field: 'p256dh' | 'auth'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new HTTPError({ statusCode: 422, message: `${field} must be the subscription's base64url key`, data: { code: 'INVALID_PUSH_KEY', field } })
  }
  return value
}

export type DeviceRegistration =
  | { kind: 'apns'; deviceToken: unknown; environment: unknown }
  | { kind: 'web'; endpoint: unknown; p256dh: unknown; auth: unknown }

export async function registerDevice(
  db: DbClient,
  input: DeviceRegistration & { userId: string; sessionId: string },
): Promise<void> {
  const row = input.kind === 'apns'
    ? { token: deviceToken(input.deviceToken), environment: deviceEnvironment(input.environment), p256dh: null, auth: null }
    : { token: subscriptionEndpoint(input.endpoint), environment: null, p256dh: subscriptionKey(input.p256dh, 'p256dh'), auth: subscriptionKey(input.auth, 'auth') }
  // The Better Auth read authorizes the request. This same-statement guard
  // prevents a revoked or expired session from winning a later device write.
  const result = await execute(db, `
    INSERT INTO device_tokens (token, kind, user_id, session_id, environment, p256dh, auth)
    SELECT ?, ?, userId, id, ?, ?, ? FROM session
    WHERE id = ? AND userId = ? AND expiresAt > unixepoch()
    ON CONFLICT (token) DO UPDATE SET
      kind = excluded.kind,
      user_id = excluded.user_id,
      session_id = excluded.session_id,
      environment = excluded.environment,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `, [row.token, input.kind, row.environment, row.p256dh, row.auth, input.sessionId, input.userId])
  if (result.meta.changes !== 1) {
    throw new HTTPError({ statusCode: 401, message: 'A current session is required to register a device', data: { code: 'UNAUTHORIZED', field: 'session' } })
  }
}

export async function unregisterDevice(
  db: DbClient,
  input: { kind: 'apns'; deviceToken: unknown } | { kind: 'web'; endpoint: unknown },
  owner: { userId: string; sessionId: string },
): Promise<void> {
  const token = input.kind === 'apns' ? deviceToken(input.deviceToken) : subscriptionEndpoint(input.endpoint)
  // An older signed-in session cannot unregister a token since reassigned to a new session.
  await execute(db, 'DELETE FROM device_tokens WHERE token = ? AND kind = ? AND user_id = ? AND session_id = ?', [token, input.kind, owner.userId, owner.sessionId])
}

export type UserDevice = { sessionId: string } & (
  | { kind: 'apns'; token: string; environment: 'sandbox' | 'production' }
  | { kind: 'web'; token: string; p256dh: string; auth: string })

/** Every device the person is signed in on; a session that ends takes its devices with it. */
export async function listUserDevices(db: DbClient, userId: string): Promise<UserDevice[]> {
  const rows = await queryAll<{ kind: 'apns' | 'web'; token: string; session_id: string; environment: 'sandbox' | 'production' | null; p256dh: string | null; auth: string | null }>(
    db, 'SELECT kind, token, session_id, environment, p256dh, auth FROM device_tokens WHERE user_id = ? ORDER BY token', [userId],
  )
  // The table's check constraint guarantees each kind's columns; a row that breaks it is reported, not skipped.
  return rows.map((row) => {
    if (row.kind === 'apns' && row.environment) return { kind: 'apns', token: row.token, sessionId: row.session_id, environment: row.environment }
    if (row.kind === 'web' && row.p256dh && row.auth) return { kind: 'web', token: row.token, sessionId: row.session_id, p256dh: row.p256dh, auth: row.auth }
    throw new Error(`device_tokens row for user ${userId} is missing its ${row.kind} fields`)
  })
}

/**
 * Removes a device its push service reported is gone: Apple's 410 or 400
 * BadDeviceToken, a browser push service's 404 or 410. Scoped to the
 * registration that was sent to, so a token re-registered since then — by a
 * newer session, in the other APNs environment, or with new keys — is kept.
 */
export async function retireDevice(db: DbClient, input: { userId: string; device: UserDevice }): Promise<void> {
  const { device } = input
  if (device.kind === 'apns') {
    await execute(db, 'DELETE FROM device_tokens WHERE token = ? AND kind = \'apns\' AND user_id = ? AND session_id = ? AND environment = ?', [device.token, input.userId, device.sessionId, device.environment])
    return
  }
  await execute(db, 'DELETE FROM device_tokens WHERE token = ? AND kind = \'web\' AND user_id = ? AND session_id = ? AND p256dh = ?', [device.token, input.userId, device.sessionId, device.p256dh])
}
