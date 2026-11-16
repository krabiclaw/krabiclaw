import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { hashPassword } from 'better-auth/crypto'
import { H3, H3Event } from 'h3'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createSession, listBookableSessions, setProductBookingConfig } from '../../server/utils/availability.ts'
import { createProductBooking } from '../../server/domain/product-bookings.ts'
import { createTables } from './support/table-product.ts'
import { createStay, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { sendGuestThreadReply } from '../../server/domain/guest-threads/operations.ts'
import { resolveOrganizationMembership } from '../../server/utils/member-access.ts'
import { stayReadyTaskQueries } from '../../server/domain/tasks.ts'
import { handleTaskTools } from '../../server/utils/mcp-tools/tasks.ts'
import type { McpExecutorContext } from '../../server/utils/mcp-tools/execution.ts'
import { addLocalDays, localDateAt, localDateTimeToInstant } from '../../utils/timezone.ts'
import type { BusinessToday, TodayItem } from '../../shared/dashboard-today.ts'
import type { OpportunityView } from '../../server/domain/opportunities.ts'
import todayRoute from '../../server/api/dashboard/today.get.ts'

// Today's cards are the business's own bookings, read from the stored booked
// records in one round trip, with the welcome as the card's action for each
// upcoming booking whose client has not heard from the business and whose host
// wrote preparation for it. Every booking here is made through the operation
// a guest or the business makes it with; nothing a card shows is inserted.

const OWNER = 'today-owner'
const ZONE = 'America/Los_Angeles'
const PASSWORD = 'TodayReservationsProof123!'
const ORGS = { law: 'service', studio: 'experience', inn: 'lodging', bistro: 'restaurant' } as const
type Org = keyof typeof ORGS
type Today = BusinessToday

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'today-reservations-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'today-reservations-proof', exportName: 'Hub' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'today-reservations-proof-secret-long-enough', BETTER_AUTH_URL: 'https://proof.example',
    STRIPE_SECRET_KEY: 'sk_test_no_provider_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'today-reservations-reply-secret',
    PREVIEW_SECRET: 'today-reservations-preview-proof-secret', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
  await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
  await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@proof.example', 1, 0, 0)").bind(OWNER).run()
  await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('owner-account', ?, 'credential', ?, ?, 0, 0)").bind(OWNER, OWNER, await hashPassword(PASSWORD)).run()
  // Every day 08:00–22:00, so a reservation or a session can be booked on any day.
  const hours = JSON.stringify({ periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 8, minute: 0 }, close: { day, hour: 22, minute: 0 } })) })
  for (const [slug, vertical] of Object.entries(ORGS)) {
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, ?, ?, ?, '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', ?, '2026-01-01T00:00:00.000Z', ?)`).bind(slug, slug, slug, slug, vertical, ZONE).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')").bind(`${slug}-en`, slug).run()
    await db.prepare("INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES (?, ?, ?, 'custom', 'canonical', 'active')").bind(`${slug}-domain`, slug, `${slug}.proof.example`).run()
    await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, \'owner\', 0)').bind(`${slug}-owner`, slug, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, opening_hours, created_at, updated_at)
      VALUES (?, ?, 'main', ?, 'active', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).bind(`${slug}-site`, slug, `${slug} office`, ZONE, hours).run()
  }
  const request = () => Object.assign(new Request('https://proof.example/api/mcp'), { runtime: { cloudflare: { env } } })
  const auth = createAuth(env)
  const signed = await auth.api.signInEmail({ body: { email: 'owner@proof.example', password: PASSWORD }, asResponse: true })
  assert.equal(signed.status, 200)
  const cookie = [...new Map(signed.headers.getSetCookie().map(value => { const pair = value.split(';')[0]!; return [pair.slice(0, pair.indexOf('=')), pair] })).values()].join('; ')
  const app = new H3()
  app.get('/api/dashboard/today', todayRoute)
  const today = async (org: Org, range: 'today' | 'upcoming'): Promise<Today> => {
    const response = await app.request(Object.assign(new Request(`https://proof.example/api/dashboard/today?org=${org}&range=${range}`, { headers: { cookie, origin: 'https://proof.example' } }),
      { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json() as Today
  }
  return { runtime, db, env, event: () => new H3Event(request()), today }
}

