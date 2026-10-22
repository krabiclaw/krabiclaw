import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { countActiveHomes, countActiveLocations, homesQuote, parseHomesAdding } from '../../server/utils/billing.ts'
import { createLocation, deleteLocation, updateLocation } from '../../server/utils/location-management.ts'
import { createProduct, deleteProduct, removeProductLocation, setProductLocation, updateProduct } from '../../server/utils/product-management.ts'
import { createStayHome, stayHomeInput } from '../../server/domain/stays.ts'
import { HTTPError } from 'nitro'

// Billing by count: Growth and Business bill every active location and every
// active home. A home is a stay product at a location; that location is the
// home's, not a location, so it is never billed as one. A paid plan refuses
// nothing: every write that makes a location or a home active or takes one
// away reports both counts to their Stripe meters, and the subscription's
// metered prices bill the last count of the period at its end. Basic
// includes its locations and its homes and refuses past either.

const OWNER = 'owner'
const actor = { actorId: OWNER }

test('active locations and homes are reported to their Stripe meters, and only Basic limits them', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'business-capacity-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'business-capacity-proof', exportName: 'Hub' } },
  } }] })
  // The metered prices each Stripe subscription carries, as Stripe returns its items: Growth's carries
  // the homes price; Business's is from before homes were priced and carries only the locations one.
  const subscriptionMeters: Record<string, string[]> = { sub_grower: ['locations', 'homes'], sub_inn: ['locations'] }
  // Stripe receives the meter events; each one is kept as Stripe was sent it.
  const reported: Array<{ event: string; customer: string; value: number }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== 'api.stripe.com') return originalFetch(input, init)
    const subscription = /^\/v1\/subscriptions\/(sub_[a-z]+)$/.exec(url.pathname)?.[1]
    if (subscription) {
      const items = subscriptionMeters[subscription]!.map(family => ({ object: 'subscription_item', id: `si_${family}`, price: { object: 'price', id: `price_${family}`, product: { object: 'product', id: `prod_${family}`, metadata: { product_family: family } } } }))
      return Response.json({ object: 'subscription', id: subscription, customer: `cus_${subscription.slice(4)}`, items: { object: 'list', data: items, has_more: false } })
    }
    assert.equal(url.pathname, '/v1/billing/meter_events')
    const body = new URLSearchParams(String(init?.body))
    reported.push({ event: body.get('event_name')!, customer: body.get('payload[stripe_customer_id]')!, value: Number(body.get('payload[value]')) })
    return Response.json({ object: 'billing.meter_event', event_name: body.get('event_name'), identifier: crypto.randomUUID(), payload: {}, timestamp: Math.floor(Date.now() / 1000), created: Math.floor(Date.now() / 1000), livemode: false })
  }) as typeof fetch
  // The last counts a customer's locations and homes meters were sent; they are the only meters counts reach.
  const last = (customer: string) => {
    assert.deepEqual(reported.filter(row => row.event !== 'krabiclaw_locations' && row.event !== 'krabiclaw_homes'), [])
    const of = (event: string) => reported.filter(row => row.customer === customer && row.event === event).at(-1)?.value ?? null
    return { locations: of('krabiclaw_locations'), homes: of('krabiclaw_homes') }
  }
  try {
    const db = await runtime.getD1Database('DB')
    const counts = async (organizationId: string) => ({ locations: await countActiveLocations(db, organizationId), homes: await countActiveHomes(db, organizationId) })
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

    // ── Business: every active location and every active home is billed; a home is a home, not a location. Nothing is refused.
    await organization('inn', 'business')
    const bistro = await place('inn', 'Bistro')
    assert.equal(bistro.status, 201)
    const bistroId = (bistro.data as { location: { id: string } }).location.id
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 0 })
    const villas = []
    for (const key of ['villa-1', 'villa-2', 'villa-3']) villas.push(await home('inn', key))
    assert.deepEqual(await counts('inn'), { locations: 1, homes: 3 })
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 3 })
    // A subscription without the homes price is charged nothing for homes: its quote prices each one at 0.
    const innQuote = await homesQuote(env, db, 'inn', 1)
    assert.deepEqual([innQuote.homes, innQuote.adding], [
      { used: 3, included: 2, additional_price_minor: 0, amount_minor: 0 },
      { count: 1, additional_homes: 1, amount_minor: 0, allowed: true },
    ])
    // A stay product made at a location makes that location a home's: one more home, one fewer location.
    const cabin = await homeAt('inn', bistroId, 'Garden Cabin')
    assert.deepEqual(await counts('inn'), { locations: 0, homes: 4 })
    assert.deepEqual(last('cus_inn'), { locations: 0, homes: 4 })
    // Other offerings are products at a location: adding one or moving it changes no count and reports nothing.
    const before = reportsFor('cus_inn')
    const soup = await createProduct(db, { env, organizationId: 'inn', actor, product: { kind: 'dish', name: 'Soup', variants: [{ name: 'Soup', prices: [{ unit_amount: 9_00, currency: 'USD' }] }] } })
    await setProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id, actor, env })
    await removeProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id })
    assert.equal(reportsFor('cus_inn'), before)
    // A home turned off is not billed, and its location stays a home's; turned back on it is billed again.
    await updateProduct(db, { env, organizationId: 'inn', productId: villas[2]!.product_id, actor, patch: { active: false } })
    assert.deepEqual(await counts('inn'), { locations: 0, homes: 3 })
    assert.deepEqual(last('cus_inn'), { locations: 0, homes: 3 })
    await updateProduct(db, { env, organizationId: 'inn', productId: villas[2]!.product_id, actor, patch: { active: true } })
    assert.deepEqual(last('cus_inn'), { locations: 0, homes: 4 })
    // A home deleted leaves its location a location again.
    await deleteProduct(db, { organizationId: 'inn', productId: cabin.id, env })
    assert.deepEqual(await counts('inn'), { locations: 1, homes: 3 })
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 3 })
    // A home's location turned off takes the home off the bill; turning it back on bills the home again.
    const villa = villas[1]!.location_id
    assert.equal((await updateLocation(db, 'inn', villa, { status: 'inactive' }, OWNER, env)).status, 200)
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 2 })
    assert.equal((await updateLocation(db, 'inn', villa, { status: 'active' }, OWNER, env)).status, 200)
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 3 })
    // A location turned off or deleted is no longer billed.
    assert.equal((await place('inn', 'Cafe')).status, 201)
    assert.deepEqual(last('cus_inn'), { locations: 2, homes: 3 })
    const cafe = (await db.prepare("SELECT id FROM business_locations WHERE organization_id = 'inn' AND title = 'Cafe'").first('id')) as string
    assert.equal((await deleteLocation(env, db, 'inn', cafe)).status, 200)
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 3 })

    // ── Growth bills the same way: both meters, nothing refused.
    await organization('grower', 'growth')
    for (const title of ['One', 'Two', 'Three']) assert.equal((await place('grower', title)).status, 201)
    await home('grower', 'g-1')
    // The quote a paid host reads before adding homes: of three more, one is included and two are billed at the end of the period.
    const growerPeriodEnd = (await db.prepare("SELECT periodEnd FROM subscription WHERE referenceId = 'grower'").first('periodEnd')) as number
    assert.deepEqual(await homesQuote(env, db, 'grower', 3), {
      plan: 'growth', currency: 'USD',
      homes: { used: 1, included: 2, additional_price_minor: 900, amount_minor: 0 },
      adding: { count: 3, additional_homes: 2, amount_minor: 1800, allowed: true },
      billing: { period_end: new Date(growerPeriodEnd * 1000).toISOString(), prorated: false },
    })
    for (const key of ['g-2', 'g-3']) await home('grower', key)
    // With three in use, one is billed now and the next would be too.
    assert.deepEqual((await homesQuote(env, db, 'grower', 1)).homes, { used: 3, included: 2, additional_price_minor: 900, amount_minor: 900 })
    assert.deepEqual((await homesQuote(env, db, 'grower', 1)).adding, { count: 1, additional_homes: 1, amount_minor: 900, allowed: true })
    assert.deepEqual(await counts('grower'), { locations: 3, homes: 3 })
    assert.deepEqual(last('cus_grower'), { locations: 3, homes: 3 })

    // ── Basic includes two locations and two homes, counted apart, and refuses a third of either; it has no customer and reports nothing.
    await organization('starter', null)
    // Basic's quote: no period, nothing billed, and the home past the included ones not allowed.
    const starterQuote = (used: number, adding: number, allowed: boolean) => ({
      plan: 'free', currency: 'USD',
      homes: { used, included: 2, additional_price_minor: 900, amount_minor: 0 },
      adding: { count: adding, additional_homes: Math.max(0, used + adding - 2), amount_minor: 0, allowed },
      billing: { period_end: null, prorated: false },
    })
    assert.deepEqual(await homesQuote(env, db, 'starter', 1), starterQuote(0, 1, true))
    for (const title of ['One', 'Two']) assert.equal((await place('starter', title)).status, 201)
    assert.deepEqual(await place('starter', 'Three'), { status: 402, data: {
      error: 'Basic includes 2 locations. Choose Growth or Business in Billing to add more.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    } })
    // Two homes beside two locations: a home is not a location.
    const starterHomes = []
    for (const key of ['starter-villa-1', 'starter-villa-2']) starterHomes.push(await home('starter', key))
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 2 })
    assert.deepEqual(await homesQuote(env, db, 'starter', 0), starterQuote(2, 0, true))
    assert.deepEqual(await homesQuote(env, db, 'starter', 1), { ...starterQuote(2, 1, false), adding: { count: 1, additional_homes: 1, amount_minor: 900, allowed: false } })
    const homeLimit = { status: 402, data: { error: 'Basic includes 2 homes. Choose Growth or Business in Billing to add more.', code: 'HOME_LIMIT', homes: { used: 2, covered: 2 } } }
    await assert.rejects(home('starter', 'starter-villa-3'), homeLimit)
    // A key that already made its home replays it; it is not a third home.
    assert.deepEqual(await home('starter', 'starter-villa-2'), starterHomes[1])
    // The refusal wrote nothing: no third location was made for the refused home.
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM business_locations WHERE organization_id = 'starter'").first('n'), 4)
    // A stay product at one of the plain locations would be a third home too.
    await assert.rejects(homeAt('starter', (await db.prepare("SELECT id FROM business_locations WHERE organization_id = 'starter' AND title = 'One'").first('id')) as string, 'Attic'), homeLimit)
    // A home's location turned off frees its home; turning it back on past the included homes is refused as a home, not a location.
    const starterVilla = starterHomes[0]!.location_id
    assert.equal((await updateLocation(db, 'starter', starterVilla, { status: 'inactive' }, OWNER, env)).status, 200)
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 1 })
    await home('starter', 'starter-villa-3')
    assert.deepEqual(await updateLocation(db, 'starter', starterVilla, { status: 'active' }, OWNER, env), homeLimit)
    // A home turned off and back on past the included homes is refused the same way.
    await updateProduct(db, { env, organizationId: 'starter', productId: starterHomes[1]!.product_id, actor, patch: { active: false } })
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 1 })
    assert.equal((await updateLocation(db, 'starter', starterVilla, { status: 'active' }, OWNER, env)).status, 200)
    await assert.rejects(updateProduct(db, { env, organizationId: 'starter', productId: starterHomes[1]!.product_id, actor, patch: { active: true } }), homeLimit)
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 2 })
    // Deleting a home would make its location a third location: refused as a location while both slots are in use.
    await assert.rejects(deleteProduct(db, { organizationId: 'starter', productId: starterHomes[1]!.product_id, env }), {
      status: 402, data: { error: 'Basic includes 2 locations. Choose Growth or Business in Billing to add more.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 } },
    })
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 2 })
    assert.equal(reportsFor('cus_starter'), 0)
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
  }
})

test('the homes quote takes a whole number of homes from 0 to 500, one when not asked', () => {
  assert.equal(parseHomesAdding(undefined), 1)
  assert.equal(parseHomesAdding('0'), 0)
  assert.equal(parseHomesAdding('500'), 500)
  for (const value of ['', 'abc', '-1', '1.5', '501', ['1']]) {
    assert.throws(() => parseHomesAdding(value), (error: unknown) => error instanceof HTTPError && error.status === 422 && error.data?.code === 'INVALID_QUERY' && error.data?.field === 'adding')
  }
})
