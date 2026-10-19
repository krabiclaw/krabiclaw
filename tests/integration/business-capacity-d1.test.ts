import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { billingCapacity, readBillingUsage } from '../../server/utils/billing.ts'
import { createLocation, updateLocation } from '../../server/utils/location-management.ts'
import { createProduct, deleteProduct, getProduct, setProductLocation, updateProduct } from '../../server/utils/product-management.ts'
import { createStayHome, stayHomeInput } from '../../server/domain/stays.ts'
import { businessMonthlyAmount } from '../../shared/billing-model.ts'

// #1493: the current Business offer bills locations and rental units with two
// allowances. A home is a rental unit, counted once while it is on sale or a
// channel still books it; a location holding only homes is billed by its units.
// Every write that adds either is refused past what the Stripe subscription
// covers, and a Business subscription on the earlier price keeps its contract.

const OWNER = 'owner'
const actor = { actorId: OWNER }
const tiers = (amount: number) => [{ up_to: 2, flat_amount: amount, unit_amount: null, flat_amount_decimal: String(amount), unit_amount_decimal: null }, { up_to: null, flat_amount: null, unit_amount: 4900, flat_amount_decimal: null, unit_amount_decimal: '4900' }]
const planItem = (amount: number, quantity: number) => ({ id: 'si_plan', object: 'subscription_item', quantity, price: {
  id: `price_business_${amount}`, object: 'price', active: true, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: tiers(amount), unit_amount: null, transform_quantity: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, product: { id: 'prod_business', object: 'product', metadata: { plan_id: 'business' } } } })
const unitItem = (quantity: number) => ({ id: 'si_units', object: 'subscription_item', quantity, price: {
  id: 'price_unit', object: 'price', active: true, currency: 'usd', billing_scheme: 'per_unit', unit_amount: 1900, transform_quantity: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, product: { id: 'prod_units', object: 'product', metadata: { product_family: 'rental_units' } } } })

