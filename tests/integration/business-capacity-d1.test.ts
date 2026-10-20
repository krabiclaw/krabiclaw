import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { billingCapacity, readBillingUsage } from '../../server/utils/billing.ts'
import { createLocation, deleteLocation, updateLocation } from '../../server/utils/location-management.ts'
import { createProduct, deleteProduct, removeProductLocation, setProductLocation, updateProduct } from '../../server/utils/product-management.ts'
import { createStayHome, stayHomeInput } from '../../server/domain/stays.ts'

// Billing by count: Business bills locations and rental units with two
// allowances, Growth bills locations. A home is a rental unit, counted once
// while it is on sale or a channel still books it; a location holding only
// homes is billed by its units. A paid plan refuses nothing: every write that
// changes a count reports it to its Stripe meter, and the subscription's
// metered prices bill the last count of the period at its end. Basic includes
// its locations and refuses past them.

const OWNER = 'owner'
const actor = { actorId: OWNER }

test('billed counts are reported to their Stripe meters, and only Basic limits locations', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'business-capacity-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'business-capacity-proof', exportName: 'Hub' } },
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
  // The last count each meter of a customer was sent.
  const last = (customer: string) => Object.fromEntries(['krabiclaw_locations', 'krabiclaw_rental_units']
    .map(event => [event.replace('krabiclaw_', ''), reported.filter(row => row.customer === customer && row.event === event).at(-1)?.value ?? null]))
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
        VALUES (?, ?, ?, ?, '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-19T00:00:00.000Z', 'America/Denver', ?)`).bind(id, id, id, id, customer).run()
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
    const usage = async (organizationId: string) => {
      const counts = await readBillingUsage(db, organizationId)
      return { locations: counts.nonLodgingLocations, rentalUnits: counts.rentalUnits }
    }

    // ── Business: three villas at three addresses are three units and no billed location.
    await organization('inn', 'business')
    const bistro = await place('inn', 'Bistro')
    assert.equal(bistro.status, 201)
    const bistroId = (bistro.data as { location: { id: string } }).location.id
    assert.deepEqual(last('cus_inn'), { locations: 1, rental_units: 0 })
    const villas = []
    for (const key of ['villa-1', 'villa-2', 'villa-3', 'villa-4']) villas.push(await home('inn', key))
    // Past the included two nothing is refused; the count reaches the meter.
    assert.deepEqual(await usage('inn'), { locations: 1, rentalUnits: 4 })
    assert.deepEqual(last('cus_inn'), { locations: 1, rental_units: 4 })
    assert.deepEqual(await billingCapacity(env, db, 'inn'), { plan: 'business', billsRentalUnits: true, locations: 1, rentalUnits: 4 })
    // A villa's location was inactive until it held its home: no event ever counted it as a location.
    assert.equal(reported.some(row => row.customer === 'cus_inn' && row.event === 'krabiclaw_locations' && row.value > 1), false)

    // Locations past the included two are made and reported.
    assert.equal((await place('inn', 'Cafe')).status, 201)
    assert.equal((await place('inn', 'Diner')).status, 201)
    assert.deepEqual(last('cus_inn'), { locations: 3, rental_units: 4 })
    // Offering a dish at a villa makes it an operating location; taking it away makes it a home's again.
    const soup = await createProduct(db, { env, organizationId: 'inn', actor, product: { kind: 'dish', name: 'Soup', variants: [{ name: 'Soup', prices: [{ unit_amount: 9_00, currency: 'USD' }] }] } })
    await setProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id, actor, env })
    assert.deepEqual(last('cus_inn'), { locations: 4, rental_units: 4 })
    await removeProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id, env })
    assert.deepEqual(last('cus_inn'), { locations: 3, rental_units: 4 })
    // At the bistro, which already operates, it adds nothing.
    await setProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: bistroId, actor, env })
    assert.deepEqual(await usage('inn'), { locations: 3, rentalUnits: 4 })

    // A cabin at the bistro is a mixed-use site: one location, and the cabin is a unit.
    const cabin = await homeAt('inn', bistroId, 'Garden Cabin')
    assert.deepEqual(last('cus_inn'), { locations: 3, rental_units: 5 })
    // Turning a villa off frees its unit — closing dates would not.
    await updateProduct(db, { env, organizationId: 'inn', productId: villas[2]!.product_id, actor, patch: { active: false } })
    assert.deepEqual(last('cus_inn'), { locations: 3, rental_units: 4 })
    // A home a channel still books stays a unit while it is off, and is counted once.
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES ('inn', ?, 'channex', 'airbnb-listing-3', 'channel-1', 'property-3', 'room-3', 'rate-3', 'complete', 1)`).bind(villas[2]!.product_id).run()
    assert.deepEqual(await usage('inn'), { locations: 3, rentalUnits: 5 })
    // Deleting the cabin leaves the bistro operating as before; it frees a unit.
    await deleteProduct(db, { organizationId: 'inn', productId: cabin.id, env })
    assert.deepEqual(last('cus_inn'), { locations: 3, rental_units: 4 })
    // A location turned off or deleted is no longer billed.
    const cafe = (await db.prepare("SELECT id FROM business_locations WHERE organization_id = 'inn' AND title = 'Cafe'").first('id')) as string
    assert.equal((await updateLocation(db, 'inn', cafe, { status: 'inactive' }, OWNER, env)).status, 200)
    assert.deepEqual(last('cus_inn'), { locations: 2, rental_units: 4 })
    const diner = (await db.prepare("SELECT id FROM business_locations WHERE organization_id = 'inn' AND title = 'Diner'").first('id')) as string
    assert.equal((await deleteLocation(env, db, 'inn', diner)).status, 200)
    assert.deepEqual(last('cus_inn'), { locations: 1, rental_units: 4 })

    // ── Growth bills every active location, homes' locations included, and no rental units.
    await organization('grower', 'growth')
    for (const title of ['One', 'Two', 'Three']) assert.equal((await place('grower', title)).status, 201)
    assert.deepEqual(last('cus_grower'), { locations: 3, rental_units: null })
    assert.deepEqual(await billingCapacity(env, db, 'grower'), { plan: 'growth', billsRentalUnits: false, locations: 3, rentalUnits: null })

    // ── Basic includes two locations and refuses a third; it has no customer and reports nothing.
    await organization('starter', null)
    for (const title of ['One', 'Two']) assert.equal((await place('starter', title)).status, 201)
    assert.deepEqual(await place('starter', 'Three'), { status: 402, data: {
      error: 'Basic includes 2 locations. Choose Growth or Business in Billing to add more.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    } })
    assert.equal(reported.some(row => row.customer === 'cus_starter'), false)

    // ── #1493's portfolios, counted from the homes and locations themselves.
    await organization('portfolio', 'business')
    const building = (await place('portfolio', 'Harbor Building')).data as { location: { id: string } }
    for (let unit = 1; unit <= 6; unit += 1) await homeAt('portfolio', building.location.id, `Apartment ${unit}`)
    assert.deepEqual(await usage('portfolio'), { locations: 0, rentalUnits: 6 })
    for (let villa = 1; villa <= 6; villa += 1) await home('portfolio', `portfolio-villa-${villa}`)
    for (let more = 1; more <= 8; more += 1) await homeAt('portfolio', building.location.id, `Studio ${more}`)
    for (const title of ['Restaurant One', 'Restaurant Two', 'Restaurant Three']) await place('portfolio', title)
    assert.deepEqual(last('cus_portfolio'), { locations: 3, rental_units: 20 })
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
  }
})
