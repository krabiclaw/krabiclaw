import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import createHomeRoute from '../../server/api/dashboard/stay-homes/index.post.ts'
import listHomesRoute from '../../server/api/dashboard/stay-homes/index.get.ts'
import { getLocation } from '../../server/utils/location-management.ts'

// A home added by hand through the native app's route: its details are
// checked field by field, it becomes a new location and an unpublished stay,
// its key replays it, plan location billing applies, and only managers add one.

const ORG = 'org'
const BASE = 'https://proof.example'
const PASSWORD = 'StayHomeProof123!'

const cabin = {
  idempotency_key: 'cabin', name: 'Cliff Cabin', timezone: 'America/Denver', address: '1 Cliff Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532',
  phone: '+14355550100', email: 'host@example.test', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2, base_price_minor: 189_50,
}

test('a home added by hand is a new location and an unpublished stay, checked, replayable and billed', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-home-create-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    for (const [id, role] of [['owner', 'owner'], ['helper', 'member']] as const) {
      await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@proof.example`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
      await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)").bind(`a-${id}`, id, id, await hashPassword(PASSWORD)).run()
    }
    const env = {
      DB: db, BETTER_AUTH_SECRET: 'stay-home-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: BASE, NUXT_PUBLIC_PLATFORM_DOMAIN: BASE,
      STRIPE_SECRET_KEY: 'sk_test_stay_home_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    const cookieFor = async (id: string) => {
      const login = await createAuth(env).api.signInEmail({ body: { email: `${id}@proof.example`, password: PASSWORD }, asResponse: true })
      assert.equal(login.status, 200)
      return login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    const app = new H3()
    app.post('/api/dashboard/stay-homes', createHomeRoute)
    app.get('/api/dashboard/stay-homes', listHomesRoute)
    const call = async (cookie: string, method: 'GET' | 'POST', body?: Record<string, unknown>) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/dashboard/stay-homes?org=org`, {
        method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, ...(body ? { body: JSON.stringify(body) } : {}),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const refusal = (result: { status: number; body: Record<string, unknown> }) => ({ status: result.status, ...(result.body.data as Record<string, unknown>) })
    const count = async (table: string) => await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`).bind(ORG).first('n')
    const owner = await cookieFor('owner')

    // Each problem names its field, and nothing is written.
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, city: ' ' })), { status: 422, code: 'MISSING_DETAIL', field: 'city' })
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, country: 'us' })), { status: 422, code: 'INVALID_DETAIL', field: 'country' })
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, check_in_time: '3pm' })), { status: 422, code: 'INVALID_DETAIL', field: 'check_in_time' })
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, max_guests: 0 })), { status: 422, code: 'INVALID_DETAIL', field: 'max_guests' })
    assert.deepEqual([await count('business_locations'), await count('products')], [0, 0])

    // A member who looks after homes does not add them.
    assert.deepEqual(refusal(await call(await cookieFor('helper'), 'POST', cabin)), { status: 403, code: 'STAY_ROLE_REQUIRED' })

    const home = {
      name: 'Cliff Cabin', timezone: 'America/Denver', currency: 'USD', base_price_minor: 189_50, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2, channel: null,
    }
    const created = await call(owner, 'POST', cabin)
    assert.equal(created.status, 201)
    const made = created.body.home as { product_id: string; location_id: string }
    assert.deepEqual(created.body, { home: { product_id: made.product_id, location_id: made.location_id, ...home } })
    // The same key returns the same home; nothing new is made.
    assert.deepEqual(await call(owner, 'POST', cabin), created)
    assert.deepEqual([await count('business_locations'), await count('products')], [1, 1])

    // Read back through other paths: the homes list, the location and the stay's publication.
    assert.deepEqual((await call(owner, 'GET')).body.homes, [created.body.home])
    const location = (await getLocation(db, ORG, made.location_id))!
    assert.deepEqual({ title: location.title, timezone: location.timezone, phone: location.phone, email: location.email, address: location.address }, {
      title: 'Cliff Cabin', timezone: 'America/Denver', phone: '+14355550100', email: 'host@example.test',
      address: { regionCode: 'US', addressLines: ['1 Cliff Rd'], locality: 'Moab', administrativeArea: 'UT', postalCode: '84532' },
    })
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM product_publications WHERE product_id = ? AND published = 1").bind(made.product_id).first('n'), 0)

    // Without a price the home has no base price; the plan's second location is the last it covers.
    const second = await call(owner, 'POST', { ...cabin, idempotency_key: 'loft', name: 'River Loft', base_price_minor: undefined, state: undefined, zip_code: undefined })
    assert.equal(second.status, 201)
    assert.equal((second.body.home as { base_price_minor: number | null }).base_price_minor, null)
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, idempotency_key: 'barn', name: 'Barn' })), { status: 402, code: 'LOCATION_LIMIT' })
    assert.deepEqual([await count('business_locations'), await count('products')], [2, 2])
  } finally {
    await runtime.dispose()
  }
})