test('the current Business offer counts and limits rental units and the locations that are not only homes', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'business-capacity-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'business-capacity-proof', exportName: 'Hub' } },
  } }] })
  // Stripe answers the one subscription this organization is billed on; which items it has is what each phase sets.
  let stripeItems: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== 'api.stripe.com') return originalFetch(input, init)
    assert.equal(url.pathname, '/v1/subscriptions/sub_business')
    return Response.json({ id: 'sub_business', object: 'subscription', status: 'active', customer: 'cus_business', items: { object: 'list', data: stripeItems } })
  }) as typeof fetch
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, BETTER_AUTH_SECRET: 'business-capacity-proof-secret-long-enough', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_business_capacity', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@proof.example', 1, 0, 0)").bind(OWNER).run()
    const organization = async (id: string, plan: string, seats: number, stripeSubscriptionId: string | null) => {
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
        VALUES (?, ?, ?, ?, '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-19T00:00:00.000Z', 'America/Denver')`).bind(id, id, id, id).run()
      await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')").bind(`${id}-en`, id).run()
      await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 0)").bind(`m-${id}`, id, OWNER).run()
      await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, stripeSubscriptionId, stripeCustomerId, periodEnd) VALUES (?, ?, ?, 'active', ?, ?, 'cus_business', ?)")
        .bind(`sub-${id}`, plan, id, seats, stripeSubscriptionId, Math.floor(Date.now() / 1000) + 86_400).run()
    }
    const home = (organizationId: string, key: string) => createStayHome(env, db, { organizationId, actorId: OWNER, manage: true }, stayHomeInput({
      name: `Home ${key}`, timezone: 'America/Denver', address: `${key} Shore Rd`, city: 'Moab', country: 'US', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1, base_price_minor: 150_00,
    }), key)
    const place = async (organizationId: string, title: string) => {
      const created = await createLocation(env, db, organizationId, { title, timezone: 'America/Denver' }, OWNER)
      return created
    }
    const homeAt = (organizationId: string, locationId: string, name: string) => createProduct(db, { env, organizationId, actor, product: {
      kind: 'stay', name, variants: [{ name, prices: [{ unit_amount: 150_00, currency: 'USD' }] }],
      stay: { location_id: locationId, check_in_time: '15:00', check_out_time: '11:00', max_guests: 2, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const usage = async (organizationId: string) => {
      const counts = await readBillingUsage(db, organizationId)
      return { locations: counts.nonLodgingLocations, rentalUnits: counts.rentalUnits }
    }
    const rows = async (table: string, organizationId: string) => await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`).bind(organizationId).first('n')

    // ── The current offer: 2 locations on the plan item, 3 rental units (2 + 1 additional).
    await organization('inn', 'business', 2, 'sub_business')
    stripeItems = [planItem(14900, 2), unitItem(1)]
    const bistro = await place('inn', 'Bistro')
    assert.equal(bistro.status, 201)
    const bistroId = (bistro.data as { location: { id: string } }).location.id
    const villas = []
    for (const key of ['villa-1', 'villa-2', 'villa-3']) villas.push(await home('inn', key))
    // Three villas at three addresses are three units and no billed location.
    assert.deepEqual(await usage('inn'), { locations: 1, rentalUnits: 3 })
    assert.deepEqual(await billingCapacity(env, db, 'inn'), {
      plan: 'business', billsRentalUnits: true, locations: { used: 1, covered: 2 }, rentalUnits: { used: 3, covered: 3 },
    })
    // A fourth home is refused before its location is made, so nothing is left behind.
    const locationsBefore = await rows('business_locations', 'inn')
    await assert.rejects(home('inn', 'villa-4'), {
      status: 402, data: { error: 'Your plan covers 3 rental units. Add rental units to your plan in Billing (2 included, then $19 per additional rental unit per month), then add the home.', code: 'RENTAL_UNIT_LIMIT', rental_units: { used: 3, covered: 3 } },
    })
    assert.equal(await rows('business_locations', 'inn'), locationsBefore)

    // Locations: the bistro and a cafe fill the two; a third operating location is refused.
    assert.equal((await place('inn', 'Cafe')).status, 201)
    assert.deepEqual(await place('inn', 'Diner'), { status: 402, data: {
      error: 'Your plan covers 2 locations besides those with only rental units. Add a location to your plan in Billing (2 included, then $49 per additional location per month), then create it.',
      code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    } })
    // Offering a dish at a villa makes it an operating location, which the plan does not cover.
    const soup = await createProduct(db, { env, organizationId: 'inn', actor, product: { kind: 'dish', name: 'Soup', variants: [{ name: 'Soup', prices: [{ unit_amount: 9_00, currency: 'USD' }] }] } })
    await assert.rejects(setProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id, actor, env }), {
      status: 402, data: { error: 'Your plan covers 2 locations besides those with only rental units. Add a location to your plan in Billing (2 included, then $49 per additional location per month), then offer it there.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 } },
    })
    assert.deepEqual((await getProduct(db, 'inn', soup.id)).locations, [])
    // At the bistro, which already operates, it adds nothing.
    await setProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: bistroId, actor, env })
    assert.deepEqual(await usage('inn'), { locations: 2, rentalUnits: 3 })

    // A cabin at the bistro is a mixed-use site: one location, and the cabin is a unit, refused past the three.
    await assert.rejects(homeAt('inn', bistroId, 'Garden Cabin'), { status: 402, data: { error: 'Your plan covers 3 rental units. Add rental units to your plan in Billing (2 included, then $19 per additional rental unit per month), then add it.', code: 'RENTAL_UNIT_LIMIT', rental_units: { used: 3, covered: 3 } } })
    // Turning a villa off frees its unit — closing dates would not — and the cabin fits, with the bistro still counted once.
    await updateProduct(db, { env, organizationId: 'inn', productId: villas[2]!.product_id, actor, patch: { active: false } })
    assert.deepEqual(await usage('inn'), { locations: 2, rentalUnits: 2 })
    const cabin = await homeAt('inn', bistroId, 'Garden Cabin')
    assert.deepEqual(await usage('inn'), { locations: 2, rentalUnits: 3 })
    // Turning the villa back on is a fourth unit.
    await assert.rejects(updateProduct(db, { env, organizationId: 'inn', productId: villas[2]!.product_id, actor, patch: { active: true } }), { status: 402, data: { error: 'Your plan covers 3 rental units. Add rental units to your plan in Billing (2 included, then $19 per additional rental unit per month), then turn it on.', code: 'RENTAL_UNIT_LIMIT', rental_units: { used: 3, covered: 3 } } })
    assert.equal((await getProduct(db, 'inn', villas[2]!.product_id)).active, false)

    // A home a channel still books stays a unit while it is off, and is counted once.
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES ('inn', ?, 'channex', 'airbnb-listing-3', 'channel-1', 'property-3', 'room-3', 'rate-3', 'complete', 1)`).bind(villas[2]!.product_id).run()
    assert.deepEqual(await usage('inn'), { locations: 2, rentalUnits: 4 })
    // Past its plan, the business still edits everything that adds nothing.
    const renamed = await updateProduct(db, { env, organizationId: 'inn', productId: cabin.id, actor, patch: { name: 'Garden Cabin by the Bistro' } })
    assert.equal((await getProduct(db, 'inn', renamed.id)).name, 'Garden Cabin by the Bistro')
    // Deleting the cabin leaves the bistro operating as before; it frees a unit.
    await deleteProduct(db, { organizationId: 'inn', productId: cabin.id, env })
    assert.deepEqual(await usage('inn'), { locations: 2, rentalUnits: 3 })
    // A location made active again is refused when the plan has no slot for it.
    const diner = await place('inn', 'Diner')
    assert.equal(diner.status, 402)
    const cafe = (await db.prepare("SELECT id FROM business_locations WHERE organization_id = 'inn' AND title = 'Cafe'").first('id')) as string
    assert.equal((await updateLocation(db, 'inn', cafe, { status: 'inactive' }, OWNER, env)).status, 200)
    assert.equal((await place('inn', 'Diner')).status, 201)
    assert.deepEqual(await updateLocation(db, 'inn', cafe, { status: 'active' }, OWNER, env), { status: 402, data: {
      error: 'Your plan covers 2 locations besides those with only rental units. Add a location to your plan in Billing (2 included, then $49 per additional location per month), then make it active.',
      code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    } })

    // ── A Business subscription on the earlier price keeps its contract: every location is billed, units are not limited.
    stripeItems = [planItem(9900, 6)]
    assert.deepEqual(await billingCapacity(env, db, 'inn'), {
      plan: 'business', billsRentalUnits: false, locations: { used: 5, covered: 2 }, rentalUnits: null,
    })
    await db.prepare("UPDATE subscription SET seats = 6 WHERE referenceId = 'inn'").run()
    assert.equal((await homeAt('inn', bistroId, 'Second Cabin')).kind, 'stay')
    assert.equal((await home('inn', 'villa-5')).name, 'Home villa-5')
    await assert.rejects(home('inn', 'villa-6'), { status: 402, data: { error: 'Your plan covers 6 locations. Add a location to your plan in Billing (2 included, then $49 per additional location per month), then create it.', code: 'LOCATION_LIMIT', locations: { used: 6, covered: 6 } } })

    // ── #1493's portfolios, counted from the homes and locations themselves.
    await organization('portfolio', 'growth', 40, null)
    const building = (await place('portfolio', 'Harbor Building')).data as { location: { id: string } }
    for (let unit = 1; unit <= 6; unit += 1) await homeAt('portfolio', building.location.id, `Apartment ${unit}`)
    assert.deepEqual(await usage('portfolio'), { locations: 0, rentalUnits: 6 })
    assert.equal(businessMonthlyAmount(0, 6), 225_00)
    for (let villa = 1; villa <= 6; villa += 1) await home('portfolio', `portfolio-villa-${villa}`)
    assert.deepEqual(await usage('portfolio'), { locations: 0, rentalUnits: 12 })
    for (let more = 1; more <= 8; more += 1) await homeAt('portfolio', building.location.id, `Studio ${more}`)
    assert.deepEqual(await usage('portfolio'), { locations: 0, rentalUnits: 20 })
    assert.equal(businessMonthlyAmount(0, 20), 491_00)
    for (const title of ['Restaurant One', 'Restaurant Two', 'Restaurant Three']) await place('portfolio', title)
    assert.deepEqual(await usage('portfolio'), { locations: 3, rentalUnits: 20 })
    assert.equal(businessMonthlyAmount(3, 0), 198_00)
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
  }
})
