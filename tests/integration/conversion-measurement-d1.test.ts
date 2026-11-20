import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { captureEvents } from './support/events.ts'
import { handleStripeGa4Event, withdrawStripeGaIdentifiers } from '../../server/utils/stripe-ga4.ts'
import { deliverViaMeasurementProtocol, readGa4Delivery, recordZarazPageviewReceipt, zarazPageviewDelivery } from '../../server/utils/ga4-delivery.ts'
import { PLATFORM_SITE } from '../../utils/site-routing.ts'
import { originatingOwnerId, recordAndDeliverConversion, recordOrganizationConversionEvent as recordAt, type OrganizationConversionInput } from '../../server/utils/organization-conversions.ts'
import { recordTenantPageview, type TenantPageviewInput } from '../../server/utils/pageview-tracking.ts'
import { completeOnboarding } from '../../server/utils/organization-provisioning.ts'
import { hashEmail } from '../../server/utils/email-delivery.ts'
import { applySchema } from './support/schema.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const VISITOR = '22222222-2222-4222-8222-222222222222'
// Events are recorded inside the reported range, at their own occurrence time.
const recordOrganizationConversionEvent = (db: Parameters<typeof recordAt>[0], origin: Parameters<typeof recordAt>[1], input: OrganizationConversionInput) =>
  recordAt(db, origin, { occurredAt: '2026-09-10T04:00:00.000Z', ...input })
const browser = { headers: new Headers({ cookie: `kc_session_id=${SESSION}; kc_visitor_id=${VISITOR}`, 'user-agent': 'Desktop' }) }

async function openDb() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'conversion-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'conversion-proof', exportName: 'Hub' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  await applySchema(db)
  return { runtime, db }
}

