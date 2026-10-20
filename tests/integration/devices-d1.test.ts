import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { hashPassword } from 'better-auth/crypto'
import { H3 } from 'nitro/h3'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import registerRoute from '../../server/api/dashboard/devices/index.post.ts'
import unregisterRoute from '../../server/api/dashboard/devices/index.delete.ts'
import { registerDevice } from '../../server/domain/devices.ts'

const BASE = 'https://devices-proof.example'
const PASSWORD = 'DeviceProof123!'

test('device registration requires the current bearer session and cascades with that session', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'devices-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    for (const id of ['first-user', 'second-user']) {
      await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@devices-proof.example`).run()
      await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)")
        .bind(`account-${id}`, id, id, await hashPassword(PASSWORD)).run()
    }
    const env = {
      DB: db, BETTER_AUTH_SECRET: 'devices-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: BASE, NUXT_PUBLIC_PLATFORM_DOMAIN: BASE,
      STRIPE_SECRET_KEY: 'sk_test_devices_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    const auth = createAuth(env)
    const signIn = async (id: string) => {
      const response = await auth.api.signInEmail({ body: { email: `${id}@devices-proof.example`, password: PASSWORD }, asResponse: true })
      assert.equal(response.status, 200)
      const token = response.headers.get('set-auth-token')
      assert.ok(token)
      const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }), query: { disableCookieCache: true, disableRefresh: true } })
      assert.ok(session)
      return { token, sessionId: session.session.id, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    }
    const app = new H3()
    app.post('/api/dashboard/devices', registerRoute)
    app.delete('/api/dashboard/devices', unregisterRoute)
    const call = async (method: 'POST' | 'DELETE', headers: Record<string, string>, body: unknown) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/dashboard/devices`, {
        method, headers: { ...headers, 'content-type': 'application/json', origin: BASE }, body: typeof body === 'string' ? body : JSON.stringify(body),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as { status?: string; data?: { code: string; field?: string; fields?: string[] } } }
    }
    const first = await signIn('first-user')
    const bearer = { authorization: `Bearer ${first.token}` }
    const registration = { deviceToken: 'AB'.repeat(40), environment: 'sandbox' }
    const count = () => db.prepare('SELECT count(*) AS n FROM device_tokens').first<number>('n')

    // Cookie authentication does not substitute for the required native bearer credential.
    const invalidCredentials: Record<string, string>[] = [{}, { cookie: first.cookie }, { authorization: 'Bearer not-a-session' }, { authorization: 'Bearer not-a-session', cookie: first.cookie }]
    for (const headers of invalidCredentials) {
      const refusal = await call('POST', headers, registration)
      assert.equal(refusal.status, 401)
      assert.equal(refusal.body.data?.code, 'UNAUTHORIZED')
    }
    assert.equal(await count(), 0)
    for (const [body, status, code, field] of [
      ['{', 400, 'INVALID_BODY', 'body'],
      [[], 400, 'INVALID_BODY', 'body'],
      [null, 400, 'INVALID_BODY', 'body'],
      [{ environment: 'sandbox' }, 422, 'INVALID_DEVICE_TOKEN', 'deviceToken'],
      [{ deviceToken: registration.deviceToken }, 422, 'INVALID_DEVICE_ENVIRONMENT', 'environment'],
      [{ ...registration, deviceToken: 'abc' }, 422, 'INVALID_DEVICE_TOKEN', 'deviceToken'],
      [{ ...registration, environment: null }, 400, 'INVALID_BODY_FIELD', 'environment'],
      [{ ...registration, environment: 'other' }, 422, 'INVALID_DEVICE_ENVIRONMENT', 'environment'],
    ] as const) {
      const refusal = await call('POST', bearer, body)
      assert.deepEqual({ status: refusal.status, ...refusal.body.data }, { status, code, field })
    }
    assert.equal(await count(), 0)
    const identityInjection = await call('POST', bearer, { ...registration, userId: 'second-user', sessionId: first.sessionId })
    assert.deepEqual({ status: identityInjection.status, ...identityInjection.body.data }, { status: 400, code: 'INVALID_BODY', fields: ['sessionId', 'userId'] })
    await assert.rejects(registerDevice(db, { token: registration.deviceToken, environment: 'sandbox', userId: 'second-user', sessionId: first.sessionId }),
      { status: 401, data: { code: 'UNAUTHORIZED', field: 'session' } })
    assert.equal(await count(), 0)
    assert.deepEqual(await call('POST', bearer, registration), { status: 200, body: { status: 'registered' } })
    assert.deepEqual(await db.prepare('SELECT token, user_id, session_id, environment FROM device_tokens').first(), {
      token: registration.deviceToken.toLowerCase(), user_id: 'first-user', session_id: first.sessionId, environment: 'sandbox',
    })
    assert.deepEqual(await call('POST', bearer, registration), { status: 200, body: { status: 'registered' } })
    assert.equal(await count(), 1)

    // A new real sign-in rebinds this device; the old session cannot remove the new registration.
    const next = await signIn('first-user')
    assert.notEqual(next.sessionId, first.sessionId)
    assert.equal((await call('POST', { authorization: `Bearer ${next.token}` }, { ...registration, environment: 'production' })).status, 200)
    assert.equal((await call('DELETE', bearer, { deviceToken: registration.deviceToken })).status, 200)
    assert.equal(await db.prepare('SELECT session_id FROM device_tokens').first('session_id'), next.sessionId)
    await auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${first.token}` }) })
    assert.equal(await count(), 1)
    // An operation already authenticated before logout cannot rebind the token afterward.
    await assert.rejects(registerDevice(db, { token: registration.deviceToken, environment: 'sandbox', userId: 'first-user', sessionId: first.sessionId }),
      { status: 401, data: { code: 'UNAUTHORIZED', field: 'session' } })
    assert.equal(await db.prepare('SELECT session_id FROM device_tokens').first('session_id'), next.sessionId)

    const second = await signIn('second-user')
    assert.equal((await call('DELETE', { authorization: `Bearer ${second.token}` }, { deviceToken: registration.deviceToken })).status, 200)
    assert.equal(await count(), 1)
    await auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${next.token}` }) })
    assert.equal(await count(), 0)
    const revoked = await call('POST', { authorization: `Bearer ${next.token}` }, registration)
    assert.equal(revoked.status, 401)
    assert.equal(revoked.body.data?.code, 'UNAUTHORIZED')

    const expiring = await signIn('first-user')
    await db.prepare('UPDATE session SET expiresAt = unixepoch() - 1 WHERE id = ?').bind(expiring.sessionId).run()
    await assert.rejects(registerDevice(db, { token: registration.deviceToken, environment: 'sandbox', userId: 'first-user', sessionId: expiring.sessionId }),
      { status: 401, data: { code: 'UNAUTHORIZED', field: 'session' } })
    assert.equal(await count(), 0)

    // Deleting the account also removes its remaining session-bound devices.
    assert.equal((await call('POST', { authorization: `Bearer ${second.token}` }, registration)).status, 200)
    await db.prepare('DELETE FROM user WHERE id = ?').bind('second-user').run()
    assert.equal(await count(), 0)
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, [])
  } finally {
    await runtime.dispose()
  }
})
