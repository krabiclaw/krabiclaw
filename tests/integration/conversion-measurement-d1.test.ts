import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { handleStripeGa4Event, withdrawStripeGaIdentifiers } from '../../server/utils/stripe-ga4.ts'
import { claimZarazPageview, finishZarazPageview, deliverViaMeasurementProtocol, readGa4Delivery } from '../../server/utils/ga4-delivery.ts'
import { PLATFORM_TEMPLATE } from '../../utils/template-registry.ts'
import { originatingOwnerId, recordAndDeliverConversion, recordOrganizationConversionEvent as recordAt, type OrganizationConversionInput } from '../../server/utils/organization-conversions.ts'
import { findStripeGa4CheckoutAttribution } from '../../server/utils/stripe-ga4-intents.ts'
import { getAnalyticsReport } from '../../server/utils/analytics-report.ts'
import { recordTenantPageview, type TenantPageviewInput } from '../../server/utils/pageview-tracking.ts'
import { completeOnboarding } from '../../server/utils/organization-provisioning.ts'
import { hashEmail } from '../../server/utils/email-delivery.ts'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { listBusinessOutcomes } from '../../server/utils/business-outcomes.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { createQa } from '../../server/utils/location-qa.ts'
import { findAuthUsersByIds, type CloudflareEnv } from '../../server/utils/auth.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const VISITOR = '22222222-2222-4222-8222-222222222222'
// Events are recorded inside the reported range, at their own occurrence time.
const recordOrganizationConversionEvent = (db: Parameters<typeof recordAt>[0], origin: Parameters<typeof recordAt>[1], input: OrganizationConversionInput) =>
  recordAt(db, origin, { occurredAt: '2026-09-10T04:00:00.000Z', ...input })
const browser = { headers: new Headers({ cookie: `kc_session_id=${SESSION}; kc_visitor_id=${VISITOR}`, 'user-agent': 'Desktop' }) }

async function openDb() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'conversion-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  return { runtime, db }
}

