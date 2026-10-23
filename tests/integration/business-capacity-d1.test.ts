import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { countActiveHomes, countActiveLocations, getOrganizationBillingStatus, getOrganizationSubscriptionPrice, homesQuote, parseHomesAdding } from '../../server/utils/billing.ts'
import { createLocation, deleteLocation, updateLocation } from '../../server/utils/location-management.ts'
import { createProduct, deleteProduct, getProduct, removeProductLocation, setProductLocation, updateProduct } from '../../server/utils/product-management.ts'
import { createStayHome, readStayHome, stayHomeInput, updateStayHome } from '../../server/domain/stays.ts'
import { publishedCatalogResponse } from './support/stripe-published-catalog.ts'
import { HTTPError } from 'nitro'

// Billing by count: Growth and Business bill every active location and every
// live home. A home is a stay product at a location; that location is the
// home's, not a location, so it is never billed as one. A home is live when it
// is published on the site or syncs with Airbnb; until then it is a draft,
// free and unlimited on every plan. A paid plan refuses nothing: every write
// that makes a location active or a home live, or takes one away, reports both
// counts to their Stripe meters, and the subscription's metered prices bill
// the last count of the period at its end. Basic includes its locations and
// its live homes and refuses past either.

const OWNER = 'owner'
const actor = { actorId: OWNER }

