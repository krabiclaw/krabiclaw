import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3Event } from 'h3'
import * as schema from '../../server/db/schema.ts'
import { recordTenantPageview } from '../../server/utils/pageview-tracking.ts'
import { createProductBooking } from '../../server/domain/product-bookings.ts'
import { recordOrganizationConversionEvent } from '../../server/utils/organization-conversions.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { listBookableSessions } from '../../server/utils/availability.ts'
import { createStay, setStayNights } from '../../server/domain/stays.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { readInsightsIndex, readInsightsPage, type InsightsReader } from '../../server/domain/insights.ts'
import { handleAnalyticsTools, ANALYTICS_TOOLS } from '../../server/utils/mcp-tools/analytics.ts'
import { addLocalDays, localDateAt, localDateTimeToInstant } from '../../utils/timezone.ts'
import { createTables } from './support/table-product.ts'
import { buyStay } from './support/stay-checkout.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import type { InsightsPage } from '../../shared/insights.ts'

const TZ = 'Asia/Bangkok'

async function openDb(name: string) {
  const runtime = new Miniflare({ workers: [{ config: {
    name, compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: name, exportName: 'Hub' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://insights.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
    NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://insights.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
  return { runtime, db, env }
}

const metrics = (page: InsightsPage) => Object.fromEntries(page.metrics.map(metric => [metric.key, metric.format === 'text' ? metric.text : metric.value]))
const rows = (page: InsightsPage) => page.list.kind === 'rows' ? page.list.rows.map(row => [row.label, ...row.values]) : []

test('Insights reads a restaurant from visit to payment: sources, bookings, value and conversion', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await openDb('insights-tables')
  try {
    const now = new Date().toISOString()
    const open = JSON.stringify({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })
    await db.batch([
      db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, timezone, analytics_data_start_at)
        VALUES ('org-tables', 'Tables', 'tables', 'tables', '{}', 'tenant-theme-v1', 'THB', 'active', 'active', 'flat', 'restaurant', ?, '2000-01-01T00:00:00.000Z')`).bind(TZ),
      db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('tables-en', 'org-tables', 'en', 1, 'published')"),
      db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('tables-owner', 'Owner', 'owner@tables.example', 1, 0, 0)"),
      db.prepare(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m-tables-owner', 'org-tables', 'tables-owner', 'owner', 0)`),
      ...['loc-beach', 'loc-town'].map(id => db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, opening_hours, created_at, updated_at) VALUES (?, 'org-tables', ?, ?, 'active', ?, ?, ?, ?)`)
        .bind(id, id, id === 'loc-beach' ? 'Beach' : 'Town', TZ, open, now, now)),
    ])
    const tables = Object.fromEntries(await Promise.all(['loc-beach', 'loc-town'].map(async locationId => [locationId, await createTables(db, env, {
      organizationId: 'org-tables', locationId, actorId: 'tables-owner', memberId: 'm-tables-owner', name: `Tables ${locationId}`, durationMinutes: 120, seats: 10, open: '18:00', lastSeating: '21:00', currency: 'THB' })])))
    const today = localDateAt(new Date(), TZ)
    const dinnerDate = addLocalDays(today, 2)
    const seating = async (locationId: string) => {
      const at = localDateTimeToInstant(dinnerDate, '19:00', TZ, 'reject').toISOString()
      const [found] = await listBookableSessions(db, { env, organizationId: 'org-tables', productId: tables[locationId]!.id, fromInstant: at, toInstant: new Date(Date.parse(at) + 60_000).toISOString() })
      assert.equal(found?.starts_at, at)
      return found!.id
    }
    // Two visitors: one from a Google ad who opens the beach's tables, one typing the address who opens the town's.
    const visitor = (n: number) => ({ session: `3333333${n}-3333-4333-8333-333333333333`, visitor: `4444444${n}-4444-4444-8444-444444444444` })
    const arrivals = [{ ...visitor(1), locationId: 'loc-beach', attribution: { gclid: 'ad-click' } }, { ...visitor(2), locationId: 'loc-town', attribution: {} }]
    for (const [index, arrival] of arrivals.entries()) {
      const base = { organizationId: 'org-tables', timezone: TZ, locale: 'en', referrerHost: null, internalHosts: ['tables.example'], userAgent: 'Desktop', ipHash: 'h',
        sessionId: arrival.session, visitorId: arrival.visitor, country: 'th', region: null, city: null, locationId: arrival.locationId, pageId: null, recipe: null, now }
      await recordTenantPageview(db, { ...base, eventId: `pv-home-${index}`, pagePath: '/', attribution: arrival.attribution, pageType: 'home' })
      await recordTenantPageview(db, { ...base, eventId: `pv-tables-${index}`, pagePath: `/reservations/${arrival.locationId}`, attribution: {}, pageType: 'product', productId: tables[arrival.locationId]!.id })
    }
    const [ad, direct] = arrivals.map(arrival => ({ headers: new Headers({ cookie: `kc_session_id=${arrival.session}; kc_visitor_id=${arrival.visitor}`, 'user-agent': 'Desktop' }) }))
    // Each visitor books a table on the site; the owner adds a third by hand.
    const guestEvent = (origin: { headers: Headers }) => new H3Event(Object.assign(new Request('https://tables.example/api/products', { headers: origin.headers }), { runtime: { cloudflare: { env } } }))
    const book = async (origin: { headers: Headers } | null, locationId: string, email: string, key: string) => {
      const result = await createProductBooking(origin ? guestEvent(origin) : new H3Event(Object.assign(new Request('https://tables.example/api/mcp'), { runtime: { cloudflare: { env } } })), {
        organizationId: 'org-tables', slug: tables[locationId]!.slug, financialWritesAllowed: false,
        ...(origin ? {} : { operator: { userId: 'tables-owner', idempotencyKey: key, source: 'operator', externalReference: null, guestAcknowledgement: false } }),
        body: { guest_name: 'Guest', guest_email: email, guest_phone: '+66812345678', product_session_id: await seating(locationId), party_size: key === 'town' ? 4 : 2, ...(origin ? { idempotency_key: key } : {}) } })
      assert.equal(result.status, 201, JSON.stringify(result.body))
      return { requestId: String(result.body.conversation_id), bookingId: String(result.body.booking_id) }
    }
    const beach = await book(ad, 'loc-beach', 'beach@tables.example', 'beach')
    const town = await book(direct, 'loc-town', 'town@tables.example', 'town')
    const entered = await book(null, 'loc-beach', 'entered@tables.example', 'entered')
    // The booking keeps how its guest arrived, read back from the row; one the owner added has none.
    assert.deepEqual((await db.prepare('SELECT id, website_source FROM bookings ORDER BY id').all<{ id: string; website_source: string | null }>()).results
      .map(row => [row.id, row.website_source]).sort(), [[beach.bookingId, 'Google Ads'], [town.bookingId, 'Direct'], [entered.bookingId, null]].sort())
    const cancelled = await executeGuestThreadOperation(db, { threadId: town.requestId, organizationId: 'org-tables', action: 'cancel', actorUserId: 'tables-owner', idempotencyKey: 'cancel-town', env, financialWritesAllowed: false })
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
    for (const [paymentId, bookingId, collected, refunded] of [['pay-entered', entered.bookingId, 160500, 0], ['pay-beach', beach.bookingId, 53500, 3500]] as const) {
      await db.prepare(`INSERT INTO payments (id, organization_id, stripe_account_id, livemode, subject_type, subject_id, location_id, currency, amount, captured_amount, refunded_amount, price_snapshot_json, created_at, updated_at)
        VALUES (?, 'org-tables', 'acct_tables', 0, 'booking', ?, 'loc-beach', 'THB', ?, ?, ?, '{}', ?, ?)`).bind(paymentId, bookingId, collected, collected, refunded, now, now).run()
    }

    const reader: InsightsReader = { organizationId: 'org-tables', timezone: TZ, defaultCurrency: 'THB', userId: 'tables-owner', analytics: true }
    const range = { start_date: addLocalDays(today, -1), end_date: addLocalDays(today, 3) }
    const read = (page: string, query: Record<string, string> = {}) => readInsightsPage(db as never, reader, page, { ...range, ...query })
    const index = await readInsightsIndex(db as never, reader)
    assert.deepEqual(index, { kinds: ['table'], has_menu: false, locations: [{ id: 'loc-beach', title: 'Beach' }, { id: 'loc-town', title: 'Town' }], pages: index.pages })
    assert.equal(index.pages.length, 17)

    const bookings = await read('rates/bookings')
    assert.equal(bookings.title, 'Reservations')
    assert.equal(bookings.section, 'Bookings & rates')
    assert.deepEqual(metrics(bookings), { confirmed: 2, requested: 3, confirmed_share: 66.7 })
    const dinner = bookings.series.dates.indexOf(dinnerDate)
    assert.deepEqual([bookings.series.values.confirmed![dinner], bookings.series.values.requested![dinner], bookings.series.values.requested![0]], [2, 3, 0])
    assert.deepEqual(rows(bookings).sort(), [[`Tables loc-beach`, 2, 2], [`Tables loc-town`, 0, 1]])
    assert.deepEqual(metrics(await read('rates/bookings', { location_id: 'loc-town' })), { confirmed: 0, requested: 1, confirmed_share: 0 })

    assert.deepEqual(metrics(await read('rates/cancellation-rate')), { cancellation_rate: 33.3, cancelled: 1, bookings: 3 })
    assert.deepEqual(metrics(await read('rates/party-size')), { average_party: 2, largest_party: 2 })
    const value = await read('rates/average-value')
    assert.equal(value.currency, 'THB')
    assert.deepEqual(metrics(value), { average_value: 105250, income: 210500 })
    const income = await read('rates/income-by-channel')
    assert.deepEqual(metrics(income), { income: 210500, direct: 210500, refunded: 3500 })
    assert.deepEqual(rows(income), [['Direct', 210500]])

    // The ad visitor calls the beach twice and follows a dish's order link once: each click's own write counts it.
    const click = (id: string, eventName: 'phone_click' | 'product_order_external_click') => recordOrganizationConversionEvent(db, ad, {
      organizationId: 'org-tables', eventName, stage: 'external_handoff', surface: 'website', id, timezone: TZ,
      ...(eventName === 'product_order_external_click' ? { entityType: 'product', entityId: tables['loc-beach']!.id } : {}) })
    await click('55555551-5555-4555-8555-555555555555', 'phone_click')
    await click('55555552-5555-4555-8555-555555555555', 'phone_click')
    await click('55555553-5555-4555-8555-555555555555', 'product_order_external_click')
    const conversion = await read('conversion/booking-conversion')
    assert.deepEqual(metrics(conversion), { conversion: 100, views: 2, bookings: 2, clicked_to_call: 2, clicked_to_order: 1 })
    assert.deepEqual(conversion.metrics.slice(3).map(metric => metric.label), ['Clicked to call', 'Clicked to order'])
    assert.equal(conversion.series.values.clicked_to_call![conversion.series.dates.indexOf(today)], 2)
    // A restaurant's site has no click to book; clicks are not about one kind, so a kind's page has none.
    assert.deepEqual(metrics(await read('conversion/booking-conversion', { kind: 'table' })), { conversion: 100, views: 2, bookings: 2 })
    assert.equal(conversion.metrics[1]!.label, 'Table page views')
    const lead = await read('conversion/lead-time')
    assert.equal(lead.subtitle, 'Website bookings')
    assert.deepEqual(metrics(lead), { average_lead: 2, within_3_days: 100 })
    const returning = await read('conversion/returning')
    assert.equal(returning.title, 'Returning diners')
    assert.deepEqual(metrics(returning), { returning_share: 0, returning: 0 })

    const views = await read('conversion/page-views')
    assert.deepEqual(metrics(views), { page_views: 4, change: null })
    assert.equal(views.series.values.page_views![views.series.dates.indexOf(today)], 4)
    const top = await read('conversion/top-pages')
    assert.deepEqual(metrics(top), { page_views: 4, pages_viewed: 3, most_viewed: '/' })
    assert.deepEqual(rows(top), [['/', 2], ['/reservations/loc-beach', 1], ['/reservations/loc-town', 1]])
    const sources = await read('conversion/sources')
    assert.deepEqual(metrics(sources), { visits: 2, website_bookings: 2, search_bookings: 0 })
    assert.deepEqual(rows(sources), [['Google Ads', 1, 1], ['Direct', 1, 1], ['Added by you', 0, 1]])

    // A page reads only the filters it has; a kind it does not describe is refused.
    await assert.rejects(read('conversion/page-views', { kind: 'table' }), (error: { statusCode?: number }) => error.statusCode === 400)
    await assert.rejects(read('rates/occupancy-rate', { kind: 'table' }), (error: { statusCode?: number }) => error.statusCode === 400)
    await assert.rejects(read('conversion/booking-conversion', { location_id: 'loc-beach' }), (error: { statusCode?: number }) => error.statusCode === 400)
    await assert.rejects(read('marketing/instagram'), (error: { statusCode?: number }) => error.statusCode === 404)

    // MCP reads the same page, and its schema has none of the old report's sessions, devices or funnel.
    const tool = await handleAnalyticsTools({ toolName: 'get_organization_analytics', args: { page: 'conversion/sources', ...range }, organization: { db, organizationId: 'org-tables', env } } as never)
    assert.deepEqual(tool, sources)
    const schemaText = JSON.stringify(ANALYTICS_TOOLS.find(definition => definition.name === 'get_organization_analytics'))
    for (const removed of ['unique_sessions', 'pages_per_session', 'avg_session_duration', 'returning_visitors', 'devices', 'countries', 'cities', 'referrers', 'funnel', 'signup_cohort']) {
      assert.equal(schemaText.includes(`"${removed}"`), false, removed)
    }
    assert.equal(JSON.stringify(sources).includes('sessions'), false)
  } finally { await runtime.dispose() }
})

test('Insights reads a home: occupancy, length of stay and nightly rate, and who added each stay', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await openDb('insights-stays')
  try {
    for (const statement of [
      `INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone, vertical, theme_id, analytics_data_start_at) VALUES ('org-stays', 'Retreat', 'retreat', 'retreat', 'USD', '${TZ}', 'lodging', 'tenant-theme-v1', '2000-01-01T00:00:00.000Z')`,
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('stays-en', 'org-stays', 'en', 1, 'published')",
      "INSERT INTO user (id, name, email) VALUES ('stays-owner', 'Owner', 'owner@stays.example')",
      "INSERT INTO member (id, organizationId, userId, role) VALUES ('m-stays-owner', 'org-stays', 'stays-owner', 'owner')",
      `INSERT INTO business_locations (id, organization_id, slug, title, timezone, status) VALUES ('loc-stays', 'org-stays', 'retreat', 'Retreat', '${TZ}', 'active')`,
    ]) await db.prepare(statement).run()
    const access = { organizationId: 'org-stays', actorId: 'stays-owner', manage: true }
    const home = await createProduct(db, { env, organizationId: 'org-stays', actor: { actorId: 'stays-owner' }, publication: { published: true }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15000, currency: 'USD' }] }],
      stay: { location_id: 'loc-stays', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: 'm-stays-owner' },
    } })
    const today = localDateAt(new Date(), TZ)
    // The host adds a three-night stay; a guest buys two nights on the site; the host closes two more.
    await createStay(db, env, access, { product_id: home.id, idempotency_key: 'host-stay', check_in_date: addLocalDays(today, 5), check_out_date: addLocalDays(today, 8),
      adults: 2, guest_name: 'Bo', guest_email: 'bo@stays.example', total_minor: 36000 })
    const signed = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
    const bought = await buyStay(db, { id: 'bought', organizationId: 'org-stays', productId: home.id, locationId: 'loc-stays', timezone: TZ,
      checkIn: addLocalDays(today, 10), checkOut: addLocalDays(today, 12), adults: 2, nightlyMinor: 12000, currency: 'USD', buyerUserId: signed.response!.user.id,
      guest: { name: 'Ana', email: 'ana@stays.example', phone: null, notes: null } })
    await setStayNights(db, env, access, { product_id: home.id, from: addLocalDays(today, 15), to: addLocalDays(today, 17), closed: true })
    // A checkout guest with no analytics session arrived from a source nobody recorded; the host's stay has none.
    assert.deepEqual((await db.prepare('SELECT id, website_source FROM bookings').all<{ id: string; website_source: string | null }>()).results.map(row => [row.id === bought.id, row.website_source]).sort(),
      [[false, null], [true, 'Not recorded']])

    const reader: InsightsReader = { organizationId: 'org-stays', timezone: TZ, defaultCurrency: 'USD', userId: 'stays-owner', analytics: true }
    const read = (page: string) => readInsightsPage(db as never, reader, page, { start_date: today, end_date: addLocalDays(today, 19) })
    const occupancy = await read('rates/occupancy-rate')
    assert.equal(occupancy.section, 'Occupancy & rates')
    // 20 nights, 2 closed: 5 of 18 open nights booked.
    assert.deepEqual(metrics(occupancy), { occupancy: 27.8, nights_booked: 5, nights_blocked: 2 })
    assert.equal(occupancy.series.values.occupancy![15], null)
    assert.equal(occupancy.series.values.occupancy![5], 100)
    assert.deepEqual(rows(occupancy), [['Cabin', 27.8, 5]])
    assert.deepEqual(metrics(await read('rates/length-of-stay')), { average_nights: 2.5, longest: 3 })
    const nightly = await read('rates/nightly-rate')
    assert.equal(nightly.currency, 'USD')
    assert.deepEqual(metrics(nightly), { nightly_rate: 12000, income: 60000 })
    assert.deepEqual(metrics(await read('rates/income-by-channel')), { income: 24000, direct: 24000, refunded: 0 })
    const sources = await read('conversion/sources')
    assert.deepEqual(rows(sources), [['Not recorded', 0, 1], ['Added by you', 0, 1]])
    assert.equal((await read('conversion/returning')).title, 'Returning guests')
    // A home's site lists a phone but has no consultation button or order link: only calls are counted beside its bookings.
    assert.deepEqual(metrics(await read('conversion/booking-conversion')), { conversion: null, views: 0, bookings: 1, clicked_to_call: 0 })
  } finally { await runtime.dispose() }
})