test('conversion measurement: contract, values, idempotency, report and cohort on D1', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    const settings = '{}'
    for (const id of ['org-platform', 'org-customer']) {
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES (?, ?, ?, ?, ?, 'USD', 'Asia/Bangkok')`).bind(id, id, id, id, settings).run()
    }
    for (const id of ['user-a', 'user-b']) {
      await db.prepare(`INSERT INTO user (id, name, email) VALUES (?, ?, ?)`).bind(id, id, `${id}@example.com`).run()
    }
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m1', 'org-customer', 'user-a', 'owner')`).run()

    // A visitor lands from a campaign; their signup carries that session's snapshot.
    const landing: TenantPageviewInput = {
      eventId: 'pv-1', organizationId: 'org-platform', pagePath: '/', locale: 'en', referrerHost: null,
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

    const period = { startDate: '2026-09-10', endDate: '2026-09-12', now: new Date('2026-09-13T00:00:00Z') }
    const platform = await getAnalyticsReport(db, { organizationId: 'org-platform', ...period })
    // One session, one signup: the session converted once; the purchase and onboarding have no session.
    const signupRow = platform.conversions.find(row => row.eventName === 'sign_up')
    assert.deepEqual([signupRow?.events, signupRow?.distinctEntities, signupRow?.convertingSessions, signupRow?.sessionConversionRate], [1, 1, 1, 100])
    assert.equal(platform.conversions.find(row => row.eventName === 'onboarding_complete')?.nonbrowserEvents, 1)
    // Revenue is attributed to the campaign and creative the checkout observed, without a browser session.
    assert.deepEqual(platform.attributedValue.map(row => [row.campaign, row.content, row.currency, row.purchases, row.collectedMinor, row.refundedMinor, row.netMinor]), [['launch', 'video-a', 'USD', 1, 5243, 1500, 3743]])
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'purchase' AND session_id IS NULL").first('count(*)'), 1)
    assert.equal(platform.conversions.find(row => row.eventName === 'purchase')?.sessionConversionRate, 0)
    assert.deepEqual(platform.attribution.map(row => [row.campaign, row.content, row.sessions, row.outcomeEvents, row.convertingSessions, row.sessionConversionRate]), [['launch', 'video-a', 1, 1, 1, 100]])
    assert.deepEqual(platform.values.find(row => row.eventName === 'purchase'), { eventName: 'purchase', basis: 'purchase', currency: 'USD', events: 1, valueMinor: 4900, collectedMinor: 5243 })
    assert.deepEqual(platform.net, [{ currency: 'USD', collectedMinor: 5243, refundedMinor: 1500, netMinor: 3743 }])
    assert.deepEqual(platform.signupCohort.bySignupAttribution[0]?.revenue, [{ currency: 'USD', collectedMinor: 5243, refundedMinor: 1500, netMinor: 3743 }])
    // The signup cohort links signup -> owned organization -> onboarding and first payment, counted per signup.
    assert.deepEqual([platform.signupCohort.signups, platform.signupCohort.onboardedSignups, platform.signupCohort.firstPaidSignups], [1, 1, 1])
    assert.equal(platform.signupCohort.bySignupAttribution[0]?.campaign, 'launch')
    assert.deepEqual([platform.signupCohort.onboardedBusinesses, platform.signupCohort.firstPaidBusinesses], [1, 1])
    // Only the nonbrowser onboarding carried no observed attribution.
    assert.equal(platform.coverage.outcomeEventsWithoutAttribution, 1)
    assert.equal(platform.coverage.measurementContractStartedAt, '2026-09-10T04:00:00.000Z')
    assert.deepEqual(platform.coverage.ga4Delivery.map(row => [row.eventName, row.status]).sort(), [['onboarding_complete', 'unrecorded'], ['purchase', 'unrecorded'], ['refund', 'unrecorded'], ['sign_up', 'unrecorded']])

    const customer = await getAnalyticsReport(db, { organizationId: 'org-customer', ...period })
    assert.deepEqual(customer.bookingValue.map(row => [row.productName, row.currency, row.bookings, row.valuedBookings, row.quotedValueMinor]).sort(), [['Pottery', 'THB', 1, 1, 240000], [null, null, 1, 0, 0]].sort())
    assert.deepEqual(customer.net, [])
    assert.equal(customer.signupCohort.signups, 0)
    // KrabiClaw's subscription revenue never appears as the subscribing customer's revenue.
    assert.equal(customer.values.some(row => row.basis !== 'quoted'), false)

    // SQL keeps empty and null campaigns separate; each signup cohort gets only its revenue.
    for (const [index, campaign] of [null, ''].entries()) {
      const userId = `cohort-${index}`
      await recordOrganizationConversionEvent(db, null, { ...signup, entityId: userId,
        attribution: { touch: { ...snapshot.attribution, source: 'cohort-proof', campaign }, attributedAt: '2026-09-10T04:00:00.000Z' } })
      await recordOrganizationConversionEvent(db, null, { ...purchase, entityId: `cohort-invoice-${index}`,
        value: { ...purchase.value, transaction_id: `cohort-invoice-${index}`, amount_minor: (index + 1) * 100, collected_minor: (index + 1) * 100 },
        metadata: { purchase_type: 'initial_subscription', originating_user_id: userId } })
    }
    const cohorts = (await getAnalyticsReport(db, { organizationId: 'org-platform', ...period })).signupCohort.bySignupAttribution
      .filter(row => row.source === 'cohort-proof')
    assert.deepEqual(cohorts.map(row => row.revenue.map(value => value.netMinor)).sort(), [[100], [200]])

    // Progress reads these same canonical results, rather than copying an
    // analytics report or treating the assigned member as the acting user.
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('customer-en', 'org-customer', 'en', 1, 'published')").run()
    const env = { DB: db, BETTER_AUTH_SECRET: 'progress-data-proof-secret-at-least-32-characters', BETTER_AUTH_URL: 'https://progress.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://progress.example', STRIPE_SECRET_KEY: 'sk_test_progress_data_no_provider_requests' } as CloudflareEnv
    const qaActor = (await findAuthUsersByIds(env, ['user-a'])).get('user-a')
    assert(qaActor, 'The acting user must be resolved by the existing authentication adapter')
    const qa = await createQa(db, { organizationId: 'org-customer', locationId: null }, { question: 'What should I bring?', answer: 'Bring your relevant documents.' }, qaActor)
    const qaId = (qa.data as { id: string }).id
    const customerPayment = { organizationId: 'org-customer', eventName: 'payment_paid', stage: 'completed', surface: 'stripe', entityType: 'payment', entityId: 'payment-progress',
      occurredAt: '2026-09-12T03:00:00.000Z', value: { basis: 'purchase', amount_minor: 5000, collected_minor: 5350, currency: 'THB', transaction_id: 'pi_progress' }, properties: { member_id: 'assigned-member' } } as const
    const paidResult = await recordOrganizationConversionEvent(db, null, customerPayment)
    await recordOrganizationConversionEvent(db, null, customerPayment)
    const refundedResult = await recordOrganizationConversionEvent(db, null, { organizationId: 'org-customer', eventName: 'payment_refunded', stage: 'completed', surface: 'stripe', entityType: 'refund', entityId: 're_progress',
      occurredAt: '2026-09-12T04:00:00.000Z', actor: { type: 'staff', id: 'user-a' }, value: { basis: 'refund', amount_minor: 1000, collected_minor: 1000, currency: 'THB', transaction_id: 're_progress' } })
    const membership = await resolveMembership(env, { organizationId: 'org-customer', userId: 'user-a' })
    assert(membership)
    const principal = memberAccessPrincipal(membership, { env })
    const progress = await listBusinessOutcomes(db, principal, { limit: 100 })
    const qaFact = progress.outcomes.find(item => item.subject.kind === 'qa' && item.subject.id === qaId)
    assert(qaFact)
    assert.deepEqual(qaFact.actor, { kind: 'member', userId: 'user-a' })
    assert.deepEqual(qaFact.changedFields, ['question', 'answer', 'status'])
    const paidFacts = progress.outcomes.filter(item => item.source.table === 'analytics_events' && item.source.id === paidResult.id)
    assert.equal(paidFacts.length, 1)
    assert.deepEqual(paidFacts[0]!.actor, { kind: 'unknown', userId: null })
    assert.equal(paidFacts[0]!.measurement?.assignedMemberId, 'assigned-member')
    assert.equal(paidFacts[0]!.measurement?.attribution, null)
    assert.equal(paidFacts[0]!.moneyOwner, 'customer_business')
    assert.deepEqual(paidFacts[0]!.value, customerPayment.value)
    const refundFact = progress.outcomes.find(item => item.source.id === refundedResult.id)
    assert(refundFact)
    assert.deepEqual(refundFact.actor, { kind: 'member', userId: 'user-a' })
    assert.equal(refundFact.value?.basis, 'refund')
    assert.equal(refundFact.value?.amount_minor, 1000)
    assert.equal(progress.outcomes.some(item => item.moneyOwner === 'platform'), false, 'platform invoices do not become this customer business’s revenue')
    assert.deepEqual(progress.outcomes.filter(item => item.value?.basis === 'quoted').map(item => item.subject.id), ['req-1'])
    const paged = []
    let next: number | null = 0
    do {
      const page = await listBusinessOutcomes(db, principal, { limit: 1, offset: next })
      assert.equal(page.outcomes.length, 1)
      paged.push(...page.outcomes)
      next = page.pagination.nextOffset
    } while (next !== null)
    assert.deepEqual(paged, progress.outcomes, 'mixed canonical sources share one stable database ordering and pagination')
    assert.equal(new Set(paged.map(item => item.id)).size, paged.length)

  } finally { await runtime.dispose() }
})