test('active locations and live homes are reported to their Stripe meters, drafts are free, and only Basic limits them', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'business-capacity-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'business-capacity-proof', exportName: 'Hub' } },
  } }] })
  // Each Stripe subscription as Stripe returns it. Growth's carries a homes price of its own, 3 included and
  // $7 each after, not the published one: the quote reads the subscription. Business's is from before homes
  // were priced, carries only the locations price, and is in a free trial.
  const homesTiers = [{ up_to: 3, unit_amount: 0, flat_amount: null }, { up_to: null, unit_amount: 700, flat_amount: null }]
  const subscriptions: Record<string, { status: string; meters: string[] }> = { sub_grower: { status: 'active', meters: ['locations', 'homes'] }, sub_inn: { status: 'trialing', meters: ['locations'] } }
  const innTrialEnd = Math.floor(Date.UTC(2026, 10, 22, 14, 6, 27) / 1000)
  // Stripe receives the meter events; each one is kept as Stripe was sent it.
  const reported: Array<{ event: string; customer: string; value: number }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== 'api.stripe.com') return originalFetch(input, init)
    const subscription = /^\/v1\/subscriptions\/(sub_[a-z]+)$/.exec(url.pathname)?.[1]
    if (subscription) {
      assert.deepEqual([...url.searchParams].filter(([key]) => key.startsWith('expand')).map(([, value]) => value), ['items.data.price.product', 'items.data.price.tiers'])
      const { status, meters } = subscriptions[subscription]!
      const plan = { object: 'subscription_item', id: 'si_plan', quantity: 1, price: { object: 'price', id: 'price_plan', currency: 'usd', billing_scheme: 'per_unit', unit_amount: 14900, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        product: { object: 'product', id: 'prod_plan', name: subscription === 'sub_inn' ? 'Business' : 'Growth', metadata: { plan_id: subscription === 'sub_inn' ? 'business' : 'growth' } } } }
      const items = meters.map(family => ({ object: 'subscription_item', id: `si_${family}`, price: { object: 'price', id: `price_${family}`, product: { object: 'product', id: `prod_${family}`, metadata: { product_family: family } },
        ...(family === 'homes' ? { billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: homesTiers } : {}) } }))
      const trial = status === 'trialing' ? { trial_end: innTrialEnd, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : { trial_end: null, trial_settings: null }
      return Response.json({ object: 'subscription', id: subscription, status, ...trial, customer: `cus_${subscription.slice(4)}`, items: { object: 'list', data: [plan, ...items], has_more: false } })
    }
    // Basic is quoted from the published catalog.
    const catalog = publishedCatalogResponse(url)
    if (catalog) return catalog
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
      // The owner's published host profile: a home is listed only with a host guests can see.
      await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, public_name, public_bio, public_approved, calendar_revision, updated_at, updated_by)
        VALUES (?, ?, 'America/Denver', '[]', '[]', '[]', '2026-10-15T00:00:00.000Z', 'Owner Host', NULL, 1, 'revision', '2026-10-15T00:00:00.000Z', ?)`).bind(`m-${id}`, id, OWNER).run()
      // As Better Auth's webhook writes it from the Stripe subscription.
      if (plan) await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, billingInterval, stripeSubscriptionId, stripeCustomerId, periodEnd) VALUES (?, ?, ?, ?, 1, 'month', ?, ?, ?)")
        .bind(`sub-${id}`, plan, id, subscriptions[`sub_${id}`]!.status, `sub_${id}`, customer, Math.floor(Date.now() / 1000) + 86_400).run()
    }
    const manager = (organizationId: string) => ({ organizationId, actorId: OWNER, manage: true as const })
    const home = (organizationId: string, key: string) => createStayHome(env, db, manager(organizationId), stayHomeInput({
      name: `Home ${key}`, timezone: 'America/Denver', address: `${key} Shore Rd`, city: 'Moab', country: 'US', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1, base_price_minor: 150_00,
    }), key)
    // Published as the dashboard publishes a home: hosted by the owner, then listed.
    const publish = async (organizationId: string, productId: string) => {
      await updateStayHome(env, db, manager(organizationId), productId, { assigned_member_id: `m-${organizationId}` })
      return (await updateStayHome(env, db, manager(organizationId), productId, { published: true })).home
    }
    const withdraw = async (organizationId: string, productId: string) => (await updateStayHome(env, db, manager(organizationId), productId, { published: false })).home
    const place = (organizationId: string, title: string) => createLocation(env, db, organizationId, { title, timezone: 'America/Denver' }, OWNER)
    const homeAt = (organizationId: string, locationId: string, name: string, published = false) => createProduct(db, { env, organizationId, actor, ...(published ? { publication: { published: true } } : {}), product: {
      kind: 'stay', name, variants: [{ name, prices: [{ unit_amount: 150_00, currency: 'USD' }] }],
      stay: { location_id: locationId, check_in_time: '15:00', check_out_time: '11:00', max_guests: 2, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    const reportsFor = (customer: string) => reported.filter(row => row.customer === customer).length

    // ── Business: every active location and every live home is billed; a home is a home, not a location. Nothing is refused.
    await organization('inn', 'business')
    const bistro = await place('inn', 'Bistro')
    assert.equal(bistro.status, 201)
    const bistroId = (bistro.data as { location: { id: string } }).location.id
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 0 })
    const villas = []
    for (const key of ['villa-1', 'villa-2', 'villa-3']) villas.push(await home('inn', key))
    // New homes are drafts: free, and not live.
    assert.deepEqual(villas.map(villa => villa.live), [false, false, false])
    assert.deepEqual(await counts('inn'), { locations: 1, homes: 0 })
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 0 })
    assert.deepEqual((await homesQuote(env, db, 'inn', 3)).homes, { used: 0, drafts: 3, included: 2, additional_price_minor: 0, amount_minor: 0 })
    // Publishing makes each live, billed and reported.
    for (const villa of villas) assert.equal((await publish('inn', villa.product_id)).live, true)
    assert.deepEqual(await counts('inn'), { locations: 1, homes: 3 })
    assert.deepEqual(last('cus_inn'), { locations: 1, homes: 3 })
    assert.equal((await getProduct(db, 'inn', villas[0]!.product_id)).stay!.live, true)
    // A subscription without the homes price is charged nothing for homes: its quote prices each one at 0.
    // In its free trial the quote says when the trial ends, from Stripe: no usage is billed before then.
    const innQuote = await homesQuote(env, db, 'inn', 1)
    assert.deepEqual([innQuote.homes, innQuote.adding, innQuote.billing.trial_end], [
      { used: 3, drafts: 0, included: 2, additional_price_minor: 0, amount_minor: 0 },
      { count: 1, additional_homes: 1, amount_minor: 0, allowed: true },
      '2026-11-22T14:06:27.000Z',
    ])
    // The billing status the plan screen reads says the same trial, and what Stripe does at its end without a card.
    assert.deepEqual((await getOrganizationSubscriptionPrice(env, await getOrganizationBillingStatus(env, db, 'inn')))?.trial, { end: '2026-11-22T14:06:27.000Z', withoutPaymentMethod: 'cancel' })
    // A stay product made at a location makes that location a home's: one fewer location, and one more home once it is live.
    const cabin = await homeAt('inn', bistroId, 'Garden Cabin')
    assert.equal(cabin.stay!.live, false)
    assert.deepEqual(await counts('inn'), { locations: 0, homes: 3 })
    assert.deepEqual(last('cus_inn'), { locations: 0, homes: 3 })
    await publish('inn', cabin.id)
    assert.deepEqual(last('cus_inn'), { locations: 0, homes: 4 })
    // Other offerings are products at a location: adding one or moving it changes no count and reports nothing.
    const before = reportsFor('cus_inn')
    const soup = await createProduct(db, { env, organizationId: 'inn', actor, product: { kind: 'dish', name: 'Soup', variants: [{ name: 'Soup', prices: [{ unit_amount: 9_00, currency: 'USD' }] }] } })
    await setProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id, actor, env })
    await removeProductLocation(db, { organizationId: 'inn', productId: soup.id, locationId: villas[0]!.location_id })
    assert.equal(reportsFor('cus_inn'), before)
    // A home withdrawn from the site is a draft again: off the bill, and reported.
    assert.equal((await withdraw('inn', villas[2]!.product_id)).live, false)
    assert.deepEqual(last('cus_inn'), { locations: 0, homes: 3 })
    await publish('inn', villas[2]!.product_id)
    assert.deepEqual(last('cus_inn'), { locations: 0, homes: 4 })
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
    await publish('grower', (await home('grower', 'g-1')).product_id)
    // The quote a paid host reads before making homes live, priced by the homes price on its own subscription
    // (3 included, $7 after): of four more, two are included and two are billed at the end of the period.
    const growerPeriodEnd = (await db.prepare("SELECT periodEnd FROM subscription WHERE referenceId = 'grower'").first('periodEnd')) as number
    assert.deepEqual(await homesQuote(env, db, 'grower', 4), {
      plan: 'growth', currency: 'USD',
      homes: { used: 1, drafts: 0, included: 3, additional_price_minor: 700, amount_minor: 0 },
      adding: { count: 4, additional_homes: 2, amount_minor: 1400, allowed: true },
      billing: { period_end: new Date(growerPeriodEnd * 1000).toISOString(), trial_end: null, prorated: false },
    })
    for (const key of ['g-2', 'g-3', 'g-4']) await publish('grower', (await home('grower', key)).product_id)
    // With four live, one is billed now and the next would be too.
    assert.deepEqual((await homesQuote(env, db, 'grower', 1)).homes, { used: 4, drafts: 0, included: 3, additional_price_minor: 700, amount_minor: 700 })
    assert.deepEqual((await homesQuote(env, db, 'grower', 1)).adding, { count: 1, additional_homes: 1, amount_minor: 700, allowed: true })
    assert.deepEqual(await counts('grower'), { locations: 3, homes: 4 })
    assert.deepEqual(last('cus_grower'), { locations: 3, homes: 4 })

    // ── Basic includes two locations and two live homes, counted apart, and refuses a third of either; drafts are unlimited. It has no customer and reports nothing.
    await organization('starter', null)
    // Basic's quote: no period, nothing billed, and a home past the included ones not allowed to go live.
    const starterQuote = (used: number, drafts: number, adding: number, allowed: boolean) => ({
      plan: 'free', currency: 'USD',
      homes: { used, drafts, included: 2, additional_price_minor: 900, amount_minor: 0 },
      adding: { count: adding, additional_homes: Math.max(0, used + adding - 2) - Math.max(0, used - 2), amount_minor: allowed ? 0 : 900 * (Math.max(0, used + adding - 2) - Math.max(0, used - 2)), allowed },
      billing: { period_end: null, trial_end: null, prorated: false },
    })
    assert.deepEqual(await homesQuote(env, db, 'starter', 1), starterQuote(0, 0, 1, true))
    for (const title of ['One', 'Two']) assert.equal((await place('starter', title)).status, 201)
    assert.deepEqual(await place('starter', 'Three'), { status: 402, data: {
      error: 'Basic includes 2 locations. Choose Growth or Business in Billing to add more.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    } })
    // Adding homes is never refused: four drafts beside two locations, none billed.
    const starterHomes = []
    for (const key of ['starter-villa-1', 'starter-villa-2', 'starter-villa-3', 'starter-villa-4']) starterHomes.push(await home('starter', key))
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 0 })
    assert.deepEqual(await homesQuote(env, db, 'starter', 1), starterQuote(0, 4, 1, true))
    // Two go live; the third is refused when it is published, and nothing was written.
    for (const made of starterHomes.slice(0, 2)) await publish('starter', made.product_id)
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 2 })
    assert.deepEqual(await homesQuote(env, db, 'starter', 0), starterQuote(2, 2, 0, true))
    assert.deepEqual(await homesQuote(env, db, 'starter', 1), starterQuote(2, 2, 1, false))
    const homeLimit = { status: 402, data: { error: 'Basic includes 2 homes. Choose Growth or Business in Billing to add more.', code: 'HOME_LIMIT', homes: { used: 2, covered: 2 } } }
    await assert.rejects(publish('starter', starterHomes[2]!.product_id), homeLimit)
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM product_publications WHERE product_id = ? AND published = 1').bind(starterHomes[2]!.product_id).first('n'), 0)
    assert.equal((await readStayHome(db, manager('starter'), starterHomes[2]!.product_id)).live, false)
    // A stay product made published at one of the plain locations would be a third live home too; made as a draft it is not refused.
    const one = (await db.prepare("SELECT id FROM business_locations WHERE organization_id = 'starter' AND title = 'One'").first('id')) as string
    await assert.rejects(homeAt('starter', one, 'Attic', true), homeLimit)
    // Withdrawing one frees its place for another.
    await withdraw('starter', starterHomes[1]!.product_id)
    await publish('starter', starterHomes[2]!.product_id)
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 2 })
    // A home's location turned off takes its home off; turning it back on past the included live homes is refused as a home, not a location.
    const starterVilla = starterHomes[0]!.location_id
    assert.equal((await updateLocation(db, 'starter', starterVilla, { status: 'inactive' }, OWNER, env)).status, 200)
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 1 })
    await publish('starter', starterHomes[1]!.product_id)
    assert.deepEqual(await updateLocation(db, 'starter', starterVilla, { status: 'active' }, OWNER, env), homeLimit)
    // A live home turned off and back on past the included homes is refused the same way.
    await updateProduct(db, { env, organizationId: 'starter', productId: starterHomes[1]!.product_id, actor, patch: { active: false } })
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 1 })
    assert.equal((await updateLocation(db, 'starter', starterVilla, { status: 'active' }, OWNER, env)).status, 200)
    await assert.rejects(updateProduct(db, { env, organizationId: 'starter', productId: starterHomes[1]!.product_id, actor, patch: { active: true } }), homeLimit)
    assert.deepEqual(await counts('starter'), { locations: 2, homes: 2 })
    // Deleting a home would make its location a third location: refused as a location while both slots are in use.
    await assert.rejects(deleteProduct(db, { organizationId: 'starter', productId: starterHomes[3]!.product_id, env }), {
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
