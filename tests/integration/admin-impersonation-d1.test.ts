import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { hashPassword } from 'better-auth/crypto'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'

const BASE = 'https://impersonation-proof.example'
const PASSWORD = 'ImpersonationProof123!'

test('a bearer administrator stops impersonating with the admin_session cookie Better Auth returned', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'impersonation-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    for (const [id, role] of [['platform-admin', 'admin'], ['host-user', 'user']]) {
      await db.prepare('INSERT INTO user (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, 0, 0)').bind(id, id, `${id}@impersonation-proof.example`, role).run()
      await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)")
        .bind(`account-${id}`, id, id, await hashPassword(PASSWORD)).run()
    }
    const env = {
      DB: db, BETTER_AUTH_SECRET: 'impersonation-proof-secret-long-enough', BETTER_AUTH_URL: BASE, NUXT_PUBLIC_PLATFORM_DOMAIN: BASE,
      STRIPE_SECRET_KEY: 'sk_test_impersonation_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    const auth = createAuth(env)
    // The native client's requests: a bearer, JSON, no cookie jar.
    const post = (path: string, headers: Record<string, string>, body: unknown) => auth.handler(new Request(`${BASE}/api/auth${path}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const sessionOf = (token: string) => auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }), query: { disableCookieCache: true, disableRefresh: true } })

    const signIn = await post('/sign-in/email', {}, { email: 'platform-admin@impersonation-proof.example', password: PASSWORD })
    assert.equal(signIn.status, 200)
    const adminToken = signIn.headers.get('set-auth-token')
    assert.ok(adminToken)

    const impersonation = await post('/admin/impersonate-user', { authorization: `Bearer ${adminToken}` }, { userId: 'host-user' })
    assert.equal(impersonation.status, 200, await impersonation.clone().text())
    const hostToken = impersonation.headers.get('set-auth-token')
    assert.ok(hostToken)
    const adminCookie = impersonation.headers.getSetCookie().map(value => value.split(';')[0]!).find(value => value.split('=')[0]!.endsWith('.admin_session'))
    assert.ok(adminCookie, 'impersonate-user returns the signed admin_session cookie')
    const impersonated = await sessionOf(hostToken)
    assert.equal(impersonated?.user.id, 'host-user')
    assert.equal(impersonated?.session.impersonatedBy, 'platform-admin')

    // Without the cookie the administrator cannot be restored; the caller is told why, with a code.
    const withoutCookie = await post('/admin/stop-impersonating', { authorization: `Bearer ${hostToken}` }, {})
    assert.equal(withoutCookie.status, 401)
    assert.equal((await withoutCookie.json() as { code: string }).code, 'ADMIN_SESSION_REQUIRED')
    assert.equal((await sessionOf(hostToken))?.user.id, 'host-user')

    // A request that carries a cookie names its origin (Better Auth's CSRF rule).
    const withoutOrigin = await post('/admin/stop-impersonating', { authorization: `Bearer ${hostToken}`, cookie: adminCookie }, {})
    assert.equal(withoutOrigin.status, 403)
    assert.equal((await withoutOrigin.json() as { code: string }).code, 'MISSING_OR_NULL_ORIGIN')

    const stopped = await post('/admin/stop-impersonating', { authorization: `Bearer ${hostToken}`, cookie: adminCookie, origin: BASE }, {})
    assert.equal(stopped.status, 200, await stopped.clone().text())
    assert.equal((await stopped.json() as { user: { id: string } }).user.id, 'platform-admin')
    assert.equal(stopped.headers.get('set-auth-token'), adminToken, 'the administrator resumes their own session')

    // Read back through the session table and the bearer boundary.
    assert.equal(await sessionOf(hostToken), null)
    assert.equal(await db.prepare("SELECT count(*) AS n FROM session WHERE userId = 'host-user'").first<number>('n'), 0)
    const restored = await sessionOf(adminToken)
    assert.equal(restored?.user.id, 'platform-admin')
    assert.equal(restored?.session.impersonatedBy ?? null, null)
  } finally {
    await runtime.dispose()
  }
})