test('the funnel joins a business site from visit to payment, by source and by location', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES ('org-funnel', 'Funnel', 'funnel', 'funnel', '{}', 'THB', 'Asia/Bangkok')`).run()
    for (const id of ['loc-beach', 'loc-town']) {
      await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES (?, 'org-funnel', ?, ?, 'Asia/Bangkok')`).bind(id, id, id).run()
    }
    // Two visitors: one from a Google ad at the beach, one typing the address in town.
    const visitor = (n: number) => ({ session: `3333333${n}-3333-4333-8333-333333333333`, visitor: `4444444${n}-4444-4444-8444-444444444444` })
    const arrivals = [{ ...visitor(1), locationId: 'loc-beach', attribution: { gclid: 'ad-click' } }, { ...visitor(2), locationId: 'loc-town', attribution: {} }]
    for (const [index, arrival] of arrivals.entries()) {
      await recordTenantPageview(db, {
        eventId: `pv-funnel-${index}`, organizationId: 'org-funnel', pagePath: '/', locale: 'en', referrerHost: null, attribution: arrival.attribution,
        internalHosts: ['funnel.example'], userAgent: 'Desktop', ipHash: 'h', sessionId: arrival.session, visitorId: arrival.visitor,
        country: 'th', region: null, city: null, locationId: arrival.locationId, pageId: null, pageType: 'home', recipe: null, now: '2026-09-10T03:00:00.000Z',
      })
    }
    const [ad, direct] = arrivals.map(arrival => ({ headers: new Headers({ cookie: `kc_session_id=${arrival.session}; kc_visitor_id=${arrival.visitor}`, 'user-agent': 'Desktop' }) }))
    const view = { organizationId: 'org-funnel', eventName: 'product_view', stage: 'viewed', surface: 'website', entityType: 'product', entityId: 'dinner' } as const
    await recordOrganizationConversionEvent(db, ad, { ...view, locationId: 'loc-beach' })
    await recordOrganizationConversionEvent(db, direct, { ...view, locationId: 'loc-town' })
    await recordOrganizationConversionEvent(db, ad, { organizationId: 'org-funnel', eventName: 'checkout_start', stage: 'started', surface: 'website', entityType: null, entityId: null, locationId: 'loc-beach' })
    // Both visitors reserve; the town reservation is later cancelled, so only the beach one is confirmed.
    for (const [requestId, origin, locationId, status] of [['req-beach', ad, 'loc-beach', 'confirmed'], ['req-town', direct, 'loc-town', 'cancelled']] as const) {
      const now = '2026-09-10T05:00:00.000Z'
      const thread = requestInsertQueries({ id: requestId, kind: 'reservation', organization_id: 'org-funnel', location_id: locationId, user_id: null, review_id: null,
        conversation_state: 'needs_attention', resolved_at: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'guest@funnel.example', phone: '+66812345678' }), created_at: now, updated_at: now })
      await db.batch(thread.map(write => db.prepare(write.query).bind(...write.params)))
      await db.prepare(`INSERT INTO reservations (id, organization_id, location_id, request_id, timezone, starts_at, ends_at, party_size, status, cancelled_at)
        VALUES (?, 'org-funnel', ?, ?, 'Asia/Bangkok', '2026-09-20T12:00:00.000Z', '2026-09-20T14:00:00.000Z', 2, ?, ?)`)
        .bind(`reservation-${requestId}`, locationId, requestId, status, status === 'cancelled' ? now : null).run()
      await recordOrganizationConversionEvent(db, origin, { organizationId: 'org-funnel', eventName: 'reservation_submit', stage: 'submitted', surface: 'website', entityType: 'request', entityId: requestId, locationId })
    }
    // A request made through checkout records no submit event: its payment is how it was made.
    const now = '2026-09-10T06:00:00.000Z'
    const checkout = requestInsertQueries({ id: 'req-checkout', kind: 'reservation', organization_id: 'org-funnel', location_id: 'loc-beach', user_id: null, review_id: null,
      conversation_state: 'needs_attention', resolved_at: null, payload: threadPayloadForGuest({ name: 'Guest', email: 'paid@funnel.example', phone: '+66812345678' }), created_at: now, updated_at: now })
    await db.batch(checkout.map(write => db.prepare(write.query).bind(...write.params)))
    await db.prepare(`INSERT INTO reservations (id, organization_id, location_id, request_id, timezone, starts_at, ends_at, party_size, status)
      VALUES ('reservation-req-checkout', 'org-funnel', 'loc-beach', 'req-checkout', 'Asia/Bangkok', '2026-09-21T12:00:00.000Z', '2026-09-21T14:00:00.000Z', 2, 'confirmed')`).run()
    // One payment made the checkout request; the other pays for a request already submitted, which is not submitted twice.
    for (const [paymentId, reservationId, collected] of [['pay-checkout', 'reservation-req-checkout', 160500], ['pay-beach', 'reservation-req-beach', 53500]] as const) {
      await db.prepare(`INSERT INTO payments (id, organization_id, stripe_account_id, livemode, subject_type, subject_id, location_id, currency, amount, price_snapshot_json, created_at, updated_at)
        VALUES (?, 'org-funnel', 'acct_funnel', 0, 'reservation', ?, 'loc-beach', 'THB', ?, '{}', ?, ?)`).bind(paymentId, reservationId, collected, now, now).run()
      await recordOrganizationConversionEvent(db, ad, { organizationId: 'org-funnel', eventName: 'payment_paid', stage: 'completed', surface: 'stripe', entityType: 'payment', entityId: paymentId, locationId: 'loc-beach',
        value: { basis: 'purchase', amount_minor: collected - 100, collected_minor: collected, currency: 'THB', transaction_id: `pi_${paymentId}` } })
    }

    const { funnel } = await getAnalyticsReport(db, { organizationId: 'org-funnel', startDate: '2026-09-10', endDate: '2026-09-12', now: new Date('2026-09-13T00:00:00Z') })
    const steps = (counts: Omit<typeof funnel, 'bySource' | 'byLocation'>) => [counts.visits, counts.viewed, counts.intent, counts.submitted, counts.confirmed, counts.paid]
    assert.deepEqual(steps(funnel), [2, 2, 1, 3, 2, 2])
    assert.deepEqual(funnel.paidCollected, [{ currency: 'THB', collectedMinor: 214000 }])
    assert.deepEqual(funnel.bySource.map(row => [row.channel, ...steps(row)]), [['Google Ads', 1, 1, 1, 2, 2, 2], ['Direct', 1, 1, 0, 1, 0, 0]])
    assert.deepEqual(funnel.byLocation.map(row => [row.locationId, ...steps(row)]).sort(), [['loc-beach', 1, 1, 1, 2, 2, 2], ['loc-town', 1, 1, 0, 1, 0, 0]])
  } finally { await runtime.dispose() }
})