test('conversion measurement: contract, values and idempotency on D1', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    const settings = '{}'
    for (const id of ['org-platform', 'org-customer']) {
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone, analytics_data_start_at) VALUES (?, ?, ?, ?, ?, 'USD', 'Asia/Bangkok', '2000-01-01T00:00:00.000Z')`).bind(id, id, id, id, settings).run()
    }
    for (const id of ['user-a', 'user-b']) {
      await db.prepare(`INSERT INTO user (id, name, email) VALUES (?, ?, ?)`).bind(id, id, `${id}@example.com`).run()
    }
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m1', 'org-customer', 'user-a', 'owner')`).run()

    // A visitor lands from a campaign; their signup carries that session's snapshot.
    const landing: TenantPageviewInput = {
      eventId: 'pv-1', organizationId: 'org-platform', timezone: 'Asia/Bangkok', pagePath: '/', locale: 'en', referrerHost: null,
      attribution: { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'launch', utm_content: 'video-a' },
      internalHosts: ['platform.example'], userAgent: 'Desktop', ipHash: 'h', sessionId: SESSION, visitorId: VISITOR,
      country: 'th', region: null, city: null, locationId: null, pageId: null, pageType: 'home', recipe: null, now: '2026-09-10T03:00:00.000Z',
    }
    await recordTenantPageview(db, landing)

    const signup = { organizationId: 'org-platform', eventName: 'sign_up', stage: 'completed', surface: 'auth', entityType: 'user', entityId: 'user-a' } as const
    const [first, second] = await Promise.all([recordOrganizationConversionEvent(db, browser, signup), recordOrganizationConversionEvent(db, browser, signup)])
    assert.equal(first.id, second.id, 'a repeated signup returns the persisted identity')
    assert.equal([first.created, second.created].filter(Boolean).length, 1)
    const snapshot = JSON.parse(await db.prepare("SELECT payload_json FROM analytics_events WHERE id = ?").bind(first.id).first<string>('payload_json') ?? '{}')
    assert.equal(snapshot.attribution.campaign, 'launch')
    assert.equal(snapshot.attribution.content, 'video-a')

    // No visitor context: a nonbrowser outcome, never a minted session.
    const onboarding = await recordOrganizationConversionEvent(db, null, { organizationId: 'org-platform', eventName: 'onboarding_complete', stage: 'completed', surface: 'dashboard', entityType: 'organization', entityId: 'org-customer', metadata: { originating_user_id: 'user-a' } })
    const onboardingRow = await db.prepare("SELECT session_id, visitor_id, json_extract(payload_json, '$.attribution') attribution FROM analytics_events WHERE id = ?").bind(onboarding.id).first<Record<string, unknown>>()
    assert.deepEqual(onboardingRow, { session_id: null, visitor_id: null, attribution: null })
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_summaries WHERE kind = 'session'").first('count(*)'), 1)

    // Purchases: value excludes tax, collected includes it; a redelivery is the same event.
    const purchase = {
      organizationId: 'org-platform', eventName: 'purchase', stage: 'completed', surface: 'stripe', entityType: 'invoice', entityId: 'in_1',
      occurredAt: '2026-09-11T03:00:00.000Z',
      value: { basis: 'purchase', amount_minor: 4900, collected_minor: 5243, currency: 'USD', transaction_id: 'in_1' },
      // The checkout observed this campaign; the webhook that records the payment carries it.
      attribution: { touch: { source: 'meta', medium: 'paid', campaign: 'launch', term: null, content: 'video-a', referrerHost: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null }, attributedAt: '2026-09-10T03:30:00.000Z' },
      metadata: { purchase_type: 'initial_subscription', subscribing_organization_id: 'org-customer', originating_user_id: 'user-a' },
    } as const
    const paid = await recordOrganizationConversionEvent(db, null, purchase)
    assert.deepEqual(await recordOrganizationConversionEvent(db, null, purchase), { id: paid.id, created: false })

    // Two partial refunds of one invoice are two events; a redelivered refund is not a third.
    const refund = (id: string, amount: number) => ({ organizationId: 'org-platform', eventName: 'refund', stage: 'completed', surface: 'stripe', entityType: 'refund', entityId: id, value: { basis: 'refund', amount_minor: amount, collected_minor: amount, currency: 'USD', transaction_id: 'in_1' }, attribution: purchase.attribution, metadata: { originating_user_id: 'user-a' } }) as const
    await recordOrganizationConversionEvent(db, null, refund('re_1', 1000))
    await recordOrganizationConversionEvent(db, null, refund('re_2', 500))
    await recordOrganizationConversionEvent(db, null, refund('re_1', 1000))
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'refund'").first('count(*)'), 2)

    // The catalog refuses values an event cannot carry and unpriced purchases.
    await assert.rejects(recordOrganizationConversionEvent(db, null, { ...signup, entityId: 'user-b', value: { basis: 'purchase', amount_minor: 1, currency: 'USD', transaction_id: 'x' } }), /cannot carry/)
    await assert.rejects(recordOrganizationConversionEvent(db, null, { ...purchase, entityId: 'in_2', value: { basis: 'purchase', amount_minor: 1, currency: 'USD' } }), /transaction identity/)
    // The schema refuses a conversion that is neither a full browser event nor a full nonbrowser one.
    await assert.rejects(db.prepare(`INSERT INTO analytics_events (id, kind, organization_id, session_id, visitor_id, payload_json)
      VALUES ('mixed', 'conversion', 'org-platform', 's', NULL, '{"event_name":"sign_up","stage":"completed","attribution":null,"attributed_at":null}')`).run(), /CHECK constraint failed/)

    // A priced and an unpriced booking on a customer site: value is known or absent, never invented.
    await recordOrganizationConversionEvent(db, null, { organizationId: 'org-customer', eventName: 'booking_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: 'req-1', pageType: 'product',
      value: { basis: 'quoted', amount_minor: 240000, currency: 'THB', items: [{ item_id: 'prod-1', item_name: 'Pottery', item_variant: 'Adult', amount_minor: 240000, quantity: 2 }] } })
    await recordOrganizationConversionEvent(db, null, { organizationId: 'org-customer', eventName: 'booking_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: 'req-2', pageType: 'product' })

    // The purchase without a browser carries the checkout's campaign; the booking quotes keep their value or none.
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'purchase' AND session_id IS NULL AND json_extract(payload_json, '$.attribution.campaign') = 'launch'").first('count(*)'), 1)
    assert.deepEqual((await db.prepare(`SELECT payload_json ->> '$.entity_id' AS request, payload_json ->> '$.value.amount_minor' AS quoted FROM analytics_events
      WHERE organization_id = 'org-customer' AND (payload_json ->> '$.event_name') = 'booking_submit' ORDER BY request`).all()).results, [{ request: 'req-1', quoted: 240000 }, { request: 'req-2', quoted: null }])


  } finally { await runtime.dispose() }
})

