import { HTTPError, type H3Event } from 'nitro'
import { execute, queryAll, type DbClient } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'

/** Devices belong to the actual Better Auth session, independently of its organizations. */
export async function requireDeviceSession(event: H3Event) {
  const authorization = event.req.headers.get('authorization')
  if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
    throw new HTTPError({ statusCode: 401, message: 'A bearer session is required to register a device', data: { code: 'UNAUTHORIZED', field: 'Authorization' } })
  }
  const env = cloudflareEnv(event)
  if (!env.DB) {
    throw new HTTPError({ statusCode: 503, message: 'Database is not available', data: { code: 'DATABASE_UNAVAILABLE', field: 'DB' } })
  }
  const session = await createAuth(env).api.getSession({
    headers: new Headers({ authorization }),
    query: { disableCookieCache: true, disableRefresh: true },
  })
  if (!session) {
    throw new HTTPError({ statusCode: 401, message: 'A current bearer session is required to register a device', data: { code: 'UNAUTHORIZED', field: 'session' } })
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

export async function registerDevice(
  db: DbClient,
  input: { token: unknown; userId: string; sessionId: string; environment: unknown },
): Promise<void> {
  const token = deviceToken(input.token), environment = deviceEnvironment(input.environment)
  // The Better Auth read authorizes the request. This same-statement guard
  // prevents a revoked or expired session from winning a later device write.
  const result = await execute(db, `
    INSERT INTO device_tokens (token, user_id, session_id, environment)
    SELECT ?, userId, id, ? FROM session
    WHERE id = ? AND userId = ? AND expiresAt > unixepoch()
    ON CONFLICT (token) DO UPDATE SET
      user_id = excluded.user_id,
      session_id = excluded.session_id,
      environment = excluded.environment,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `, [token, environment, input.sessionId, input.userId])
  if (result.meta.changes !== 1) {
    throw new HTTPError({ statusCode: 401, message: 'A current bearer session is required to register a device', data: { code: 'UNAUTHORIZED', field: 'session' } })
  }
}

export async function unregisterDevice(
  db: DbClient,
  input: { token: unknown; userId: string; sessionId: string },
): Promise<void> {
  // An older signed-in session cannot unregister a token since reassigned to a new session.
  await execute(db, 'DELETE FROM device_tokens WHERE token = ? AND user_id = ? AND session_id = ?', [deviceToken(input.token), input.userId, input.sessionId])
}

export interface UserDevice {
  token: string
  environment: 'sandbox' | 'production'
}

/** Every device the person is signed in on; a session that ends takes its devices with it. */
export async function listUserDevices(db: DbClient, userId: string): Promise<UserDevice[]> {
  return await queryAll<UserDevice>(db, 'SELECT token, environment FROM device_tokens WHERE user_id = ? ORDER BY token', [userId])
}

/**
 * Removes a token Apple reported is no longer valid (410, or 400 BadDeviceToken).
 * Scoped to the registration that was sent to, so a token re-registered by a
 * newer session or in the other environment since then is kept.
 */
export async function retireDevice(db: DbClient, input: { userId: string } & UserDevice): Promise<void> {
  await execute(db, 'DELETE FROM device_tokens WHERE token = ? AND user_id = ? AND environment = ?', [input.token, input.userId, input.environment])
}