test('attribution rates share one population; cohorts follow the acquiring owner and timing', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    const settings = '{}'
    for (const id of ['org-platform', 'org-paying', 'org-new']) {
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, default_currency, timezone) VALUES (?, ?, ?, ?, ?, 'USD', 'Asia/Bangkok')`).bind(id, id, id, id, settings).run()
    }
    for (const id of ['owner', 'newcomer', 'founder']) await db.prepare(`INSERT INTO user (id, name, email) VALUES (?, ?, ?)`).bind(id, id, `${id}@example.com`).run()
    const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
    const page = (sessionN: number, campaign: string, at: string): TenantPageviewInput => ({
      eventId: `pv-${sessionN}-${campaign}`, organizationId: 'org-platform', pagePath: '/', locale: 'en', referrerHost: null,
      attribution: { utm_source: 'meta', utm_medium: 'paid', utm_campaign: campaign }, internalHosts: ['platform.example'], userAgent: 'Desktop', ipHash: 'h',
      sessionId: uuid(sessionN), visitorId: uuid(100 + sessionN), country: 'th', region: null, city: null, locationId: null, pageId: null, pageType: 'home', recipe: null, now: at,
    })
    const cookies = (sessionN: number) => ({ headers: new Headers({ cookie: `kc_session_id=${uuid(sessionN)}; kc_visitor_id=${uuid(100 + sessionN)}` }) })
    // Sessions 1-2 land on A and convert; session 3 lands on A and does not. Sessions 1-2 are later touched by B.
    for (const n of [1, 2, 3]) await recordTenantPageview(db, page(n, 'A', '2026-09-10T03:00:00.000Z'))
    for (const n of [1, 2]) {
      await recordAt(db, cookies(n), { organizationId: 'org-platform', eventName: 'sign_up', stage: 'completed', surface: 'auth', entityType: 'user', entityId: `user-${n}`, occurredAt: '2026-09-10T03:30:00.000Z' })
      await recordTenantPageview(db, page(n, 'B', '2026-09-10T04:00:00.000Z'))
    }
    const period = { organizationId: 'org-platform', startDate: '2026-09-10', endDate: '2026-09-10', now: new Date('2026-09-11T00:00:00Z') }
    const report = await getAnalyticsReport(db, period)
    for (const row of report.attribution) assert.ok((row.sessionConversionRate ?? 0) <= 100, `${row.campaign} rate ${row.sessionConversionRate}`)
    assert.deepEqual(report.attribution.map(row => [row.campaign, row.sessions, row.convertingSessions]).sort(), [['A', 1, 0], ['B', 2, 2]])
    // The events keep the touch they had when they happened, in their own grouping.
    assert.deepEqual(report.outcomeAttribution.map(row => [row.campaign, row.events]), [['A', 2]])

    // A paying business already owned by someone else; a newcomer is added as a later owner and is not its acquirer.
    const founderSignup = await recordAt(db, null, { organizationId: 'org-platform', eventName: 'sign_up', stage: 'completed', surface: 'auth', entityType: 'user', entityId: 'founder', occurredAt: '2026-09-10T05:00:00.000Z' })
    assert.ok(founderSignup.created)
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m-owner', 'org-paying', 'owner', 'owner', 1000), ('m-newcomer', 'org-paying', 'newcomer', 'owner', 2000)`).run()
    await recordAt(db, null, { organizationId: 'org-platform', eventName: 'sign_up', stage: 'completed', surface: 'auth', entityType: 'user', entityId: 'newcomer', occurredAt: '2026-09-10T06:00:00.000Z' })
    assert.equal(await originatingOwnerId(db, 'org-platform', 'org-paying'), 'owner')
    await recordAt(db, null, { organizationId: 'org-platform', eventName: 'purchase', stage: 'completed', surface: 'stripe', entityType: 'invoice', entityId: 'in_old', occurredAt: '2026-09-10T02:00:00.000Z',
      value: { basis: 'purchase', amount_minor: 4900, collected_minor: 4900, currency: 'USD', transaction_id: 'in_old' },
      metadata: { purchase_type: 'initial_subscription', subscribing_organization_id: 'org-paying', originating_user_id: 'owner' } })
    // A business the founder actually created, onboarded and paid for after the signup.
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m-founder', 'org-new', 'founder', 'owner', 3000)`).run()
    await recordAt(db, null, { organizationId: 'org-platform', eventName: 'onboarding_complete', stage: 'completed', surface: 'dashboard', entityType: 'organization', entityId: 'org-new', occurredAt: '2026-09-10T07:00:00.000Z', metadata: { originating_user_id: await originatingOwnerId(db, 'org-platform', 'org-new') } })
    await recordAt(db, null, { organizationId: 'org-platform', eventName: 'purchase', stage: 'completed', surface: 'stripe', entityType: 'invoice', entityId: 'in_new', occurredAt: '2026-09-10T08:00:00.000Z',
      value: { basis: 'purchase', amount_minor: 4900, collected_minor: 4900, currency: 'USD', transaction_id: 'in_new' },
      metadata: { purchase_type: 'initial_subscription', subscribing_organization_id: 'org-new', originating_user_id: 'founder' } })
    const cohort = (await getAnalyticsReport(db, period)).signupCohort
    // Four signups; only the founder's led to a business that onboarded and paid after them. The paying business predates the newcomer.
    assert.deepEqual([cohort.signups, cohort.onboardedSignups, cohort.firstPaidSignups], [4, 1, 1])
    assert.deepEqual([cohort.onboardedBusinesses, cohort.firstPaidBusinesses], [1, 2])
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
    await recordTenantPageview(db, { eventId: 'browser-pageview', organizationId: 'org-platform', sessionId: SESSION, visitorId: VISITOR,
      pagePath: '/', locale: 'en', referrerHost: null, attribution: {}, internalHosts: ['platform.example'], userAgent: 'Desktop', ipHash: 'h',
      country: null, region: null, city: null, locationId: null, pageId: null, pageType: null, recipe: null, now: '2026-09-10T03:00:00.000Z' })
    const claimInput = { eventId: 'browser-pageview', organizationId: 'org-platform', sessionId: SESSION, cookieHeader: `kc_analytics_consent=${encodeURIComponent('{"kc_analytics":true}')}` }
    const claims = await Promise.all([claimZarazPageview(db, claimInput), claimZarazPageview(db, claimInput)])
    assert.equal(claims.filter(claim => claim.claimId).length, 1)
    const claimId = claims.find(claim => claim.claimId)!.claimId!
    assert.equal(await finishZarazPageview(db, { ...claimInput, sessionId: 'other-session', claimId, status: 'dispatched' }), false)
    assert.equal(await finishZarazPageview(db, { ...claimInput, sessionId: SESSION, claimId, status: 'dispatched' }), true)
    assert.equal((await readGa4Delivery(db, claimInput.eventId))?.status, 'dispatched')
    assert.equal((await claimZarazPageview(db, claimInput)).claimId, undefined)
    // The native events exist regardless of the consent decision.
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'sign_up'").first('count(*)'), 2)
    const accepted = await recordAndDeliverConversion({ GA4_API_SECRET: 'secret' }, db, request('{"kc_analytics":true}'), { ...signup('user-c') })
    assert.equal((await deliveryOf(accepted.id)).status, 'sent')
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /measurement_id=G-TEST/)

    // Concurrent delivery callers share an atomic lease; a crashed sender's lease expires.
    const pending = await recordAt(db, null, signup('user-concurrent'))
    const input = { eventId: pending.id, organizationId: 'org-platform', event: { name: 'sign_up', params: {} },
      clientId: '111.222', userId: null, sessionId: null, sessionCapturedAt: null }
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let attempts = 0
    globalThis.fetch = (async () => { attempts++; entered.resolve(undefined); await release.promise; return new Response(null, { status: 204 }) }) as typeof fetch
    const sending = deliverViaMeasurementProtocol({ GA4_API_SECRET: 'secret' }, db, input)
    await entered.promise
    try {
      const concurrent = await deliverViaMeasurementProtocol({ GA4_API_SECRET: 'secret' }, db, input)
      assert.equal(concurrent.status, 'sending')
      assert.ok(Date.parse(concurrent.leaseExpiresAt!) > Date.now())
      assert.equal(attempts, 1)
    } finally { release.resolve(undefined) }
    assert.equal((await sending).status, 'sent')
    assert.equal((await deliverViaMeasurementProtocol({ GA4_API_SECRET: 'secret' }, db, input)).status, 'sent')
    assert.equal(attempts, 1)
    assert.equal((await readGa4Delivery(db, pending.id))?.status, 'sent')

    const abandoned = await recordAt(db, null, signup('user-abandoned'))
    await db.prepare("UPDATE analytics_events SET payload_json = json_set(payload_json, '$.ga4_delivery', json(?)) WHERE id = ?")
      .bind(JSON.stringify({ transport: 'measurement_protocol', status: 'sending', claimId: 'crashed', leaseExpiresAt: '2000-01-01T00:00:00.000Z' }), abandoned.id).run()
    assert.equal((await deliverViaMeasurementProtocol({ GA4_API_SECRET: 'secret' }, db, { ...input, eventId: abandoned.id })).status, 'sent')
    assert.equal(attempts, 2)
    assert.equal((await readGa4Delivery(db, abandoned.id))?.status, 'sent')

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
      ('org-platform', 'p', 'p', 'p', ?, ?, 'active', 'active', 'USD', 'Asia/Bangkok')`).bind(timezone, PLATFORM_TEMPLATE.themeId).run()
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
    const env = { GA4_API_SECRET: 'secret' } as never
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
      ('org-platform', 'p', 'p', 'p', ?, ?, 'active', 'active', 'USD', 'Asia/Bangkok')`).bind(timezone, PLATFORM_TEMPLATE.themeId).run()
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