test('consent is enforced for GA delivery and withdrawal erases stored identifiers', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  const realFetch = globalThis.fetch
  const sent: string[] = []
  try {
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, "stripeCustomerId", default_currency, timezone) VALUES
      ('org-platform', 'p', 'p', 'p', '{}', NULL, 'USD', 'Asia/Bangkok'),
      ('org-customer', 'c', 'c', 'c', '{}', 'cus_1', 'USD', 'Asia/Bangkok')`).run()
    await db.prepare(`INSERT INTO organization_integrations (id, organization_id, provider, account_id, target_id, target_name, measurement_id, revision) VALUES ('ga-platform', 'org-platform', 'google_analytics', 'google-account', '1', 'Platform', 'G-TEST', 'r1')`).run()
    await db.prepare(`INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES ('d1', 'org-platform', 'platform.example', 'subdomain', 'canonical', 'active')`).run()
    for (const id of ['user-a', 'user-b']) await db.prepare(`INSERT INTO user (id, name, email) VALUES (?, ?, ?)`).bind(id, id, `${id}@example.com`).run()
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m1', 'org-customer', 'user-a', 'owner')`).run()
    globalThis.fetch = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(null, { status: 204 }) }) as typeof fetch
    const signup = (id: string) => ({ organizationId: 'org-platform', eventName: 'sign_up', stage: 'completed', surface: 'auth', entityType: 'user', entityId: id } as const)
    const request = (consent: string | null) => ({ headers: new Headers({ cookie: `_ga=GA1.1.111.222${consent === null ? '' : `; kc_analytics_consent=${encodeURIComponent(consent)}`}` }) })
    const deliveryOf = async (id: string) => JSON.parse(await db.prepare("SELECT json_extract(payload_json, '$.ga4_delivery') d FROM analytics_events WHERE id = ?").bind(id).first<string>('d') ?? 'null')

    // The identifier alone (the _ga cookie) is not consent; rejection sends nothing; acceptance sends once.
    const noAnswer = await recordAndDeliverConversion({ GA4_API_SECRET: 'secret' }, db, request(null), signup('user-a'))
    const rejected = await recordAndDeliverConversion({ GA4_API_SECRET: 'secret' }, db, request('{"kc_analytics":false}'), signup('user-b'))
    assert.deepEqual([(await deliveryOf(noAnswer.id)).status, (await deliveryOf(rejected.id)).status], ['no_consent_context', 'consent_rejected'])
    assert.equal(sent.length, 0)
    await recordTenantPageview(db, { eventId: 'browser-pageview', organizationId: 'org-platform', timezone: 'Asia/Bangkok', sessionId: SESSION, visitorId: VISITOR,
      pagePath: '/', locale: 'en', referrerHost: null, attribution: {}, internalHosts: ['platform.example'], userAgent: 'Desktop', ipHash: 'h',
      country: null, region: null, city: null, locationId: null, pageId: null, pageType: null, recipe: null, now: '2026-09-10T03:00:00.000Z' })
    // A consenting visitor's pageview is handed to Zaraz by the browser; the browser's receipt is the record, once.
    const handoff = { eventId: 'browser-pageview', organizationId: 'org-platform', sessionId: SESSION, cookieHeader: `kc_analytics_consent=${encodeURIComponent('{"kc_analytics":true}')}` }
    assert.deepEqual(await zarazPageviewDelivery(db, handoff), { dispatch: true })
    assert.equal(await readGa4Delivery(db, handoff.eventId), null)
    assert.equal(await recordZarazPageviewReceipt(db, { ...handoff, sessionId: 'other-session', status: 'dispatched' }), false)
    assert.equal(await recordZarazPageviewReceipt(db, { ...handoff, status: 'dispatched' }), true)
    assert.equal((await readGa4Delivery(db, handoff.eventId))?.status, 'dispatched')
    assert.equal(await recordZarazPageviewReceipt(db, { ...handoff, status: 'failed' }), false)
    assert.equal((await readGa4Delivery(db, handoff.eventId))?.status, 'dispatched')
    // A visitor who declined is not handed over, and the pageview says why.
    await recordTenantPageview(db, { eventId: 'declined-pageview', organizationId: 'org-platform', timezone: 'Asia/Bangkok', sessionId: SESSION, visitorId: VISITOR,
      pagePath: '/', locale: 'en', referrerHost: null, attribution: {}, internalHosts: ['platform.example'], userAgent: 'Desktop', ipHash: 'h',
      country: null, region: null, city: null, locationId: null, pageId: null, pageType: null, recipe: null, now: '2026-09-10T03:01:00.000Z' })
    assert.deepEqual(await zarazPageviewDelivery(db, { ...handoff, eventId: 'declined-pageview', cookieHeader: `kc_analytics_consent=${encodeURIComponent('{"kc_analytics":false}')}` }), { dispatch: false, status: 'consent_rejected' })
    assert.equal((await readGa4Delivery(db, 'declined-pageview'))?.status, 'consent_rejected')
    // The native events exist regardless of the consent decision.
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'sign_up'").first('count(*)'), 2)
    const accepted = await recordAndDeliverConversion({ GA4_API_SECRET: 'secret' }, db, request('{"kc_analytics":true}'), { ...signup('user-c') })
    assert.equal((await deliveryOf(accepted.id)).status, 'sent')
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /measurement_id=G-TEST/)

    // A Measurement Protocol delivery records Google's answer on the event: sent, or the failure.
    const pending = await recordAt(db, null, signup('user-direct'))
    const input = { eventId: pending.id, organizationId: 'org-platform', event: { name: 'sign_up', params: {} },
      clientId: '111.222', userId: null, sessionId: null, sessionCapturedAt: null }
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch
    assert.equal((await deliverViaMeasurementProtocol({ GA4_API_SECRET: 'secret' }, db, input)).status, 'sent')
    assert.equal((await readGa4Delivery(db, pending.id))?.status, 'sent')
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch
    const refused = await recordAt(db, null, signup('user-refused'))
    assert.deepEqual(await deliverViaMeasurementProtocol({ GA4_API_SECRET: 'secret' }, db, { ...input, eventId: refused.id }), { transport: 'measurement_protocol', status: 'failed', detail: 'measurement_protocol_503' })
    assert.equal((await readGa4Delivery(db, refused.id))?.status, 'failed')

    // Withdrawal erases what checkout stored for this user, only where they captured it.
    await db.prepare(`INSERT INTO stripe_ga4_subscription_intents (id, organization_id, user_id, action, client_id, session_id, session_captured_at, expires_at)
      VALUES ('i1', 'org-customer', 'user-a', 'initial_subscription', '111.222', '9', 1, '2027-01-01T00:00:00.000Z'),
             ('i2', 'org-customer', 'user-b', 'initial_subscription', '333.444', '9', 1, '2027-01-01T00:00:00.000Z')`).run()
    const updates: Array<Record<string, unknown>> = []
    const stripe = {
      customers: {
        retrieve: async () => ({ deleted: false, metadata: { user_id: 'user-a', ga_client_id: '111.222', keep: 'x' } }),
        update: async (_id: string, body: { metadata: Record<string, unknown> }) => { updates.push({ customer: body.metadata }) },
      },
      subscriptions: {
        list: () => (async function* () {
          yield { id: 'sub_mine', metadata: { user_id: 'user-a', ga_client_id: '111.222', ga_session_id: '9', other: 'y' } }
          yield { id: 'sub_theirs', metadata: { user_id: 'user-b', ga_client_id: '333.444' } }
        })(),
        update: async (id: string, body: { metadata: Record<string, unknown> }) => { updates.push({ [id]: body.metadata }) },
      },
    } as never
    await withdrawStripeGaIdentifiers(db, () => stripe, 'user-a')
    assert.deepEqual(updates, [{ customer: { ga_client_id: '' } }, { sub_mine: { ga_client_id: '', ga_session_id: '' } }])
    assert.deepEqual((await db.prepare('SELECT id, client_id, session_id FROM stripe_ga4_subscription_intents ORDER BY id').all()).results,
      [{ id: 'i1', client_id: null, session_id: null }, { id: 'i2', client_id: '333.444', session_id: '9' }])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('the Stripe handler records every paid subscription invoice and refund once, with checkout attribution', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  const realFetch = globalThis.fetch
  const sent: string[] = []
  try {
    const timezone = '{}'
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, status, onboarding_status, default_currency, timezone) VALUES
      ('org-platform', 'p', 'p', 'p', ?, ?, 'active', 'active', 'USD', 'Asia/Bangkok')`).bind(timezone, PLATFORM_SITE.themeId).run()
    await db.prepare(`INSERT INTO organization_integrations (id, organization_id, provider, account_id, target_id, target_name, measurement_id, revision) VALUES ('ga-platform', 'org-platform', 'google_analytics', 'google-account', '1', 'Platform', 'G-TEST', 'r1')`).run()
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES ('org-customer', 'c', 'c', 'c', ?, 'USD', 'Asia/Bangkok')`).bind(timezone).run()
    await db.prepare(`INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES ('d1', 'org-platform', 'platform.example', 'subdomain', 'canonical', 'active')`).run()
    await db.prepare(`INSERT INTO user (id, name, email) VALUES ('founder', 'f', 'f@example.com')`).run()
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m1', 'org-customer', 'founder', 'owner')`).run()
    // Checkout began with a consenting visitor from a campaign.
    await db.prepare(`INSERT INTO stripe_ga4_subscription_intents (id, organization_id, user_id, action, client_id, session_id, session_captured_at, attribution_json, expires_at)
      VALUES ('intent-1', 'org-customer', 'founder', 'initial_subscription', '111.222', '9', ${Math.floor(Date.now() / 1000)}, ?, '2099-01-01T00:00:00.000Z')`)
      .bind(JSON.stringify({ touch: { source: 'meta', medium: 'paid', campaign: 'launch', term: null, content: 'video-a', referrerHost: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null }, attributedAt: '2026-09-10T03:30:00.000Z' })).run()
    globalThis.fetch = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(null, { status: 204 }) }) as typeof fetch

    const price = { id: 'price_1', unit_amount: 4900, nickname: null, product: { name: 'Growth', deleted: false }, recurring: { interval: 'month', interval_count: 1 } }
    const line = { id: 'il_1', type: 'subscription', amount: 4900, quantity: 1, subscription: 'sub_1', price }
    const invoices = new Map<string, Record<string, unknown>>()
    const makeInvoice = (id: string, created: number, billingReason: string) => {
      const value = { id, created, billing_reason: billingReason, currency: 'usd', customer: 'cus_1', subscription: 'sub_1', amount_paid: 5243, total_excluding_tax: 4900, status_transitions: { paid_at: created } }
      invoices.set(id, value)
      return value
    }
    const history = [{ id: 'in_trial', amount_paid: 0, created: 1_000, status_transitions: { paid_at: 1_000 } }]
    const stripe = {
      subscriptions: {
        retrieve: async () => ({ id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { referenceId: 'org-customer' }, items: { data: [{ price, quantity: 1 }] } }),
        update: async () => ({}),
      },
      customers: { retrieve: async () => ({ deleted: false, metadata: { customerType: 'organization', organizationId: 'org-customer' } }) },
      invoices: {
        list: () => (async function* () { for (const item of history) yield item })(),
        listLineItems: async () => ({ data: [line], has_more: false }),
        retrieve: async (id: string) => invoices.get(id),
      },
      prices: { retrieve: async () => price },
      charges: { retrieve: async () => ({ invoice: null }) },
    } as never
    const env = { GA4_API_SECRET: 'secret', EVENTS: captureEvents().binding } as never
    const paid = (invoice: Record<string, unknown>, eventId: string) => handleStripeGa4Event(env, db, stripe, { id: eventId, type: 'invoice.paid', data: { object: invoice } } as never)
    const purchases = async () => (await db.prepare(`SELECT id, json_extract(payload_json, '$.metadata.purchase_type') type, json_extract(payload_json, '$.attribution.campaign') campaign,
      json_extract(payload_json, '$.metadata.originating_user_id') owner, json_extract(payload_json, '$.value.amount_minor') value, json_extract(payload_json, '$.value.collected_minor') cash, session_id,
      json_extract(payload_json, '$.ga4_delivery.status') delivery FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'purchase' ORDER BY created_at, id`).all()).results

    // First positive payment after a zero-value trial arrives as a cycle and is the first paid conversion, attributed to the checkout's campaign.
    const first = makeInvoice('in_1', 2_000, 'subscription_cycle')
    await paid(first, 'evt_1')
    await paid(first, 'evt_1_redelivered')
    const rows = await purchases()
    assert.equal(rows.length, 1)
    assert.deepEqual({ ...rows[0], id: undefined }, { id: undefined, type: 'initial_subscription', campaign: 'launch', owner: 'founder', value: 4900, cash: 5243, session_id: null, delivery: 'sent' })
    assert.equal(sent.length, 1, 'a redelivered invoice does not send a second GA event')

    // The customer cancels and later starts a new subscription: still revenue, classified apart from acquisition.
    history.push({ id: 'in_1', amount_paid: 5243, created: 2_000, status_transitions: { paid_at: 2_000 } })
    await paid(makeInvoice('in_2', 5_000, 'subscription_create'), 'evt_2')
    assert.deepEqual((await purchases()).map(row => row.type), ['initial_subscription', 'resubscription'])

    await paid(makeInvoice('in_renewal', 6_000, 'subscription_cycle'), 'evt_renewal')
    await paid(makeInvoice('in_change', 7_000, 'subscription_update'), 'evt_change')
    assert.deepEqual((await purchases()).filter(row => row.type === 'subscription_renewal' || row.type === 'plan_change')
      .map(row => [row.type, row.campaign]), [['subscription_renewal', null], ['plan_change', null]])

    // A partial refund reverses the first purchase on its own basis and campaign; a redelivery is the same event.
    const refund = { id: 're_1', amount: 1_000, status: 'succeeded', charge: 'ch_1', payment_intent: null, currency: 'usd', created: 3_000, metadata: { invoice_id: 'in_1' } }
    for (const eventId of ['evt_3', 'evt_3_again']) await handleStripeGa4Event(env, db, stripe, { id: eventId, type: 'refund.created', data: { object: refund } } as never)
    const refunds = (await db.prepare(`SELECT json_extract(payload_json, '$.value.amount_minor') value, json_extract(payload_json, '$.value.collected_minor') cash, json_extract(payload_json, '$.value.items') items,
      json_extract(payload_json, '$.attribution.campaign') campaign, json_extract(payload_json, '$.metadata.purchase_type') type FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'refund'`).all()).results
    assert.deepEqual(refunds, [{ value: Math.round(1_000 * 4_900 / 5_243), cash: 1_000, items: null, campaign: 'launch', type: 'initial_subscription' }])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('Stripe payments keep exact line totals, checkout attribution after expiry, and the originating owner through an ownership change', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  const realFetch = globalThis.fetch
  try {
    const timezone = '{}'
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, status, onboarding_status, default_currency, timezone) VALUES
      ('org-platform', 'p', 'p', 'p', ?, ?, 'active', 'active', 'USD', 'Asia/Bangkok')`).bind(timezone, PLATFORM_SITE.themeId).run()
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES ('org-customer', 'c', 'c', 'c', ?, 'USD', 'Asia/Bangkok')`).bind(timezone).run()
    for (const id of ['user-a', 'user-b']) await db.prepare(`INSERT INTO user (id, name, email) VALUES (?, ?, ?)`).bind(id, id, `${id}@example.com`).run()
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m-a', 'org-customer', 'user-a', 'owner', 1000)`).run()
    // The checkout intent is long expired by the time the first payment arrives (a trial), but still names its subscription.
    await db.prepare(`INSERT INTO stripe_ga4_subscription_intents (id, organization_id, user_id, stripe_subscription_id, action, attribution_json, status, expires_at, created_at)
      VALUES ('intent-old', 'org-customer', 'user-a', 'sub_1', 'initial_subscription', ?, 'expired', '2026-01-08T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .bind(JSON.stringify({ touch: { source: 'meta', medium: 'paid', campaign: 'launch', term: null, content: 'video-a', referrerHost: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null }, attributedAt: '2026-01-01T00:00:00.000Z' })).run()
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch

    const seatLine = (amount: number, discount: number, quantity: number) => ({
      id: `il_${amount}`, type: 'subscription', amount, quantity, subscription: 'sub_1', discount_amounts: discount ? [{ amount: discount, discount: 'di_1' }] : [], taxes: [],
      price: { id: 'price_seats', unit_amount: 1000, nickname: null, product: { name: 'Seats', deleted: false }, recurring: { interval: 'month', interval_count: 1 } },
    })
    let lines: Array<Record<string, unknown>> = []
    const history: Array<Record<string, unknown>> = []
    const stripe = {
      subscriptions: { retrieve: async () => ({ id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { referenceId: 'org-customer' }, items: { data: [] } }), update: async () => ({}) },
      customers: { retrieve: async () => ({ deleted: false, metadata: { customerType: 'organization', organizationId: 'org-customer' } }) },
      invoices: {
        list: () => (async function* () { for (const item of history) yield item })(),
        listLineItems: async () => ({ data: lines, has_more: false }),
        retrieve: async (id: string) => ({ id, created: 1, subscription: 'sub_1', customer: 'cus_1', billing_reason: 'subscription_cycle', currency: 'usd', amount_paid: 1000, total_excluding_tax: 1000, status_transitions: { paid_at: 1 } }),
      },
      prices: { retrieve: async (id: string) => ({ id, unit_amount: 1000, nickname: null, product: { name: 'Seats', deleted: false }, recurring: { interval: 'month', interval_count: 1 } }) },
      charges: { retrieve: async () => ({ invoice: null }) },
    } as never
    const env = {} as never // no GA4 secret: delivery is `not_configured`, which must not affect native recording
    const pay = async (id: string, paidAt: number, totalExTax: number, amountPaid: number, billingReason = 'subscription_cycle') => {
      const invoice = { id, created: paidAt, billing_reason: billingReason, currency: 'usd', customer: 'cus_1', subscription: 'sub_1', amount_paid: amountPaid, total_excluding_tax: totalExTax, status_transitions: { paid_at: paidAt } }
      await handleStripeGa4Event(env, db, stripe, { id: `evt_${id}`, type: 'invoice.paid', data: { object: invoice } } as never)
      history.push({ id, amount_paid: amountPaid, created: paidAt, status_transitions: { paid_at: paidAt } })
    }
    const purchase = async (id: string) => await db.prepare(`SELECT json_extract(payload_json, '$.value.items') items, json_extract(payload_json, '$.attribution.campaign') campaign,
      json_extract(payload_json, '$.metadata.originating_user_id') owner, json_extract(payload_json, '$.ga4_delivery.status') delivery, json_extract(payload_json, '$.metadata.purchase_type') type
      FROM analytics_events WHERE json_extract(payload_json, '$.entity_id') = ?`).bind(id).first<Record<string, unknown>>()

    // 1,000 minor units across three seats: the exact line total survives; GA being unconfigured changes nothing native.
    lines = [seatLine(1000, 0, 3)]
    await pay('in_1', 1_000, 1000, 1000)
    const first = await purchase('in_1')
    assert.deepEqual(JSON.parse(String(first?.items)), [{ item_id: 'price_seats', item_name: 'Seats', item_category: 'Subscription', item_category2: 'monthly', quantity: 3, amount_minor: 1000 }])
    assert.deepEqual([first?.type, first?.delivery, first?.owner], ['initial_subscription', 'not_configured', 'user-a'])
    // The expired intent is still the checkout that started this subscription.
    assert.equal(first?.campaign, 'launch')

    // A discounted line: the item is the discounted total, and it reconciles with the invoice value.
    lines = [seatLine(10_000, 2_000, 1)]
    await pay('in_2', 2_000, 8_000, 8_000)
    assert.deepEqual(JSON.parse(String((await purchase('in_2'))?.items)).map((item: Record<string, unknown>) => item.amount_minor), [8_000])
    // Items that cannot be reconciled with the invoice's value are left out rather than balanced.
    lines = [seatLine(10_000, 0, 1)]
    await pay('in_3', 3_000, 8_000, 8_000)
    assert.equal((await purchase('in_3'))?.items, null)

    // Ownership moves from A to B and A leaves; a later payment and a refund still belong to A's acquisition.
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m-b', 'org-customer', 'user-b', 'owner', 2000)`).run()
    await db.prepare(`DELETE FROM member WHERE id = 'm-a'`).run()
    assert.equal(await originatingOwnerId(db, 'org-platform', 'org-customer'), 'user-a', 'the recorded relationship wins over current membership')
    lines = [seatLine(1000, 0, 1)]
    await pay('in_4', 4_000, 1000, 1000)
    assert.equal((await purchase('in_4'))?.owner, 'user-a')
    await handleStripeGa4Event(env, db, stripe, { id: 'evt_refund', type: 'refund.created', data: { object: { id: 're_1', amount: 1000, status: 'succeeded', charge: 'ch_1', payment_intent: null, currency: 'usd', created: 5_000, metadata: { invoice_id: 'in_4' } } } } as never)
    const refund = await purchase('re_1')
    assert.deepEqual([refund?.owner, refund?.type], ['user-a', 'subscription_renewal'])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})


