import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { countActiveLocations } from '../../server/utils/billing.ts'
import { createLocation, deleteLocation, updateLocation } from '../../server/utils/location-management.ts'
import { createProduct, deleteProduct, removeProductLocation, setProductLocation, updateProduct } from '../../server/utils/product-management.ts'
import { createStayHome, stayHomeInput } from '../../server/domain/stays.ts'

// Billing by count: Growth and Business bill every active location, homes'
// locations included, and a home is a product there that is not billed. A
// paid plan refuses no location: every write that makes one active or takes
// one away reports the count to the Stripe locations meter, and the
// subscription's metered price bills the last count of the period at its end.
// Basic includes its locations and refuses past them.

const OWNER = 'owner'
const actor = { actorId: OWNER }

test('active locations are reported to the Stripe locations meter, and only Basic limits them', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'business-capacity-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'business-capacity-proof', exportName: 'Hub' } },
  } }] })
  // Stripe receives the meter events; each one is kept as Stripe was sent it.
  const reported: Array<{ event: string; customer: string; value: number }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== 'api.stripe.com') return originalFetch(input, init)
    assert.equal(url.pathname, '/v1/billing/meter_events')
    const body = new URLSearchParams(String(init?.body))
    reported.push({ event: body.get('event_name')!, customer: body.get('payload[stripe_customer_id]')!, value: Number(body.get('payload[value]')) })
    return Response.json({ object: 'billing.meter_event', event_name: body.get('event_name'), identifier: crypto.randomUUID(), payload: {}, timestamp: Math.floor(Date.now() / 1000), created: Math.floor(Date.now() / 1000), livemode: false })
  }) as typeof fetch
  // The last count a customer's locations meter was sent; it is the only meter counts reach.
  const last = (customer: string) => {
    assert.deepEqual(reported.filter(row => row.event !== 'krabiclaw_locations'), [])
    return reported.filter(row => row.customer === customer).at(-1)?.value ?? null
  }
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, BETTER_AUTH_SECRET: 'business-capacity-proof-secret-long-enough', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_business_capacity', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@proof.example', 1, 0, 0)").bind(OWNER).run()
    const organization = async (id: string, plan: string | null) => {
      const customer = plan ? `cus_${id}` : null
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone, "stripeCustomerId")
        VALUES (?, ?, ?, ?, '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-19T00:00:00.000Z', 'America/Denver', ?)`).bind(id, id, id, id, customer).run()
      await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')").bind(`${id}-en`, id).run()
      await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 0)").bind(`m-${id}`, id, OWNER).run()
      if (plan) await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, stripeSubscriptionId, stripeCustomerId, periodEnd) VALUES (?, ?, ?, 'active', 1, ?, ?, ?)")
        .bind(`sub-${id}`, plan, id, `sub_${id}`, customer, Math.floor(Date.now() / 1000) + 86_400).run()
    }
    const home = (organizationId: string, key: string) => createStayHome(env, db, { organizationId, actorId: OWNER, manage: true }, stayHomeInput({
      name: `Home ${key}`, timezone: 'America/Denver', address: `${key} Shore Rd`, city: 'Moab', country: 'US', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1, base_price_minor: 150_00,
    }), key)
    const place = (organizationId: string, title: string) => createLocation(env, db, organizationId, { title, timezone: 'America/Denver' }, OWNER)
    const homeAt = (organizationId: string, locationId: string, name: string) => createProduct(db, { env, organizationId, actor, product: {
      kind: 'stay', name, variants: [{ name, prices: [{ unit_amount: 150_00, currency: 'USD' }] }],
      stay: { location_id: locationId, check_in_time: '15:00', check_out_time: '11:00', max_guests: 2, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const reportsFor = (customer: string) => reported.filter(row => row.customer === customer).length

    // ── Business: every active location is billed, a home's included; nothing past the included two is refused.
    await organization('inn', 'business')
    const bistro = await place('inn', 'Bistro')
    assert.equal(bistro.status, 201)
    const bistroId = (bistro.data as { location: { id: string } }).location.id
    assert.equal(last('cus_inn'), 1)
    const villas = []
    for (const key of ['villa-1', 'villa-2', 'villa-3']) villas.push(await home('inn', key))
    assert.equal(await countActiveLocations(db, 'inn'), 4)
    assert.equal(last('cus_inn'), 4)
    // Homes and offerings are products at a location: adding, turning off or deleting one changes no count and reports nothing.
    const before = reportsFor('cus_inn')
    const cabin = await homeAt('inn', bistroId, 'Garden Cabin')
    const soup = await createProduct(db, { env, organizationId: 'inn', actor, product: { kind: 'dish', name: 'Soup', variants: [{ name: 'Soup', prices: [{ unit_amount: 9_00, currency: 'USD' }] }] } })
    await setProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id, actor, env })
    await removeProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id })
    await updateProduct(db, { env, organizationId: 'inn', productId: villas[2]!.product_id, actor, patch: { active: false } })
    await deleteProduct(db, { organizationId: 'inn', productId: cabin.id, env })
    assert.equal(reportsFor('cus_inn'), before)
    assert.equal(await countActiveLocations(db, 'inn'), 4)
    // A location turned off or deleted is no longer billed; turning it back on bills it again.
    const villa = villas[1]!.location_id
    assert.equal((await updateLocation(db, 'inn', villa, { status: 'inactive' }, OWNER, env)).status, 200)
    assert.equal(last('cus_inn'), 3)
    assert.equal((await updateLocation(db, 'inn', villa, { status: 'active' }, OWNER, env)).status, 200)
    assert.equal(last('cus_inn'), 4)
    assert.equal((await place('inn', 'Cafe')).status, 201)
    assert.equal(last('cus_inn'), 5)
    const cafe = (await db.prepare("SELECT id FROM business_locations WHERE organization_id = 'inn' AND title = 'Cafe'").first('id')) as string
    assert.equal((await deleteLocation(env, db, 'inn', cafe)).status, 200)
    assert.equal(last('cus_inn'), 4)

    // ── Growth bills the same way.
    await organization('grower', 'growth')
    for (const title of ['One', 'Two', 'Three']) assert.equal((await place('grower', title)).status, 201)
    assert.equal(last('cus_grower'), 3)

    // ── Basic includes two locations and refuses a third, a home's among them; it has no customer and reports nothing.
    await organization('starter', null)
    for (const title of ['One', 'Two']) assert.equal((await place('starter', title)).status, 201)
    assert.deepEqual(await place('starter', 'Three'), { status: 402, data: {
      error: 'Basic includes 2 locations. Choose Growth or Business in Billing to add more.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    } })
    await assert.rejects(home('starter', 'starter-villa'), { status: 402, data: {
      error: 'Basic includes 2 locations. Choose Growth or Business in Billing to add more.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    } })
    assert.equal(await countActiveLocations(db, 'starter'), 2)
    assert.equal(reportsFor('cus_starter'), 0)
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
  }
})