test('conversion session bounds survive out-of-order arrivals on D1', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    await db.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('org-bounds', 'Bounds', 'bounds', 'USD', 'Asia/Bangkok')").run()
    const input = { organizationId: 'org-bounds', eventName: 'product_view', stage: 'viewed', surface: 'website', entityType: 'product', entityId: 'product-1' } as const
    for (const hour of ['03', '05', '01', '04']) {
      await recordOrganizationConversionEvent(db, browser, { ...input, occurredAt: `2026-09-10T${hour}:00:00.000Z` })
    }
    const bounds = await db.prepare(`SELECT json_extract(payload_json, '$.started_at') started_at,
      json_extract(payload_json, '$.last_seen_at') last_seen_at, updated_at
      FROM analytics_summaries WHERE organization_id = 'org-bounds' AND kind = 'session'`).first()
    assert.deepEqual(bounds, { started_at: '2026-09-10T01:00:00.000Z', last_seen_at: '2026-09-10T05:00:00.000Z', updated_at: '2026-09-10T05:00:00.000Z' })
  } finally {
    await runtime.dispose()
  }
})

test('checkout attribution uses the newest matching intent even when attribution is absent', { timeout: 60_000 }, async () => {
  const { runtime, db } = await openDb()
  try {
    await db.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('org-intents', 'Intents', 'intents', 'USD', 'Asia/Bangkok')").run()
    await db.prepare("INSERT INTO user (id, name, email) VALUES ('intent-user', 'Intent', 'intent@example.com')").run()
    const attribution = { touch: { source: 'meta', medium: 'paid', campaign: 'launch', term: null, content: null, referrerHost: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null }, attributedAt: '2026-09-10T01:00:00.000Z' }
    const insert = (id: string, createdAt: string, value: string | null, action = 'initial_subscription', subscription = 'sub-intents') => db.prepare(`INSERT INTO stripe_ga4_subscription_intents
      (id, organization_id, user_id, stripe_subscription_id, action, attribution_json, created_at, expires_at)
      VALUES (?, 'org-intents', 'intent-user', ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')`).bind(id, subscription, action, value, createdAt).run()
    assert.equal(await findStripeGa4CheckoutAttribution(db, 'sub-intents', 'initial_subscription'), null)
    await insert('intent-a', '2026-09-10T01:00:00.000Z', JSON.stringify(attribution))
    assert.deepEqual(await findStripeGa4CheckoutAttribution(db, 'sub-intents', 'initial_subscription'), attribution)
    await insert('intent-b', '2026-09-10T02:00:00.000Z', null)
    assert.equal(await findStripeGa4CheckoutAttribution(db, 'sub-intents', 'resubscription'), null)
    await insert('intent-c', '2026-09-10T02:00:00.000Z', JSON.stringify(attribution))
    await insert('intent-d', '2026-09-10T03:00:00.000Z', null, 'upgrade')
    await insert('intent-e', '2026-09-10T03:00:00.000Z', null, 'initial_subscription', 'sub-other')
    assert.deepEqual(await findStripeGa4CheckoutAttribution(db, 'sub-intents', 'initial_subscription'), attribution)
  } finally {
    await runtime.dispose()
  }
})