test('a completed onboarding emails each operator once, with a link to that customer, whatever the measurement does', { timeout: 60_000 }, async (t) => {
  const { runtime, db } = await openDb()
  const sent: Array<{ idempotencyKey: string | null; body: { to: string[]; from: string; reply_to?: string; subject: string; html: string; text: string } }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    sent.push({ idempotencyKey: new Headers(init.headers).get('Idempotency-Key'), body: JSON.parse(String(init.body)) })
    return Response.json({ id: `email-${sent.length}` })
  })
  try {
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, theme_id, status, default_currency, timezone) VALUES ('org-platform', 'Blawby', 'platform', 'www', ?, 'active', 'USD', 'Asia/Bangkok')`).bind(PLATFORM_SITE.themeId).run()
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, status, default_currency, timezone) VALUES ('org-customer', 'Clay Corner', 'clay-corner', 'clay-corner', 'active', 'USD', 'Asia/Bangkok')`).run()
    await db.prepare(`INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES ('dom-1', 'org-customer', 'clay-corner.blawby.com', 'system', 'canonical', 'active')`).run()
    await db.prepare(`INSERT INTO user (id, name, email) VALUES ('user-owner', 'Mina Park', 'mina@clay-corner.com')`).run()
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m-owner', 'org-customer', 'user-owner', 'owner')`).run()
    const env = { DB: db, EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 're_test_operator', EMAIL_FROM: 'Blawby <hello@blawby.com>', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://blawby.com', PLATFORM_OWNER_EMAILS: 'ops@blawby.com, OPS@Blawby.com ' } as unknown as Parameters<typeof completeOnboarding>[0]

    const completion = await completeOnboarding(env, db, 'org-customer', null)
    assert.deepEqual(completion.operator_email, { status: 'sent' })
    assert.deepEqual(completion.owner_welcome_email, { status: 'sent' })
    assert.equal(sent.length, 2, 'a completed onboarding sends one operator notification and one owner welcome email')
    const operatorMail = sent.find(mail => mail.body.to.includes('ops@blawby.com'))
    const ownerMail = sent.find(mail => mail.body.to.includes('mina@clay-corner.com'))
    assert.ok(operatorMail)
    assert.ok(ownerMail)
    assert.deepEqual(operatorMail!.body.to, ['ops@blawby.com'])
    assert.equal(operatorMail!.idempotencyKey, `onboarding-complete:org-customer:${hashEmail('ops@blawby.com')}`)
    assert.ok(operatorMail!.body.html.includes('https://blawby.com/dashboard/platform/platform-accounts?user=user-owner&amp;organization=org-customer'), 'the operator email links to that customer')
    assert.deepEqual(ownerMail!.body.to, ['mina@clay-corner.com'])
    assert.equal(ownerMail!.idempotencyKey, `onboarding-welcome:org-customer:${hashEmail('mina@clay-corner.com')}`)
    // The conversion is recorded on its own path, once per organization.
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'onboarding_complete' AND json_extract(payload_json, '$.entity_id') = 'org-customer'").first('count(*)'), 1)

    // The platform activating itself is not a customer: no email.
    assert.deepEqual((await completeOnboarding(env, db, 'org-platform', null)).operator_email, { status: 'sent' })
    assert.deepEqual((await completeOnboarding(env, db, 'org-platform', null)).owner_welcome_email, { status: 'sent' })
    assert.equal(sent.length, 2)

    // An unconfigured operator address fails visibly and does not stop the owner welcome email or measurement.
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, status, default_currency, timezone) VALUES ('org-second', 'Second', 'second', 'second', 'active', 'USD', 'Asia/Bangkok')`).run()
    await db.prepare(`INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES ('dom-2', 'org-second', 'second.blawby.com', 'system', 'canonical', 'active')`).run()
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m-second', 'org-second', 'user-owner', 'owner')`).run()
    const unconfigured = await completeOnboarding({ ...env, PLATFORM_OWNER_EMAILS: '' }, db, 'org-second', null)
    assert.deepEqual(unconfigured.operator_email, { status: 'failed', reason: 'PLATFORM_OWNER_EMAILS is not configured' })
    assert.deepEqual(unconfigured.owner_welcome_email, { status: 'sent' })
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'onboarding_complete' AND json_extract(payload_json, '$.entity_id') = 'org-second'").first('count(*)'), 1)
    assert.equal(sent.length, 3, 'owner welcome email was sent despite operator email failure')
  } finally {
    await runtime.dispose()
  }
})
