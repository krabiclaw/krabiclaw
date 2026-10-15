import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'

// The password policy applies where a password is chosen, and sign-in answers
// the same for an email with no password as for a wrong one.

const BASE = 'https://proof.example'

test('sign-in does not apply the password policy; choosing a password does', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'password-policy-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('with-password', 'A', 'with-password@proof.example', 1, 0, 0), ('without-password', 'B', 'without-password@proof.example', 1, 0, 0)").run()
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('credential', 'with-password', 'credential', 'with-password', ?, 0, 0)").bind(await hashPassword('ProofPassword123!')).run()
    const auth = createAuth({
      DB: db, BETTER_AUTH_SECRET: 'password-policy-proof-secret-long-enough-for-auth',
      BETTER_AUTH_URL: BASE, NUXT_PUBLIC_PLATFORM_DOMAIN: BASE,
      STRIPE_SECRET_KEY: 'sk_test_password_policy_no_provider_requests',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv)
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await auth.handler(new Request(`${BASE}/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) }))
      return { status: response.status, code: (await response.json() as { code?: string }).code }
    }

    // A password that fails the policy, against an email with no password,
    // an email with one, and an email nobody has: one answer for all three.
    const rejected = { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }
    for (const email of ['without-password@proof.example', 'with-password@proof.example', 'nobody@proof.example']) {
      assert.deepEqual(await post('/sign-in/email', { email, password: 'lowercaseonly' }), rejected, email)
    }
    const signedIn = await auth.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'with-password@proof.example', password: 'ProofPassword123!' }) }))
    assert.equal(signedIn.status, 200)
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const session = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }))
    assert.equal((await session.json() as { user: { id: string } }).user.id, 'with-password')

    // Choosing a password still meets the policy.
    assert.deepEqual(await post('/sign-up/email', { name: 'C', email: 'new@proof.example', password: 'lowercaseonly' }), { status: 400, code: 'INVALID_PASSWORD' })
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM user WHERE email = 'new@proof.example'").first('n'), 0)
    assert.deepEqual(await post('/reset-password', { token: 'any', newPassword: 'lowercaseonly' }), { status: 400, code: 'INVALID_PASSWORD' })
    assert.equal((await post('/sign-up/email', { name: 'C', email: 'new@proof.example', password: 'NewPassword123!' })).status, 200)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM account a JOIN user u ON u.id = a.userId WHERE u.email = 'new@proof.example' AND a.providerId = 'credential'").first('n'), 1)
  } finally {
    await runtime.dispose()
  }
})