/** A scheduled offering at the organization's site, with a session on `day` at 10:00. */
async function offering(db: D1Database, env: CloudflareEnv, org: Org, input: { kind: 'service' | 'experience'; name: string; details?: Record<string, unknown>; day: string }) {
  const product = await createProduct(db, { env, organizationId: org, actor: { actorId: OWNER }, product: {
    kind: input.kind, name: input.name, ...(input.details ? { details: input.details } : {}),
    variants: [{ name: 'Standard', prices: [{ unit_amount: 0, currency: 'USD', type: 'one_time' }] }],
  } })
  // The place and publication are the owner's separate decisions with their own readiness rules; the booking path reads the stored flags.
  await db.prepare('INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES (?, ?, ?, 1, 1, ?, ?)').bind(org, product.id, `${org}-site`, OWNER, OWNER).run()
  // A consultation is held by an attorney, in their own working hours.
  if (input.kind === 'service') await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, public_name, public_approved, timezone, weekly_json, time_off_json, updated_at, updated_by)
    VALUES (?, ?, 'Attorney Owner', 1, ?, ?, '[]', ?, ?) ON CONFLICT DO NOTHING`).bind(`${org}-owner`, org, ZONE, JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: '00:00', end: '23:59' }))), new Date().toISOString(), OWNER).run()
  await setProductBookingConfig(db, { organizationId: org, productId: product.id, actorId: OWNER, env, patch: { duration_minutes: 60, default_capacity: 6, confirmation_mode: 'instant',
    ...(input.kind === 'service' ? { scheduling_mode: 'provider', assigned_member_id: `${org}-owner` } : { scheduling_mode: 'business', assigned_member_id: `${org}-owner` }) } })
  await db.prepare('INSERT INTO product_publications (organization_id, product_id, published, created_by, updated_by) VALUES (?, ?, 1, ?, ?)').bind(org, product.id, OWNER, OWNER).run()
  const startsAt = localDateTimeToInstant(input.day, '10:00', ZONE, 'compatible').toISOString()
  const [session] = await createSession(db, { env, organizationId: org, productId: product.id, locationId: `${org}-site`, startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), actorId: OWNER, idempotencyKey: `${product.id}-session` })
  return { product, session: session!, startsAt }
}

const operator = (key: string) => ({ userId: OWNER, idempotencyKey: key, source: 'operator', externalReference: null, guestAcknowledgement: false })

test('Today shows every booking type as one card for its own business, with the welcome as its action only where it applies', { timeout: 180_000 }, async () => {
  const { runtime, db, env, event, today } = await boot()
  try {
    const localToday = localDateAt(new Date(), ZONE)
    const inTwoDays = addLocalDays(localToday, 2), inThreeDays = addLocalDays(localToday, 3)

    // A legal consultation with preparation, and one without.
    const preparation = 'Gather any existing will or trust documents and a list of your assets.'
    const estate = await offering(db, env, 'law', { kind: 'service', name: 'Estate Planning Consultation', day: inTwoDays,
      details: { preparation, what_to_bring: ['Photo ID', 'Current will'] } })
    const intake = await offering(db, env, 'law', { kind: 'service', name: 'Initial Case Review', day: inThreeDays })
    const book = async (org: Org, slug: string, sessionId: string, guest: string, party: number, key: string) => {
      const created = await createProductBooking(event(), { organizationId: org, slug, financialWritesAllowed: false, operator: operator(key),
        body: { guest_name: guest, guest_email: `${key}@proof.example`, product_session_id: sessionId, party_size: party } })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      return created.body.conversation_id as string
    }
    const evaConsultation = await book('law', estate.product.slug, estate.session.id, 'Eva Ortiz', 1, 'eva-consultation')
    const ianConsultation = await book('law', intake.product.slug, intake.session.id, 'Ian Reed', 1, 'ian-consultation')

    // An experience with only something to bring.
    const pottery = await offering(db, env, 'studio', { kind: 'experience', name: 'Wheel Throwing Class', day: inTwoDays, details: { what_to_bring: ['Clothes that can get muddy'] } })
    await book('studio', pottery.product.slug, pottery.session.id, 'Bruno Silva', 3, 'bruno-class')

    // A home whose arrival guide has directions and wifi.
    const manager: StayAccess = { organizationId: 'inn', actorId: OWNER, manage: true }
    const home = await createProduct(db, { env, organizationId: 'inn', actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Seaview Cottage', variants: [{ name: 'Night', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'inn-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 6, min_nights: 1, assigned_member_id: 'inn-owner' },
    } })
    const directions = 'Take the coast road past the lighthouse; the cottage is the blue door.'
    await updateStayHome(env, db, manager, home.id, { directions, wifi_network: 'Seaview', wifi_password: 'saltwater' })
    const stay = await createStay(db, env, manager, { product_id: home.id, idempotency_key: 'diana-stay', check_in_date: inTwoDays, check_out_date: addLocalDays(inTwoDays, 3),
      adults: 2, children: 0, guest_name: 'Diana Lee', guest_email: 'diana@proof.example', total_minor: 45_000 })
    assert.ok(stay.conversation_id, 'a stay with a guest email has a conversation')

    // A table reservation: a booking of the bistro's tables at 18:00.
    const tables = await createTables(db, env, { organizationId: 'bistro', locationId: 'bistro-site', actorId: OWNER, memberId: 'bistro-owner', name: 'Bistro table',
      durationMinutes: 90, seats: 20, open: '17:00', lastSeating: '20:00' })
    const evening = localDateTimeToInstant(inTwoDays, '18:00', ZONE, 'compatible').toISOString()
    const seating = (await listBookableSessions(db, { env, organizationId: 'bistro', productId: tables.id, fromInstant: evening, toInstant: new Date(Date.parse(evening) + 1).toISOString() }))[0]
    assert.equal(seating?.starts_at, evening)
    const table = await createProductBooking(event(), { organizationId: 'bistro', slug: tables.slug, financialWritesAllowed: false, operator: operator('nora-table'),
      body: { guest_name: 'Nora Park', guest_email: 'nora@proof.example', guest_phone: '+66812345679', product_session_id: seating!.id, party_size: 4 } })
    assert.equal(table.status, 201, JSON.stringify(table.body))

    const law = await today('law', 'upcoming'), studio = await today('studio', 'upcoming'), inn = await today('inn', 'upcoming'), bistro = await today('bistro', 'upcoming')
    const shape = (card: TodayItem) => ({ id: card.id, headline: card.headline, line: card.line, action: card.action, to: card.to })
    const visit = (instant: string) => `${new Intl.DateTimeFormat('en', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(instant))} · ${new Intl.DateTimeFormat('en', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(instant))}`
    const record = async (conversationId: string) => String(await db.prepare('SELECT booking_id FROM conversations WHERE id = ?').bind(conversationId).first('booking_id'))

    // Each business sees its own bookings and nothing of another's, in the business's own word.
    assert.deepEqual(law.cards.map(shape), [
      { id: `booking:${await record(evaConsultation)}`, headline: 'Eva’s consultation', line: 'Estate Planning Consultation · law office', action: { title: 'Share how to prepare', detail: 'Help Eva get ready' }, to: `/dashboard/law/messages/${evaConsultation}` },
      { id: `booking:${await record(ianConsultation)}`, headline: 'Ian’s consultation', line: 'Initial Case Review · law office', action: { title: 'Say hello to your guests', detail: 'See if they have any questions' }, to: `/dashboard/law/messages/${ianConsultation}` },
    ])
    assert.deepEqual([law.title, law.cards[0]!.when], ['You have 2 upcoming consultations', visit(estate.startsAt)])
    // A class is one card for everyone booked into it.
    assert.deepEqual(studio.cards.map(shape), [
      { id: `class:${pottery.session.id}`, headline: 'Wheel Throwing Class', line: 'studio office · 3 guests', action: { title: 'Message the class', detail: 'See who is coming' },
        to: `/dashboard/studio/calendar/sessions/${pottery.session.id}?date=${inTwoDays}&product_id=${pottery.product.id}` },
    ])
    assert.equal(studio.title, 'You have 1 upcoming class')
    // The owner looks after the home, so the clean after Diana's stay is theirs too, on its own day.
    const turnover = String(await db.prepare("SELECT id FROM tasks WHERE kind = 'turnover' AND subject_id = ?").bind(stay.id).first('id'))
    assert.deepEqual(inn.cards.map(shape), [
      { id: `booking:${stay.id}`, headline: 'Diana’s group of 2', line: 'Seaview Cottage', action: { title: 'Share info about your place', detail: 'Help Diana get ready' }, to: `/dashboard/inn/messages/${stay.conversation_id}` },
      { id: `task:${turnover}`, headline: 'Clean up after Diana’s group of 2', line: 'Seaview Cottage', action: { title: 'Tap Done when it’s finished', detail: 'In Diana’s conversation' }, to: `/dashboard/inn/messages/${stay.conversation_id}` },
    ])
    assert.equal(inn.title, 'You have 1 upcoming reservation and 1 upcoming home to clean')
    // A make-ready job at a home with no check-in time is the arrival's work: it is the action of Diana's card, not a card on her checkout day.
    await db.batch(stayReadyTaskQueries({ organizationId: 'inn', stayId: stay.id, now: new Date().toISOString(), previousProductId: home.id, guard: { query: '1', params: [] }, guestName: 'Diana Lee', checkInDate: inTwoDays,
      home: { product_id: home.id, location_id: 'inn-site', timezone: ZONE, check_in_time: null, internal_name: 'Seaview Cottage', assigned_member_id: 'inn-owner' } }).map(query => db.prepare(query.query).bind(...query.params ?? [])))
    assert.deepEqual((await today('inn', 'upcoming')).cards.map(card => [card.id, card.action.title]), [[`booking:${stay.id}`, 'You’re cleaning'], [`task:${turnover}`, 'Tap Done when it’s finished']])
    assert.equal(inn.cards[0]!.when, `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).formatRange(new Date(`${inTwoDays}T00:00:00Z`), new Date(`${addLocalDays(inTwoDays, 3)}T00:00:00Z`)).replace(/[\u2009\u202f]/g, ' ')}`)
    // A restaurant has no host-written preparation, so its reservation has no welcome.
    assert.deepEqual(bistro.cards.map(shape), [
      { id: `booking:${table.body.booking_id}`, headline: 'Nora’s group of 4', line: 'bistro office', action: { title: 'Say hello to your guests', detail: 'See if they have any questions' }, to: `/dashboard/bistro/messages/${table.body.conversation_id}` },
    ])
    assert.equal(bistro.title, 'You have 1 upcoming reservation')
    // Upcoming bookings are not today's: Today holds only the setup a business that cannot take payment has left.
    for (const org of Object.keys(ORGS) as Org[]) {
      const { title, cards } = await today(org, 'today')
      // The bistro's tables are not a menu: it still has its first dish to add.
      const dish = org === 'bistro' ? [['product.create:bistro', 'Add your first dish', 'Start your menu', '/dashboard/bistro/products/new?kind=dish']] : []
      assert.deepEqual({ title, cards: cards.map(card => [card.id, card.headline, card.action.title, card.to]) },
        { title: 'Finish setting up to take bookings', cards: [[`payments.connect:${org}`, 'Set up payments', 'Connect with Stripe', `/dashboard/${org}/payments/payout-method`], ...dish] })
    }

    // The message is written from the offering's and the home's own fields, and the conversation opens with it.
    const consultationMessage = law.cards[0]!.draft!
    assert.match(consultationMessage, /^Hi Eva,\n\nLooking forward to seeing you for Estate Planning Consultation on .+\.\n\n/)
    assert.ok(consultationMessage.endsWith(`Before you arrive:\n${preparation}\n\nWhat to bring:\n- Photo ID\n- Current will`), consultationMessage)
    const stayMessage = inn.cards[0]!.draft!
    assert.match(stayMessage, /^Hi Diana,\n\nLooking forward to hosting you at Seaview Cottage from .+\.\n\n/)
    assert.ok(stayMessage.endsWith(`Directions:\n${directions}\n\nWifi details:\nWifi network: Seaview\nWifi password: saltwater`), stayMessage)
    assert.equal(law.cards[1]!.draft, null)

    // MCP's list_opportunities lists the same welcome, with the same message.
    const membership = await resolveOrganizationMembership(env, { organizationId: 'law', userId: OWNER })
    assert.ok(membership)
    const organization: McpExecutorContext['organization'] = { env, db, membership, organizationId: 'law', userId: OWNER, role: 'owner', isPlatformAdmin: false, scopes: [] }
    const welcomes = async () => ((await handleTaskTools({ toolName: 'list_opportunities', organization, args: {} })) as { opportunities: OpportunityView[] }).opportunities
      .filter(opportunity => opportunity.conversation_id !== null).map(opportunity => [opportunity.id, opportunity.conversation_id, opportunity.message])
    assert.deepEqual(await welcomes(), [[`booking.welcome:${evaConsultation}`, evaConsultation, consultationMessage]])

    // The host's message takes the welcome off the card; the card stays.
    const replied = await sendGuestThreadReply(db, { threadId: evaConsultation, organizationId: 'law', body: consultationMessage,
      actorUserId: OWNER, idempotencyKey: 'eva-welcome', env })
    assert.equal(replied.ok, true, JSON.stringify(replied))
    const after = await today('law', 'upcoming')
    assert.deepEqual(after.cards.map(card => [card.headline, card.action.title, card.draft]), [
      ['Eva’s consultation', 'Say hello to your guests', null],
      ['Ian’s consultation', 'Say hello to your guests', null],
    ])
    assert.deepEqual(await welcomes(), [])
    // The sent message is the conversation's, read back from the ledger.
    assert.equal(await db.prepare("SELECT body FROM messages WHERE conversation_id = ? AND author_kind = 'member'").bind(evaConsultation).first('body'), consultationMessage)
  } finally {
    await runtime.dispose()
  }
})