test('a completed onboarding emails each operator once, with a link to that customer, whatever the measurement does', { timeout: 60_000 }, async (t) => {
  const { runtime, db } = await openDb()
  const sent: Array<{ idempotencyKey: string | null; body: { to: string[]; subject: string; html: string; text: string } }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    sent.push({ idempotencyKey: new Headers(init.headers).get('Idempotency-Key'), body: JSON.parse(String(init.body)) })
    return Response.json({ id: `email-${sent.length}` })
  })
  try {
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, theme_id, status, default_currency, timezone) VALUES ('org-platform', 'KrabiClaw', 'krabiclaw', 'www', ?, 'active', 'USD', 'Asia/Bangkok')`).bind(PLATFORM_TEMPLATE.themeId).run()
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, status, default_currency, timezone) VALUES ('org-customer', 'Clay Corner', 'clay-corner', 'clay-corner', 'active', 'USD', 'Asia/Bangkok')`).run()
    await db.prepare(`INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES ('dom-1', 'org-customer', 'clay-corner.krabiclaw.com', 'system', 'canonical', 'active')`).run()
    await db.prepare(`INSERT INTO user (id, name, email) VALUES ('user-owner', 'Mina Park', 'mina@clay-corner.com')`).run()
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m-owner', 'org-customer', 'user-owner', 'owner')`).run()
    const env = { DB: db, EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 're_test_operator', EMAIL_FROM: 'KrabiClaw <hello@krabiclaw.com>', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.com', PLATFORM_OWNER_EMAILS: 'ops@krabiclaw.com, OPS@KrabiClaw.com ' } as unknown as Parameters<typeof completeOnboarding>[0]

    const completion = await completeOnboarding(env, db, 'org-customer', null)
    assert.deepEqual(completion.operator_email, { status: 'sent' })
    assert.equal(sent.length, 1, 'a repeated operator address, however cased, is one email')
    const [email] = sent
    assert.deepEqual(email!.body.to, ['ops@krabiclaw.com'])
    assert.equal(email!.body.subject, 'Clay Corner is live on KrabiClaw')
    assert.equal(email!.idempotencyKey, `onboarding-complete:org-customer:${hashEmail('ops@krabiclaw.com')}`)
    for (const expected of ['Mina Park (mina@clay-corner.com)', 'https://clay-corner.krabiclaw.com/',
      'https://krabiclaw.com/dashboard/krabiclaw/platform-accounts?user=user-owner&amp;organization=org-customer']) {
      assert.ok(email!.body.html.includes(expected), `email carries ${expected}`)
    }
    // The conversion is recorded on its own path, once per organization.
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'onboarding_complete' AND json_extract(payload_json, '$.entity_id') = 'org-customer'").first('count(*)'), 1)

    // KrabiClaw activating itself is not a customer: no email.
    assert.deepEqual((await completeOnboarding(env, db, 'org-platform', null)).operator_email, { status: 'sent' })
    assert.equal(sent.length, 1)

    // An unconfigured operator address fails visibly and does not stop the measurement.
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, status, default_currency, timezone) VALUES ('org-second', 'Second', 'second', 'second', 'active', 'USD', 'Asia/Bangkok')`).run()
    await db.prepare(`INSERT INTO member (id, "organizationId", "userId", role) VALUES ('m-second', 'org-second', 'user-owner', 'owner')`).run()
    const unconfigured = await completeOnboarding({ ...env, PLATFORM_OWNER_EMAILS: '' }, db, 'org-second', null)
    assert.deepEqual(unconfigured.operator_email, { status: 'failed', reason: 'PLATFORM_OWNER_EMAILS is not configured' })
    assert.equal(await db.prepare("SELECT count(*) FROM analytics_events WHERE json_extract(payload_json, '$.event_name') = 'onboarding_complete' AND json_extract(payload_json, '$.entity_id') = 'org-second'").first('count(*)'), 1)
    assert.equal(sent.length, 1)
  } finally {
    await runtime.dispose()
  }
})
