import { createReplayableReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import { formQuestionsRevision } from '../../shared/form-questions.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { listAgenda, listTodayAgenda } from '../../server/utils/dashboard-agenda.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { Miniflare } from 'miniflare'
import { bindDatabaseEvents } from '../../server/db/index.ts'
import { createProduct, deleteProduct, getProduct, removeProductLocation, setProductLocation, setProductPublication, updateProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, cancelStay, createStay, deleteStayPayment, getStay, readHomeCalendar, readStayCalendar, readStayHome, recordStayPayment, importStayNights, quoteStay, setStayNights, stayCheckoutPolicy, updateStay, updateStayHome, type GuestStay, type StayAccess } from '../../server/domain/stays.ts'
import { listTasks, parseTaskListQuery, taskViewer } from '../../server/domain/tasks.ts'
import { writeMemberScheduling } from '../../server/domain/member-scheduling.ts'
import { H3Event } from 'h3'
import { H3 } from 'nitro/h3'
import { createAuth } from '../../server/utils/auth.ts'
import guestStayRoute from '../../server/api/public/guest-stays/[activity_id].get.ts'
import accountCancelRoute from '../../server/api/account/bookings/[booking_id]/cancel.post.ts'
import accountStayRoute from '../../server/api/account/bookings/[booking_id].get.ts'
import accountPayRoute from '../../server/api/account/bookings/[booking_id]/pay.post.ts'
import dashboardBookingPatchRoute from '../../server/api/dashboard/bookings/[booking_id].patch.ts'
import paymentHandoffRoute from '../../server/api/public/payments/[payment_id].get.ts'
import paymentConfirmRoute from '../../server/api/public/payments/[payment_id]/confirm.post.ts'
import paymentReviewRoute from '../../server/api/public/payments/[payment_id]/review.post.ts'
import { createProductBooking, notifyProductBookingCreated } from '../../server/domain/product-bookings.ts'
import publicBookingRoute from '../../server/api/public/products/[slug]/book.post.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { getThreadOperationalRecord, requestActions } from '../../server/domain/requests.ts'
import { cancelStayAsGuest, createStayRequest, dispatchStayCheckoutDeadlines, readPublicStayHome } from '../../server/domain/stays.ts'
import { projectStripeConnectedAccount, reserveStripeConnectedAccount } from '../../server/utils/stripe-connect.ts'
import paymentReturnRoute from '../../server/api/public/payments/[payment_id]/return.post.ts'
import { updateLocation } from '../../server/utils/location-management.ts'
import { listOrganizationNotificationMembers, memberAccessPrincipal, resolveMembership, resolveOrganizationMembership } from '../../server/utils/member-access.ts'
import { assertConversationAccess } from '../../server/domain/conversations.ts'
import { listScheduledGuestMessages, saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { handleStaysTools, STAYS_TOOLS } from '../../server/utils/mcp-tools/stays.ts'
import { BOOKINGS_TOOLS, handleBookingsTools } from '../../server/utils/mcp-tools/bookings.ts'
import type { McpOrganizationContext } from '../../server/utils/mcp-auth.ts'
import Ajv from 'ajv'
import { STAY_HOME_ACCESSIBILITY_FEATURES } from '../../shared/stay-accessibility.ts'
import { hashPassword } from 'better-auth/crypto'
import { updateOrganizationSettingsFields } from '../../server/utils/organization-settings.ts'
import { buyStay } from './support/stay-checkout.ts'
import { captureEvents } from './support/events.ts'
import { applySchema } from './support/schema.ts'

// A stay write posts its cleaning job and alerts the person doing it, so every environment here can send: logged, never delivered.
const JOB_ALERT_ENV = { MEDIA_BASE_URL: 'https://media.example.test', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-stay-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' }



const ORG = 'org'
const OWNER = 'owner-user'
const CLEANER = 'cleaner-user'
const OUTSIDER = 'outsider-user'
type GuestStayAccount = Omit<GuestStay, 'stay'> & { booking: Omit<GuestStay['stay'], 'id'> & { booking_id: string; unit: 'nights' } }
const NOW = '2026-10-14T00:00:00.000Z'
const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
const cleaner: StayAccess = { organizationId: ORG, actorId: CLEANER, manage: false, userId: CLEANER }
const outsider: StayAccess = { organizationId: ORG, actorId: OUTSIDER, manage: false, userId: OUTSIDER }

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stays-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `
      export class Hub {
        constructor(ctx) { this.ctx = ctx }
        async fetch(request) {
          const url = new URL(request.url)
          const storage = this.ctx.storage
          if (url.pathname === '/observed') return Response.json(await storage.get('events') ?? [])
          if (url.pathname === '/deadlines') return Response.json(await storage.get('deadlines') ?? [])
          if (url.pathname === '/wake') {
            await storage.put('deadlines', [...await storage.get('deadlines') ?? [], await request.json()])
            return new Response(null, { status: 204 })
          }
          if (url.pathname === '/failure') {
            await storage.put('failure', request.method === 'PUT' ? url.searchParams.get('type') ?? '*' : '')
            return new Response(null, { status: 204 })
          }
          const event = await request.json()
          await storage.put('events', [...await storage.get('events') ?? [], event])
          const failure = await storage.get('failure')
          if (failure === '*' || failure === event.type) return new Response('Publication refused', { status: 503 })
          return new Response(null, { status: 204 })
        }
      }
      export default { fetch() { return new Response('ok') } }
    ` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stays-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), ...JOB_ALERT_ENV, DB: db, EVENTS: queue.binding, BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests' } as CloudflareEnv
    bindDatabaseEvents(db, env)
    await applySchema(db)
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
    for (const [id, role] of [[OWNER, 'owner'], [CLEANER, 'member'], [OUTSIDER, 'member']] as const) {
      await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)").bind(id, id, `${id}@example.test`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
    }
    for (const loc of ['cabin-site', 'lake-site']) {
      await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 'America/Denver', ?, ?)`).bind(loc, ORG, loc, loc, NOW, NOW).run()
    }
    return { runtime, db, env, queue }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

async function home(db: D1Database, env: CloudflareEnv, input: { name: string; location: string; member?: string }) {
  return createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
    kind: 'stay', name: input.name,
    variants: [{ name: input.name, prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
    stay: { location_id: input.location, check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: input.member ?? `m-${OWNER}` },
  } })
}

function code(expected: string) {
  return (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected
}

const guest = { adults: 2, guest_name: 'Ana', total_minor: 45_000 }

test('a place to stay is a Product at exactly one location, priced per night', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    await assert.rejects(createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'stay', name: 'No rules' } }), /needs its location/)
    await assert.rejects(createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: { kind: 'dish', name: 'Soup', stay: { location_id: 'cabin-site', check_in_time: '16:00', check_out_time: '10:00', max_guests: 2, min_nights: 1, assigned_member_id: null } } }), /Only a place to stay/)
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site', member: `m-${CLEANER}` })
    assert.equal(cabin.kind, 'stay')
    assert.equal(cabin.unit_label, 'night')
    assert.deepEqual(cabin.stay, { internal_name: 'Cabin', location_id: 'cabin-site', check_in_time: '16:00', check_in_end_time: null, check_out_time: '10:00', max_guests: 4, min_nights: 2, calendar_rules: null,
      property_type_group: null, property_type: null, listing_type: null, total_floors: null, listing_floor: null, year_built: null, property_size: null, property_size_unit: null,
      bedrooms: null, beds: null, bathrooms: null, amenities: [], amenity_answers: [], cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm', assigned_member_id: `m-${CLEANER}`, live: false, photo_rooms: [],
      accessibility: Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).map(feature => ({ feature, available: null, photo_ids: [] })),
      questions: [], questions_revision: formQuestionsRevision([]) })
    // Property classification is either one authored pair or fully unknown.
    // A partial SQL write must refuse the whole edit before canonical readers
    // can encounter a contradictory property classification.
    for (const propertyType of [{ property_type_group: 'houses', property_type: 'cabin' }, { property_type_group: null, property_type: null }] as const) {
      await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: propertyType } })
      const classified = (await getProduct(db, ORG, cabin.id)).stay
      assert.equal(classified?.property_type_group, propertyType.property_type_group)
      assert.equal(classified?.property_type, propertyType.property_type)
      for (const partial of [['houses', null], [null, 'cabin']] as const) {
        await assert.rejects(db.prepare('UPDATE product_stay_configs SET property_type_group = ?, property_type = ? WHERE organization_id = ? AND product_id = ?').bind(...partial, ORG, cabin.id).run(), /product_stay_configs_property_type_check/)
        assert.deepEqual((await getProduct(db, ORG, cabin.id)).stay, classified)
      }
    }
    // Its one location shows it; the product's publication decides whether anyone does.
    assert.deepEqual(cabin.locations, [{ location_id: 'cabin-site', active: true, published: true }])
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { location_id: 'lake-site', max_guests: 2 } as never } }), /keeps its location/)
    assert.deepEqual((await getProduct(db, ORG, cabin.id)).locations.map(location => location.location_id), ['cabin-site'])
    await assert.rejects(setProductLocation(db, { organizationId: ORG, productId: cabin.id, locationId: 'lake-site', actor: { actorId: OWNER } }), /exactly one location/)
    await assert.rejects(removeProductLocation(db, { organizationId: ORG, productId: cabin.id, locationId: 'cabin-site' }), /cannot leave the location/)
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { kind: 'experience' } }), /keeps its kind/)
    // Guests book a place to stay on the site and pay in full, so it takes no external booking link.
    await assert.rejects(updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { order_url: 'https://www.airbnb.com/rooms/1' } }), /takes no external booking link/)
    const edited = await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { stay: { max_guests: 6 } } })
    // A save that does not name stay settings leaves them as stored, even if they changed meanwhile.
    await db.prepare('UPDATE product_booking_configs SET min_nights = 5 WHERE product_id = ?').bind(cabin.id).run()
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { name: 'Cliff Cabin' } })
    assert.equal((await getProduct(db, ORG, cabin.id)).stay?.min_nights, 5)
    assert.equal(edited.stay?.max_guests, 6)
    assert.equal(edited.stay?.location_id, 'cabin-site')
  } finally {
    await runtime.dispose()
  }
})

test('a stay holds its nights, and a held night refuses another stay even when two arrive at once', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const first = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })
    assert.equal(first.status, 'confirmed')
    assert.equal(first.owner, 'app')
    assert.equal(first.currency, 'USD')
    assert.equal(first.payment_status, 'unpaid')
    // The same key replays the same stay; a different stay under it is refused.
    assert.equal((await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })).id, first.id)
    const persistedBeforeRetries = await getStay(db, manager, first.id)
    for (const patch of [{ adults: 1 }, { children: 1 }, { infants: 1 }, { arrival_time: '18:30' }, { guest_name: 'Ana Changed' }, { guest_email: 'changed@example.test' }, { guest_phone: '+61491570154' }, { private_notes: 'Different arrival note' }]) {
      await assert.rejects(createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest, ...patch }), code('IDEMPOTENCY_CONFLICT'))
      assert.deepEqual(await getStay(db, manager, first.id), persistedBeforeRetries)
    }
    await assert.rejects(createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k1', check_in_date: '2026-11-02', check_out_date: '2026-11-04', ...guest }), code('IDEMPOTENCY_CONFLICT'))
    await assert.rejects(createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k2', check_in_date: '2026-11-03', check_out_date: '2026-11-06', ...guest }), code('STAY_OVERLAP'))
    // Checkout morning is the next guest's check-in.
    const next = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k3', check_in_date: '2026-11-04', check_out_date: '2026-11-06', ...guest })
    assert.equal(next.check_in_date, '2026-11-04')
    await assert.rejects(createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'k4', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest, adults: 5 }), code('INVALID_STAY_FIELD'))

    const racers = await Promise.allSettled(['r1', 'r2', 'r3'].map(key => createStay(db, env, manager, { product_id: cabin.id, idempotency_key: key, check_in_date: '2026-12-01', check_out_date: '2026-12-05', ...guest })))
    assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of racers.filter(result => result.status === 'rejected')) assert(code('STAY_OVERLAP')((result as PromiseRejectedResult).reason))
    const claims = await db.prepare("SELECT count(*) AS n FROM stay_nights WHERE product_id = ? AND date >= '2026-12-01' AND date < '2026-12-05'").bind(cabin.id).first<{ n: number }>()
    assert.equal(claims?.n, 4)
  } finally {
    await runtime.dispose()
  }
})

test('editing and cancelling a stay move and free exactly its nights, under its version', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'a', check_in_date: '2026-11-01', check_out_date: '2026-11-03', ...guest })
    await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'b', check_in_date: '2026-11-10', check_out_date: '2026-11-12', ...guest })
    const beforeEmptyEdit = await getStay(db, manager, stay.id)
    for (const patch of [{}, { guest_name: stay.guest_name }]) {
      await assert.rejects(updateStay(db, env, manager, stay.id, { version: 1, ...patch }), code('INVALID_STAY_FIELD'))
      assert.deepEqual(await getStay(db, manager, stay.id), beforeEmptyEdit)
    }
    await assert.rejects(updateStay(db, env, manager, stay.id, { version: 99, check_out_date: '2026-11-04' }), code('STAY_VERSION_CONFLICT'))
    await assert.rejects(updateStay(db, env, manager, stay.id, { version: 1, check_in_date: '2026-11-09', check_out_date: '2026-11-11' }), code('STAY_OVERLAP'))
    // A refused move leaves the stay and its nights where they were.
    assert.deepEqual((await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-03' })).nights.map(night => night.booking_id), [stay.id, stay.id])
    const moved = await updateStay(db, env, manager, stay.id, { version: 1, check_in_date: '2026-11-05', check_out_date: '2026-11-08', guest_phone: '+61491570154' })
    assert.equal(moved.version, 2)
    assert.equal(moved.guest_phone, '+61491570154')
    const calendar = await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-09' })
    // The calendar reads its full 500 nights, with the stays in them.
    const year = await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2028-03-15' })
    assert.equal(year.nights.length, 500)
    assert.ok(year.stays.some(row => row.booking_id === stay.id))
    assert.deepEqual(calendar.nights.map(night => night.available), [true, true, true, true, false, false, false, true])
    assert.equal(calendar.nights[0]!.price_minor, 15_000)
    // Two edits from the same version race; whichever wins, the nights held are the winner's.
    const racers = await Promise.allSettled([
      updateStay(db, env, manager, stay.id, { version: 2, check_in_date: '2026-11-20', check_out_date: '2026-11-22' }),
      updateStay(db, env, manager, stay.id, { version: 2, check_in_date: '2026-11-25', check_out_date: '2026-11-28' }),
    ])
    assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1)
    const winner = await getStay(db, manager, stay.id)
    const held = await db.prepare('SELECT date FROM stay_nights WHERE booking_id = ? ORDER BY date').bind(stay.id).all<{ date: string }>()
    const expected: string[] = []
    for (let day = Date.parse(`${winner.check_in_date}T00:00:00Z`); day < Date.parse(`${winner.check_out_date}T00:00:00Z`); day += 86_400_000) expected.push(new Date(day).toISOString().slice(0, 10))
    assert.deepEqual(held.results.map(row => row.date), expected)
    const cancelled = await cancelStay(db, env, manager, stay.id, { version: 3, reason: 'Guest changed plans' })
    assert.equal(cancelled.status, 'cancelled')
    assert.ok(cancelled.cancelled_at)
    const afterCancellation = await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-05', to: '2026-11-30' })
    assert.equal(afterCancellation.nights.length, 25)
    assert(afterCancellation.nights.every(night => night.booking_id !== stay.id))
    await assert.rejects(updateStay(db, env, manager, stay.id, { version: 4, adults: 1 }), code('STAY_NOT_EDITABLE'))
    assert.equal(afterCancellation.stays.some(row => row.booking_id === stay.id), false)
    const audit = await db.prepare("SELECT event_name FROM activity_entries WHERE organization_id = ? AND event_name LIKE 'stay.%' ORDER BY occurred_at, event_name").bind(ORG).all<{ event_name: string }>()
    assert.deepEqual(audit.results.map(row => row.event_name).sort(), ['stay.cancelled', 'stay.created', 'stay.created', 'stay.updated', 'stay.updated'])
  } finally {
    await runtime.dispose()
  }
})

test('a channel stay is read-only here and is paid through its channel; an app stay records offline payments', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    // The channel's reservation lands through its revision feed, as every channel stay does.
    const { id: channelStayId } = await applyChannelBooking(db, env, ORG, cabin.id, { provider: 'channex', external_booking_id: 'chx-1', channel_booking_id: 'HMBO1234', channel: 'airbnb',
      revision_id: 'chx-1-revision', provider_updated_at: NOW, cancelled: false, check_in_date: '2026-11-20', check_out_date: '2026-11-22', adults: 2, children: 0, infants: 0,
      guest_name: 'Bo', guest_surname: null, guest_email: null, guest_phone: null, total_minor: 30_000, currency: 'USD', imported: false })
    // The refusal links to the reservation on Airbnb, read from the confirmation code Channex sent.
    const airbnb = 'https://www.airbnb.com/hosting/reservations/details/HMBO1234'
    const onAirbnb = (message: string) => (error: unknown) => code('STAY_NOT_EDITABLE')(error)
      && (error as { data: { channel_booking_url: unknown } }).data.channel_booking_url === airbnb && (error as Error).message === message
    await assert.rejects(updateStay(db, env, manager, channelStayId, { version: 1, adults: 1 }), onAirbnb(`This stay belongs to Airbnb; change it there: ${airbnb}`))
    await assert.rejects(cancelStay(db, env, manager, channelStayId, { version: 1 }), onAirbnb(`This stay belongs to Airbnb; change it there: ${airbnb}`))
    await assert.rejects(recordStayPayment(db, env, manager, channelStayId, { amount_minor: 100, method: 'cash', paid_on: '2026-11-20', idempotency_key: 'pay-1' }), onAirbnb(`This stay is paid through Airbnb; change it there: ${airbnb}`))
    assert.equal((await getStay(db, manager, channelStayId)).payment_status, null)
    assert.equal((await getStay(db, manager, channelStayId)).channel_booking_url, airbnb)

    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'p', check_in_date: '2026-11-01', check_out_date: '2026-11-04', ...guest })
    await assert.rejects(recordStayPayment(db, env, manager, stay.id, { amount_minor: 0, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'pay-2' }), code('INVALID_AMOUNT'))
    await assert.rejects(recordStayPayment(db, env, manager, stay.id, { amount_minor: 100, method: 'crypto', paid_on: '2026-11-01', idempotency_key: 'pay-3' }), code('INVALID_STAY_FIELD'))
    const partial = await recordStayPayment(db, env, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', reference: 'deposit', idempotency_key: 'pay-4' })
    assert.deepEqual([partial.stay.paid_minor, partial.stay.payment_status, partial.stay.payments.length], [20_000, 'partial', 1])
    // Money is recorded in USD: the business currency no longer changes.
    assert.deepEqual(await updateOrganizationSettingsFields(db, env, ORG, { default_currency: 'EUR' }, OWNER),
      { status: 409, data: { error: 'The business currency cannot change once money has been recorded or a channel is connected', code: 'CURRENCY_FIXED' } })
    assert.equal(await db.prepare('SELECT default_currency FROM organization WHERE id = ?').bind(ORG).first('default_currency'), 'USD')
    const storedPayment = await db.prepare('SELECT id, amount_minor, reference, note FROM offline_payments WHERE organization_id = ? AND booking_id = ? AND idempotency_key = ?').bind(ORG, stay.id, 'pay-4').first<{ id: string; amount_minor: number; reference: string | null; note: string | null }>()
    assert.deepEqual(storedPayment, { id: partial.payment.id, amount_minor: 20_000, reference: 'deposit', note: null })
    // A retried record is the same payment; the same key for another payment is refused.
    const retried = await recordStayPayment(db, env, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', reference: 'deposit', idempotency_key: 'pay-4' })
    assert.equal(retried.stay.payments.length, 1)
    assert.deepEqual(retried.payment, partial.payment)
    for (const patch of [{ reference: 'Changed reference' }, { note: 'Changed note' }]) {
      await assert.rejects(recordStayPayment(db, env, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', reference: 'deposit', idempotency_key: 'pay-4', ...patch }), code('IDEMPOTENCY_CONFLICT'))
      assert.deepEqual((await getStay(db, manager, stay.id)).payments, partial.stay.payments)
    }
    await assert.rejects(recordStayPayment(db, env, manager, stay.id, { amount_minor: 1, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'pay-4' }), code('IDEMPOTENCY_CONFLICT'))
    const paid = await recordStayPayment(db, env, manager, stay.id, { amount_minor: 25_000, method: 'bank_transfer', paid_on: '2026-11-02', idempotency_key: 'pay-5' })
    assert.deepEqual([paid.stay.paid_minor, paid.stay.payment_status], [45_000, 'paid'])
    const refunded = await recordStayPayment(db, env, manager, stay.id, { amount_minor: -5_000, method: 'cash', paid_on: '2026-11-03', note: 'Early checkout', idempotency_key: 'pay-6' })
    assert.equal(refunded.stay.payment_status, 'partial')
    const removed = await deleteStayPayment(db, env, manager, stay.id, refunded.payment.id)
    assert.deepEqual([removed.paid_minor, removed.payment_status], [45_000, 'paid'])
    await assert.rejects(deleteStayPayment(db, env, manager, stay.id, 'missing'), code('PAYMENT_NOT_FOUND'))

    // A guest who already paid: the stay and its first payment are one write, and a replay adds no second payment.
    const withPayment = { product_id: cabin.id, idempotency_key: 'paid-up-front', check_in_date: '2026-12-10', check_out_date: '2026-12-12', ...guest, payment: { amount_minor: 45_000, method: 'cash', paid_on: '2026-12-01', reference: 'cash at the door' } }
    const prepaid = await createStay(db, env, manager, withPayment)
    assert.deepEqual([prepaid.paid_minor, prepaid.payment_status, prepaid.payments.length, prepaid.payments[0]!.method, prepaid.payments[0]!.reference], [45_000, 'paid', 1, 'cash', 'cash at the door'])
    assert.equal((await createStay(db, env, manager, withPayment)).payments.length, 1)
    for (const payment of [null, { ...withPayment.payment, reference: 'Changed initial reference' }, { ...withPayment.payment, note: 'Changed initial note' }, { ...withPayment.payment, amount_minor: 44_000 }]) {
      await assert.rejects(createStay(db, env, manager, { ...withPayment, payment }), code('IDEMPOTENCY_CONFLICT'))
      assert.deepEqual((await getStay(db, manager, prepaid.id)).payments, prepaid.payments)
    }
    assert.equal(await db.prepare('SELECT count(*) FROM offline_payments WHERE booking_id = ?').bind(prepaid.id).first('count(*)'), 1)
    // A bad payment stops the whole create: no stay, no nights.
    await assert.rejects(createStay(db, env, manager, { ...withPayment, idempotency_key: 'bad-payment', check_in_date: '2026-12-20', check_out_date: '2026-12-22', payment: { amount_minor: -100, method: 'cash', paid_on: '2026-12-01' } }), { status: 422, data: { code: 'INVALID_AMOUNT', field: 'payment.amount_minor' } })
    await assert.rejects(createStay(db, env, manager, { ...withPayment, idempotency_key: 'bad-method', check_in_date: '2026-12-20', check_out_date: '2026-12-22', payment: { amount_minor: 100, method: 'crypto', paid_on: '2026-12-01' } }), { status: 422, data: { code: 'INVALID_STAY_FIELD', field: 'payment.method' } })
    assert.equal(await db.prepare("SELECT count(*) FROM bookings WHERE idempotency_key IN ('bad-payment', 'bad-method')").first('count(*)'), 0)
  } finally {
    await runtime.dispose()
  }
})

test('the host sets nights apart from the defaults and resets them', { timeout: 120_000 }, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
  const { runtime, db, env } = await boot()
  try {
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const beforeRefusedSettings = await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-04' })
    for (const patch of [{}, { reset: false }, { reset: true, closed: true }, { reset: true, price_minor: null }, { min_stay_through: 3, price_minor: 200_00 }]) {
      await assert.rejects(setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-04', ...patch }), code('INVALID_STAY_FIELD'))
      assert.deepEqual(await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-04' }), beforeRefusedSettings)
    }
    const closed = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-03', closed: true })
    assert.deepEqual(closed.nights.map(night => [night.available, night.source]), [[false, 'host'], [false, 'host']])
    const priced = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-02', to: '2026-11-04', price_minor: 20_000, min_stay_arrival: 3 })
    assert.deepEqual(priced.nights.map(night => [night.date, night.closed, night.price_minor, night.min_stay_arrival]), [['2026-11-02', true, 20_000, 3], ['2026-11-03', false, 20_000, 3]])
    const based = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-03', to: '2026-11-04', price_minor: null })
    assert.equal(based.nights[0]!.price_minor, 15_000)
    const reset = await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-04', reset: true })
    assert(reset.nights.every(night => night.available && night.source === null && night.price_minor === 15_000))
    // A percent moves only the chosen weekdays, each night from its own price; 2026-11-01 is a Sunday.
    await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-01', to: '2026-11-08', price_change_percent: 5, weekdays: [0] })
    assert.deepEqual((await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-01', to: '2026-11-04' })).nights.map(night => night.price_minor), [15_750, 15_000, 15_000])
    // A closed night is the host's choice for guests; it does not hold a stay the host takes themselves.
    await setStayNights(db, env, manager, { product_id: cabin.id, from: '2026-11-10', to: '2026-11-11', closed: true })
    await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'closed', check_in_date: '2026-11-10', check_out_date: '2026-11-11', ...guest })
    // The explicit home default remains canonical. A dated arrival exception
    // affects only stays starting on that date, not a stay crossing it.
    await assert.rejects(updateStayHome(env, db, manager, cabin.id, { min_nights: null }), code('INVALID_DETAIL'))
    assert.equal((await getProduct(db, ORG, cabin.id)).stay!.min_nights, 2)
    await importStayNights(db, env, manager, cabin.id, [
      { date: '2026-11-20', available: true, price_minor: 15_000, min_stay_arrival: 21, max_stay: null, closed_to_arrival: false, closed_to_departure: false },
      { date: '2026-11-21', available: true, price_minor: 15_000, min_stay_arrival: 2, max_stay: null, closed_to_arrival: false, closed_to_departure: false },
    ])
    const datedHome = await readStayHome(db, manager, cabin.id)
    const dated = await readHomeCalendar(db, manager, { productId: cabin.id, from: '2026-11-20', to: '2026-11-22' })
    assert.equal(dated.home.min_nights, 2)
    assert.deepEqual(dated.nights.map(night => night.min_stay_arrival), [21, 2])
    assert.equal((await quoteStay(db, ORG, datedHome, { check_in_date: '2026-11-19', check_out_date: '2026-11-21', adults: 1 })).total_minor, 30_000)
    await assert.rejects(quoteStay(db, ORG, datedHome, { check_in_date: '2026-11-20', check_out_date: '2026-11-22', adults: 1 }), code('STAY_MIN_NIGHTS'))
    assert.equal((await quoteStay(db, ORG, datedHome, { check_in_date: '2026-11-22', check_out_date: '2026-11-24', adults: 1 })).total_minor, 30_000)
    // Resolved imports inherit the real policy rather than freezing a copy
    // of the default onto every date. A weekday intentionally set to the
    // same five-night minimum remains five when the default becomes nine.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: datedHome.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const future = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
    const rules = {
      day_of_week_min_nights: [-1, -1, 5, -1, -1, -1, -1],
      weekend_price_minor: 22_000,
    }
    await updateStayHome(env, db, manager, cabin.id, { min_nights: 5, base_price_minor: 17_000, calendar_rules: rules })
    const weekend = await db.prepare(`SELECT pr.unit_amount, json_type(b.calendar_rules, '$.weekend_price_minor') AS stored_in_rules
      FROM product_booking_configs b JOIN product_variants v ON v.organization_id = b.organization_id AND v.product_id = b.product_id
      JOIN prices pr ON pr.organization_id = v.organization_id AND pr.product_variant_id = v.id AND pr.weekend = 1 WHERE b.product_id = ?`).bind(cabin.id).first()
    assert.deepEqual(weekend, { unit_amount: 22000, stored_in_rules: null })
    await importStayNights(db, env, manager, cabin.id, Array.from({ length: 6 }, (_, offset) => ({
      date: `2026-12-0${offset + 1}`, available: true, price_minor: offset === 2 ? 19_000 : null,
      min_stay_arrival: offset === 2 ? 2 : null, max_stay: null, closed_to_arrival: false, closed_to_departure: false,
    })))
    const policyWindow = { productId: cabin.id, from: '2026-12-01', to: '2026-12-07' }
    assert.deepEqual((await readHomeCalendar(db, manager, policyWindow)).nights.map(night => [night.min_stay_arrival, night.price_minor]), [
      [5, 17_000], [5, 17_000], [2, 19_000], [5, 22_000], [5, 22_000], [5, 17_000],
    ])
    await updateStayHome(env, db, manager, cabin.id, { min_nights: 9, base_price_minor: 18_000 })
    const canonical = await getProduct(db, ORG, cabin.id)
    assert.equal(canonical.stay!.min_nights, 9)
    assert.deepEqual(canonical.stay!.calendar_rules, rules)
    assert.deepEqual((await readHomeCalendar(db, manager, policyWindow)).nights.map(night => [night.min_stay_arrival, night.price_minor]), [
      [9, 18_000], [5, 18_000], [2, 19_000], [9, 22_000], [9, 22_000], [9, 18_000],
    ])
    assert.deepEqual((await db.prepare("SELECT n.date, n.min_stay_arrival, pr.unit_amount AS price_minor FROM product_nights n JOIN product_variants v ON v.organization_id = n.organization_id AND v.product_id = n.product_id LEFT JOIN prices pr ON pr.organization_id = v.organization_id AND pr.product_variant_id = v.id AND pr.stay_date = n.date WHERE n.product_id = ? AND n.date >= '2026-12-01' ORDER BY date").bind(cabin.id).all()).results,
      Array.from({ length: 6 }, (_, offset) => ({ date: `2026-12-0${offset + 1}`, min_stay_arrival: offset === 2 ? 2 : null, price_minor: offset === 2 ? 19_000 : null })))
    const policyHome = await readStayHome(db, manager, cabin.id)
    await assert.rejects(quoteStay(db, ORG, policyHome, { check_in_date: '2026-12-01', check_out_date: '2026-12-06', adults: 1 }), code('STAY_MIN_NIGHTS'))
    assert.equal((await quoteStay(db, ORG, policyHome, { check_in_date: '2026-12-02', check_out_date: '2026-12-07', adults: 1 })).total_minor, 99_000)
    assert.equal((await quoteStay(db, ORG, policyHome, { check_in_date: '2026-12-03', check_out_date: '2026-12-05', adults: 1 })).total_minor, 41_000)
    const futureWeek = await readHomeCalendar(db, manager, { productId: cabin.id, from: future(501), to: future(508) })
    assert.equal(futureWeek.nights[0]!.date, future(501))
    assert.deepEqual(futureWeek.nights.map(night => [night.date, night.min_stay_arrival, night.price_minor]), Array.from({ length: 7 }, (_, offset) => {
      const date = future(501 + offset)
      const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
      return [date, weekday === 'Wednesday' ? 5 : 9, weekday === 'Friday' || weekday === 'Saturday' ? 22_000 : 18_000]
    }))
  } finally {
    await runtime.dispose()
  }
})

test('a member assigned to a home reads its guest conversation and the turnover details of its stay', { timeout: 120_000 }, async (t) => {
  const { runtime, db, env } = await boot()
  try {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T18:00:00.000Z') })
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site', member: `m-${CLEANER}` })
    const stay = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'turnover', check_in_date: '2026-11-01', check_out_date: '2026-11-03', arrival_time: '15:30',
      adults: 2, children: 1, infants: 1, guest_name: 'Ana Silva', guest_email: 'ana@example.test', private_notes: 'Door code 4411', total_minor: 45_000 })
    await recordStayPayment(db, env, manager, stay.id, { amount_minor: 20_000, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'turnover-pay' })
    assert(stay.conversation_id)
    // The recorded arrival is the stay's start; it leaves at the home's 10:00 checkout.
    const turnover = { id: stay.id, product_id: cabin.id, location_id: 'cabin-site', timezone: 'America/Denver', status: 'confirmed', starts_at: '2026-11-01T22:30:00.000Z', ends_at: '2026-11-03T17:00:00.000Z',
      check_in_date: '2026-11-01', check_out_date: '2026-11-03', adults: 2, children: 1, infants: 1, guest_name: 'Ana' }
    const window = { from: '2026-11-01', to: '2026-11-04' }

    assert.deepEqual(await getStay(db, cleaner, stay.id), turnover)
    // The calendar links the assigned member to the guest thread and limits the booking fields to turnover details.
    const calendarTurnover = { unit: 'nights', booking_id: stay.id, conversation_id: stay.conversation_id, product_id: cabin.id, status: 'confirmed', guest_name: 'Ana', adults: 2, children: 1, check_in_date: '2026-11-01', check_out_date: '2026-11-03' }
    assert.deepEqual((await readHomeCalendar(db, cleaner, { productId: cabin.id, ...window })).stays, [calendarTurnover])
    assert.deepEqual((await readStayCalendar(db, cleaner, window)).stays, [calendarTurnover])
    // Owners and admins read the whole stay, unchanged.
    const whole = await getStay(db, manager, stay.id)
    assert.deepEqual([whole.guest_name, whole.guest_email, whole.private_notes, whole.total_minor, whole.paid_minor, whole.payments.length, whole.conversation_id], ['Ana Silva', 'ana@example.test', 'Door code 4411', 45_000, 20_000, 1, stay.conversation_id])
    assert.equal((await readStayCalendar(db, manager, window)).stays[0]!.guest_name, 'Ana Silva')
    // A site checkout saves the guest's whole name in guest_name; the member still reads the first name.
    const wholeName = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'whole-name', check_in_date: '2026-11-05', check_out_date: '2026-11-07', adults: 1, guest_name: '  Bo   Lee ', total_minor: 30_000 })
    assert.equal((await getStay(db, cleaner, wholeName.id)).guest_name, 'Bo')
    assert.equal((await getStay(db, manager, wholeName.id)).guest_name, 'Bo   Lee')
    // A member with no responsibility for the home reads nothing of it.
    assert.deepEqual((await readStayCalendar(db, outsider, window)).stays, [])
    await assert.rejects(getStay(db, outsider, stay.id), code('STAY_NOT_FOUND'))

    for (const change of [
      () => updateStay(db, env, cleaner, stay.id, { version: stay.version, adults: 1 }),
      () => cancelStay(db, env, cleaner, stay.id, { version: stay.version }),
      () => recordStayPayment(db, env, cleaner, stay.id, { amount_minor: 100, method: 'cash', paid_on: '2026-11-01', idempotency_key: 'member-pay' }),
      () => deleteStayPayment(db, env, cleaner, stay.id, whole.payments[0]!.id),
      () => setStayNights(db, env, cleaner, { product_id: cabin.id, from: '2026-11-10', to: '2026-11-11', closed: true }),
    ]) await assert.rejects(change(), { status: 403, data: { code: 'STAY_ROLE_REQUIRED' } })
    assert.deepEqual(await getStay(db, manager, stay.id), whole)
    // The member's calendar holds only the homes they look after, and a home with stays is not deleted.
    const lake = await home(db, env, { name: 'Lake house', location: 'lake-site' })
    assert.deepEqual((await readStayCalendar(db, cleaner, window)).homes.map(entry => entry.home.product_id), [cabin.id])
    await assert.rejects(readHomeCalendar(db, cleaner, { productId: lake.id, ...window }), code('HOME_NOT_FOUND'))
    await assert.rejects(deleteProduct(db, { env, organizationId: ORG, productId: cabin.id }), /has bookings or stays/)
    // The outbox shows a member only their own replies: none of the business's automatic messages the manager reads.
    await saveMessageTemplate(db, env, manager, null, { title: 'After your stay', body: 'Thanks for staying.', schedule: { trigger: 'check_out', offset_days: 1, local_time: '10:00', product_ids: [cabin.id] } }, '2026-11-01T18:00:00.000Z')
    const [ownerMembership, cleanerMembership] = await Promise.all([OWNER, CLEANER].map(userId => resolveOrganizationMembership(env, { organizationId: ORG, userId })))
    assert(ownerMembership && cleanerMembership)
    const ownerPrincipal = memberAccessPrincipal(ownerMembership, { env })
    const cleanerPrincipal = memberAccessPrincipal(cleanerMembership, { env })
    const managerOutbox = await listScheduledGuestMessages(db, ownerPrincipal, { limit: 20, offset: 0 }, null)
    assert.ok(managerOutbox.messages.some(message => message.booking_id === stay.id && message.author_user_id === null))
    assert.deepEqual((await listScheduledGuestMessages(db, cleanerPrincipal, { limit: 20, offset: 0 }, null)).messages, [])

    // Assignment opens the guest thread and its alerts; automatic outbox messages remain for managers.
    assert.deepEqual((await listScheduledGuestMessages(db, cleanerPrincipal, { limit: 20, offset: 0 }, stay.conversation_id)).messages, [])
    assert.equal((await assertConversationAccess(db, cleanerPrincipal, stay.conversation_id)).id, stay.conversation_id)
    await assertConversationAccess(db, ownerPrincipal, stay.conversation_id)
    assert.deepEqual((await listOrganizationNotificationMembers(env, ORG, { requestId: stay.conversation_id, guestMessage: true })).map(member => member.userId).sort(), [CLEANER, OWNER].sort())

    // Today names the guest by first name for the member and in full for the owner.
    const today = (membership: typeof ownerMembership) => listTodayAgenda(db, { organizationId: ORG }, { principal: { env, membership }, organizationSlug: 'org' }, new Date('2026-11-01T18:00:00.000Z'))
    assert.deepEqual((await today(cleanerMembership)).items.map(item => [item.booking_id, item.title]), [[stay.id, 'Ana']])
    assert.deepEqual((await today(ownerMembership)).items.map(item => [item.booking_id, item.title]), [[stay.id, 'Ana Silva']])

    // MCP returns the same projection, and each tool's output schema admits both views.
    const ajv = new Ajv({ strict: false })
    const mcp = async (membership: typeof ownerMembership, role: McpOrganizationContext['role'], toolName: string, args: Record<string, unknown>) => {
      const organization: McpOrganizationContext = { env, db, userId: membership.userId, isPlatformAdmin: false, scopes: ['organization:read'], organizationId: ORG, organizationSlug: 'org', role, membership }
      // A stay is read through the booking tools; only its nights are the stays tools'.
      const booking = BOOKINGS_TOOLS.some(tool => tool.name === toolName)
      const result = await (booking ? handleBookingsTools : handleStaysTools)({ organization, toolName, args })
      const schema = [...BOOKINGS_TOOLS, ...STAYS_TOOLS].find(tool => tool.name === toolName)!.outputSchema
      assert(ajv.validate(schema, result), `${toolName} output: ${ajv.errorsText()}`)
      return result as Record<string, unknown>
    }
    assert.deepEqual(await mcp(cleanerMembership, 'member', 'get_product_booking', { booking_id: stay.id }), { booking_id: stay.id, unit: 'nights', record: turnover })
    const listed = (owner: boolean) => mcp(owner ? ownerMembership : cleanerMembership, owner ? 'owner' : 'member', 'list_product_bookings', { from: '2026-11-01T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' })
      .then(result => (result.bookings as Array<Record<string, unknown>>).map(row => [row.booking_id, row.unit, row.guest, row.starts_at]))
    assert.deepEqual(await listed(false), [[stay.id, 'nights', { name: 'Ana' }, turnover.starts_at]])
    assert.deepEqual((await mcp(cleanerMembership, 'member', 'get_stay_calendar', { product_id: cabin.id, ...window })).stays, [calendarTurnover])
    assert.equal(((await mcp(ownerMembership, 'owner', 'get_product_booking', { booking_id: stay.id })).record as Record<string, unknown>).guest_email, 'ana@example.test')
    assert.deepEqual(await listed(true), [[stay.id, 'nights', { name: 'Ana Silva' }, turnover.starts_at]])
    assert.equal(((await mcp(ownerMembership, 'owner', 'get_stay_calendar', { product_id: cabin.id, ...window })).stays as Array<Record<string, unknown>>)[0]!.guest_name, 'Ana Silva')
  } finally {
    t.mock.timers.reset()
    await runtime.dispose()
  }
})

test('a business’s site shows a guest the stay its signed link names, from any browser, and nothing else', { timeout: 120_000 }, async (context) => {
  const duringStay = Date.parse('2026-11-02T19:00:00.000Z')
  context.mock.timers.enable({ apis: ['Date'], now: duringStay })
  const { runtime, db, env: bindings } = await boot()
  try {
    const env = { ...bindings, ...JOB_ALERT_ENV, BETTER_AUTH_URL: 'https://org.proof.example', BETTER_AUTH_SECRET: 'local-stay-proof-secret-long-enough', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-stay-reply', STRIPE_SECRET_KEY: 'sk_test_local_boundary' }
    // The guest's notices are written in the business's source language.
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    const address = { regionCode: 'US', addressLines: ['12 Test Road', 'Apartment 4', 'East building'], languageCode: 'en', locality: 'Boulder', sublocality: 'North Boulder', administrativeArea: 'Colorado', postalCode: '80301' }
    const location = { address, latitude: 40.014984, longitude: -105.270546, maps_url: 'https://maps.google.com/?cid=123456' }
    assert.equal((await updateLocation(db, ORG, 'cabin-site', location, OWNER, env)).status, 200)
    const guide = { check_in_method: 'lockbox' as const, check_in_instructions: 'Use the garden lockbox.', wifi_network: 'Cabin guests', wifi_password: 'private-cabin-wifi', directions: 'Use the east entrance.', house_manual: 'Keep the gate closed.', checkout_instructions: [{ task: 'return_keys' as const, details: 'Leave keys in the box.' }] }
    await updateStayHome(env, db, manager, cabin.id, { ...guide, cancellation_policy: 'moderate', long_term_cancellation_policy: 'firm' })
    await updateProduct(db, { env, organizationId: ORG, productId: cabin.id, actor: { actorId: OWNER }, patch: { details_mode: 'merge', details: { pets_allowed: false, stairs_required: true, stairs_required_details: 'Two steps at the entrance.' } } })
    await writeMemberScheduling({ env, userId: OWNER, organizationId: ORG }, `m-${OWNER}`, { updated_at: null, public_name: OWNER, public_approved: true })
    await setProductPublication(db, { env, organizationId: ORG, productId: cabin.id, published: true, actor: { actorId: OWNER } })
    // The guest bought the stay on the site while the home was published.
    const signIn = async () => {
      const signed = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
      return { id: signed.response!.user.id, cookie: signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    }
    const booker = await signIn()
    const otherGuest = await signIn()
    const stay = await buyStay(db, env, { id: 'site-stay', organizationId: ORG, productId: cabin.id, locationId: 'cabin-site', timezone: 'America/Denver', checkIn: '2026-11-01', checkOut: '2026-11-04', adults: 2,
      nightlyMinor: 15_000, currency: 'USD', buyerUserId: booker.id, guest: { name: 'Ana', email: 'ana@example.com', phone: null, notes: null } })
    await setProductPublication(db, { env, organizationId: ORG, productId: cabin.id, published: false, actor: { actorId: OWNER } })
    // The guest's stay is read by its activity ID: its conversation's, as the account reads it.
    const activityId = stay.conversation_id ?? stay.id
    // The link the confirmation email and the paid return carry, signed with the site's secret.
    const link = (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET, activityId)).token
    const otherLink = (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET, 'another-stay')).token
    const read = (organizationId: string, token?: string) => {
      const app = new H3()
      app.use((event) => { event.context.organizationId = organizationId })
      app.get('/api/public/guest-stays/:activity_id', guestStayRoute)
      return app.request(Object.assign(new Request(`https://org.proof.example/api/public/guest-stays/${activityId}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    }
    const accountRead = (cookie?: string) => {
      const app = new H3()
      app.get('/api/account/bookings/:booking_id', accountStayRoute)
      return app.request(Object.assign(new Request(`https://proof.example/api/account/bookings/${stay.id}`, { headers: cookie ? { cookie } : {} }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    }

    // No session is sent: the link alone opens the stay, as from the email on another device.
    const own = await read(ORG, link)
    assert.equal(own.status, 200)
    assert.equal(own.headers.get('cache-control'), 'private, no-store')
    const body = await own.json() as GuestStay & { manage_url: string }
    const { location: guestLocation, arrival_guide: arrivalGuide, house_rules: rules, safety, ...guestHome } = body.home
    assert.deepEqual({ organization_id: body.organization_id, id: body.stay.id, email: body.stay.guest_email, policy: body.stay.cancellation_policy, dates: [body.stay.check_in_date, body.stay.check_out_date], home: guestHome, cancellation: body.cancellation },
      { organization_id: ORG, id: stay.id, email: 'ana@example.com', policy: 'moderate', dates: ['2026-11-01', '2026-11-04'], home: { name: 'Cabin', organization_name: 'Org', check_in_time: '16:00', check_in_end_time: null, check_out_time: '10:00', photo_urls: [], listing: null, contact_phone: null, host: { name: OWNER, photo_url: null, bio: null }, co_hosts: [] },
        cancellation: { policy: 'moderate', paid_minor: 45_000, refund_minor: 7_500, currency: 'USD' } })
    assert.equal(body.manage_url, `https://proof.example/dashboard/account/messages/${activityId}/reservation`)
    assert.deepEqual(arrivalGuide, { product_id: cabin.id, ...guide })
    const midStay = await listAgenda(db, { buyerUserId: booker.id }, { from: '2026-11-02', to: '2026-11-02', kinds: ['stay'] })
    assert.deepEqual(midStay.items.map(item => ({ kind: item.kind, title: item.title, requestId: item.conversation_id, to: item.to, startsAt: item.starts_at, endsAt: item.ends_at })), [
      { kind: 'stay', title: 'Cabin', requestId: activityId, to: `/dashboard/account/messages/${activityId}`, startsAt: '2026-11-01T23:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z' },
    ])
    assert.deepEqual((await listTodayAgenda(db, { buyerUserId: booker.id }, {}, new Date('2026-11-02T19:00:00.000Z'))).items.map(item => item.to), [`/dashboard/account/messages/${activityId}`])
    assert.deepEqual((await listAgenda(db, { buyerUserId: otherGuest.id }, { from: '2026-11-02', to: '2026-11-02', kinds: ['stay'] })).items, [])

    assert.deepEqual(rules, ['No pets'])
    assert.deepEqual(safety, ['Guests must climb stairs\nTwo steps at the entrance.', 'Carbon monoxide alarm not reported', 'Smoke alarm not reported'])
    assert(guestLocation?.maps_url)
    assert.deepEqual({ address: guestLocation.address, latitude: guestLocation.latitude, longitude: guestLocation.longitude }, { address, latitude: 40.014984, longitude: -105.270546 })
    assert.equal(new URL(guestLocation.maps_url).origin, 'https://maps.google.com')
    assert.equal(new URL(guestLocation.maps_url).searchParams.get('q'), '40.014984,-105.270546')
    assert.equal(new URL(guestLocation.maps_url).searchParams.has('cid'), false)
    assert.deepEqual({ status: body.stay.status, payment: body.stay.payment_status, paid: body.stay.paid_minor }, { status: 'confirmed', payment: 'paid', paid: 45_000 })
    const account = await accountRead(booker.cookie)
    assert.equal(account.status, 200)
    assert.equal(account.headers.get('cache-control'), 'private, no-store')
    const accountBooking = await account.json() as GuestStayAccount
    assert.equal(accountBooking.booking.booking_id, stay.id)
    assert.deepEqual(accountBooking.home.location, guestLocation)
    assert.equal((await accountRead(otherGuest.cookie)).status, 404)
    assert.equal((await accountRead()).status, 401)
    // Better Auth owns the guest's portrait: the host reads it through the account the stay belongs to.
    assert.equal((await getStay(db, manager, stay.id)).guest_image_url, null)
    const portraitUrl = 'https://proof.example/platform/blawby-180.png'
    await createAuth(env).api.updateUser({ headers: new Headers({ cookie: booker.cookie }), body: { image: portraitUrl } })
    assert.equal((await getStay(db, manager, stay.id)).guest_image_url, portraitUrl)
    assert.equal((await read('another-org', link)).status, 404)
    assert.equal((await read(ORG, otherLink)).status, 404)
    assert.equal((await read(ORG)).status, 401)
    // November checkout is 10 am in Denver (17:00 UTC): a past guest must
    // not keep reading this home's current access instructions or Wi-Fi.
    context.mock.timers.setTime(Date.parse('2026-11-04T16:59:59.000Z'))
    try {
      const beforeCheckout = await read(ORG, link)
      assert.equal(beforeCheckout.status, 200)
      assert.deepEqual((await beforeCheckout.json() as GuestStay).home.arrival_guide, { product_id: cabin.id, ...guide })
      context.mock.timers.setTime(Date.parse('2026-11-04T17:00:00.000Z'))
      const afterCheckout = await read(ORG, link)
      assert.equal(afterCheckout.status, 200)
      const departed = await afterCheckout.json() as GuestStay
      assert.equal(departed.stay.status, 'confirmed')
      assert.equal(departed.home.arrival_guide, null)
      assert(!JSON.stringify(departed).includes(guide.wifi_password))
      assert(!JSON.stringify(departed).includes(guide.check_in_instructions))
    } finally { context.mock.timers.setTime(duringStay) }
    // Pending app records are not currently made by checkout, but stored
    // unconfirmed state must never disclose an exact location through either read.
    await db.prepare("UPDATE bookings SET status = 'pending' WHERE id = ?").bind(stay.id).run()
    for (const response of [await read(ORG, link), await accountRead(booker.cookie)]) {
      assert.equal(response.status, 200)
      const pending = await response.json() as GuestStay | GuestStayAccount
      assert.equal(('booking' in pending ? pending.booking : pending.stay).status, 'pending')
      assert.equal(pending.home.location, null)
      assert.equal(pending.home.arrival_guide, null)
      assert.deepEqual([pending.home.house_rules, pending.home.safety], [[], []])
      assert(!JSON.stringify(pending).includes(guide.wifi_password))
      for (const exact of [address.addressLines[0]!, String(location.latitude), String(location.longitude), location.maps_url]) assert(!JSON.stringify(pending).includes(exact))
    }
    await db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").bind(stay.id).run()
    // The guest cancels: the moderate policy refunds what it allows through Stripe,
    // and the cancelled stay stops disclosing where it is on either read.
    const realFetch = globalThis.fetch
    let refunds = 0
    let nativeRefund: Record<string, unknown> | null = null
    context.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return realFetch(request, init)
      if (init?.method === 'GET' && url.pathname === '/v1/refunds/re_site_stay') {
        assert(nativeRefund)
        return Response.json(nativeRefund)
      }
      assert.equal(`${init?.method} ${url.pathname}`, 'POST /v1/refunds')
      refunds++
      const form = new URLSearchParams(String(init?.body))
      nativeRefund = { id: 're_site_stay', object: 'refund', amount: Number(form.get('amount') ?? 45_000), currency: 'usd', status: 'succeeded', payment_intent: form.get('payment_intent'), reason: form.get('reason'), metadata: { krabiclaw_refund_id: form.get('metadata[krabiclaw_refund_id]') } }
      return Response.json(nativeRefund)
    })
    const accountCancel = (cookie: string, version: number) => {
      const app = new H3()
      app.post('/api/account/bookings/:booking_id/cancel', accountCancelRoute)
      const request = new Request(`https://proof.example/api/account/bookings/${stay.id}/cancel`, {
        method: 'POST', headers: { cookie, origin: 'https://proof.example', 'content-type': 'application/json' }, body: JSON.stringify({ version }),
      })
      const runtime = { name: 'cloudflare', cloudflare: { env: { ...env, STRIPE_TEST_SECRET_KEY: 'sk_test_local_boundary', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } } }
      return app.request(Object.assign(request, { runtime }))
    }
    const bookingVersion = accountBooking.booking.version
    assert.equal((await accountCancel(otherGuest.cookie, bookingVersion)).status, 404)
    assert.equal((await accountCancel(booker.cookie, bookingVersion + 1)).status, 409)
    const cancelledByBuyer = await accountCancel(booker.cookie, bookingVersion)
    assert.equal(cancelledByBuyer.status, 200, await cancelledByBuyer.clone().text())
    const cancellation = { success: true, status: 'cancelled', kind: 'stay', refund_minor: 7_500 }
    assert.deepEqual(await cancelledByBuyer.json(), cancellation)
    await db.prepare("UPDATE product_booking_configs SET check_in_time=NULL WHERE product_id=?").bind(cabin.id).run()
    const replay = await accountCancel(booker.cookie, bookingVersion)
    assert.equal(replay.status, 200, await replay.clone().text())
    assert.deepEqual(await replay.json(), cancellation)
    assert.equal(refunds, 1, 'the retry uses the recorded refund after the home changes')
    await db.prepare("UPDATE product_booking_configs SET check_in_time='16:00' WHERE product_id=?").bind(cabin.id).run()
    for (const response of [await read(ORG, link), await accountRead(booker.cookie)]) {
      assert.equal(response.status, 200)
      const cancelled = await response.json() as GuestStay | GuestStayAccount
      assert.equal(('booking' in cancelled ? cancelled.booking : cancelled.stay).status, 'cancelled')
      assert.equal(cancelled.home.location, null)
      assert.equal(cancelled.home.arrival_guide, null)
      assert.deepEqual([cancelled.home.house_rules, cancelled.home.safety], [[], []])
      assert(!JSON.stringify(cancelled).includes(guide.wifi_password))
      for (const exact of [address.addressLines[0]!, String(location.latitude), String(location.longitude), location.maps_url]) assert(!JSON.stringify(cancelled).includes(exact))
    }
    // The link lasts as a booking's does: thirty days from when the stay was booked.
    await db.prepare("UPDATE bookings SET created_at = ? WHERE id = ?").bind(new Date(Date.now() - 31 * 86_400_000).toISOString(), stay.id).run()
    assert.equal((await read(ORG, link)).status, 410)
  } finally {
    await runtime.dispose()
  }
})

test('a stay request can be paid only after approval and Stripe confirms the same stay', { timeout: 120_000 }, async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { runtime, db, env: bindings, queue } = await boot()
  try {
    const env = {
      ...bindings, ...JOB_ALERT_ENV, BETTER_AUTH_URL: 'https://proof.example', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example',
      NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://sites.example', EMAIL_REPLY_SECRET: 'local-stay-reply',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only', STRIPE_SECRET_KEY: 'sk_live_local_boundary',
      STRIPE_TEST_SECRET_KEY: 'sk_test_local_boundary', STRIPE_TEST_PUBLISHABLE_KEY: 'pk_test_mock',
      STRIPE_TEST_PAYMENTS_METHOD_CONFIGURATION: 'pmc_parent',
    }
    await db.batch([
      db.prepare("UPDATE organization SET subdomain='demo',settings_json=json_set(settings_json,'$.lodging_booking.confirmation_mode','review') WHERE id=?").bind(ORG),
      db.prepare("INSERT INTO organization_locales(id,organization_id,locale,is_source,status) VALUES('org-en',?,'en',1,'published')").bind(ORG),
      db.prepare("INSERT INTO organization_domains(id,organization_id,domain,type,role,status) VALUES('stay-origin',?,'demo.sites.example','subdomain','canonical','active')").bind(ORG),
      db.prepare("INSERT INTO subscription(id,plan,referenceId,status,seats) VALUES('stay-plan','business',?,'active',1)").bind(ORG),
    ])
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site' })
    await writeMemberScheduling({ env, userId: OWNER, organizationId: ORG }, `m-${OWNER}`, { updated_at: null, public_name: 'Cabin host', public_approved: true })
    await updateStayHome(env, db, manager, cabin.id, { cancellation_policy: 'moderate', long_term_cancellation_policy: 'firm' })
    await setProductPublication(db, { env, organizationId: ORG, productId: cabin.id, published: true, actor: { actorId: OWNER } })
    const reserved = await reserveStripeConnectedAccount(db, { organizationId: ORG, livemode: false })
    await projectStripeConnectedAccount(db, { reservationId: reserved.id, organizationId: ORG, stripeAccountId: 'acct_seller', country: 'US', livemode: false, cardPaymentsStatus: 'active', cardPaymentsResolutions: [], requirements: [], stripeRefreshedAt: new Date().toISOString() })
    const template = await saveMessageTemplate(db, env, manager, null, { title: 'Reservation received', body: 'Thanks for your reservation.', schedule: { trigger: 'booking_received', delay_minutes: 5, product_ids: [cabin.id] } })

    const auth = createAuth(env)
    const buyer = 'previously-verified-stay-buyer'
    const password = 'CabinProof123!'
    const hashedPassword = await hashPassword(password)
    await db.batch([
      db.prepare('INSERT INTO user(id,name,email,emailVerified) VALUES(?,?,?,1)').bind(buyer, 'Ana', 'ana@example.com'),
      ...[buyer, OWNER].map(id => db.prepare("INSERT INTO account(id,accountId,providerId,userId,password) VALUES(?,?,'credential',?,?)").bind(id, id, id, hashedPassword)),
    ])
    const login = async (email: string) => (await auth.api.signInEmail({ body: { email, password }, returnHeaders: true }))
      .headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const [cookie, ownerCookie] = await Promise.all([login('ana@example.com'), login(`${OWNER}@example.test`)])
    const anonymous = await auth.api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
    const siteCookie = anonymous.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const app = new H3()
    app.use(event => {
      event.context.organizationId = ORG
      event.context.tenantType = 'tenant'
      event.context.tenantHost = 'demo.sites.example'
    })
    app.post('/api/account/bookings/:booking_id/pay', accountPayRoute)
    app.get('/api/account/bookings/:booking_id', accountStayRoute)
    app.post('/api/account/bookings/:booking_id/cancel', accountCancelRoute)
    app.patch('/api/dashboard/bookings/:booking_id', dashboardBookingPatchRoute)
    app.get('/api/public/payments/:payment_id', paymentHandoffRoute)
    app.post('/api/public/payments/:payment_id/review', paymentReviewRoute)
    app.post('/api/public/payments/:payment_id/confirm', paymentConfirmRoute)
    app.post('/api/public/payments/:payment_id/return', paymentReturnRoute)
    const runtimeContext = { name: 'cloudflare', cloudflare: { env } }
    const call = (path: string, body?: Record<string, unknown>, session = cookie, method = body === undefined ? 'GET' : 'POST') => app.request(Object.assign(new Request(`https://proof.example${path}`, {
      method,
      headers: { cookie: session, origin: 'https://proof.example', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { runtime: runtimeContext }))

    const subtotal = 30_000
    const expected = 31_000
    const paymentIntentId = 'pi_approved_stay'
    const charge = { id: 'ch_approved_stay', object: 'charge', livemode: false, amount: expected, currency: 'usd',
      created: Math.floor(Date.now() / 1000), payment_intent: paymentIntentId, payment_method: 'pm_card', receipt_url: 'https://pay.stripe.com/receipts/stay',
      billing_details: { email: 'ana@example.com' } }
    const paymentIntent = { id: paymentIntentId, object: 'payment_intent', livemode: false, currency: 'usd', amount: subtotal,
      amount_received: 0, status: 'requires_payment_method', client_secret: 'pi_approved_stay_secret', customer: null, payment_method_types: ['card'],
      application_fee_amount: null, latest_charge: null as typeof charge | null, payment_method: null as string | null,
      last_payment_error: null as { type: string; code: string; message: string } | null,
      hooks: { inputs: { tax: { calculation: null as string | null } } },
      metadata: { krabiclaw_payment_id: '' } }
    let bookingId = ''
    let activity = ''
    let approvedPayUrl = ''
    let intentCount = 0
    let rejections = 0
    let declines = 0
    let captures = 0
    let readinessChecks = 0
    let releaseConcurrentReadiness!: () => void
    const concurrentReadiness = new Promise<void>(resolve => { releaseConcurrentReadiness = resolve })
    const { promise: competingMethodRequested, resolve: methodRequested } = Promise.withResolvers<undefined>()
    const { promise: allowCompetingMethod, resolve: releaseCompetingMethod } = Promise.withResolvers<undefined>()
    const nativeFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return nativeFetch(request, init)
      if (url.pathname === '/v2/core/accounts/acct_seller') return Response.json({
        id: 'acct_seller', livemode: false, dashboard: 'express', identity: { country: 'US' },
        defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'stripe' } },
        configuration: { merchant: { capabilities: { card_payments: { status: 'active', status_details: [] } } } }, requirements: { entries: [] },
      })
      if (url.pathname === '/v1/payment_method_configurations') {
        if (++readinessChecks === 2) releaseConcurrentReadiness()
        await concurrentReadiness
        return Response.json({ data: [{ id: 'pmc_child', parent: 'pmc_parent', active: true }], has_more: false })
      }
      assert.equal(new Headers(init?.headers).get('stripe-account'), 'acct_seller')
      if (url.pathname === '/v1/tax/settings') return Response.json({ status: 'active' })
      if (url.pathname === '/v1/tax/registrations') return Response.json({ data: [{ id: 'taxreg_stay' }] })
      if (url.pathname === '/v1/tax/calculations') {
        const other = new URLSearchParams(String(init?.body)).get('customer_details[address][postal_code]') === '94016'
        const tax = other ? 2_000 : 1_000
        return Response.json({ id: other ? 'taxcalc_other' : 'taxcalc_reviewed', amount_total: subtotal + tax, tax_amount_exclusive: tax, tax_amount_inclusive: 0 })
      }
      if (url.pathname === '/v1/tax/calculations/taxcalc_reviewed') return Response.json({ tax_amount_exclusive: 1_000, tax_amount_inclusive: 0 })
      if (url.pathname === '/v1/payment_intents') {
        assert.equal(init?.method, 'POST')
        const params = new URLSearchParams(String(init?.body))
        assert.equal(params.get('amount'), String(subtotal))
        paymentIntent.metadata.krabiclaw_payment_id = params.get('metadata[krabiclaw_payment_id]')!
        intentCount++
      } else if (url.pathname === '/v1/customers' && init?.method === 'POST') {
        assert.equal(new URLSearchParams(String(init.body)).get('email'), 'ana@example.com')
        return Response.json({ id: 'cus_approved_stay' })
      } else if (url.pathname === '/v1/customers/cus_approved_stay/payment_methods') {
        return Response.json({ data: [], has_more: false })
      } else if (url.pathname.startsWith('/v1/payment_methods/')) {
        const id = url.pathname.split('/').at(-1)
        const other = id === 'pm_other'
        if (other) {
          methodRequested(undefined)
          await allowCompetingMethod
        }
        return Response.json({ id, type: 'card', card: { brand: 'visa', last4: '4242' }, billing_details: { address: { country: 'US', postal_code: other ? '94016' : '98104' } } })
      } else if (url.pathname === '/v1/charges/ch_approved_stay') {
        return Response.json(charge)
      } else if (url.pathname === '/v1/payment_intents/pi_approved_stay' && init?.method === 'POST') {
        const params = new URLSearchParams(String(init.body))
        paymentIntent.payment_method = params.get('payment_method')
        paymentIntent.amount = Number(params.get('amount'))
        paymentIntent.hooks.inputs.tax.calculation = params.get('hooks[inputs][tax][calculation]')
        paymentIntent.status = 'requires_confirmation'
        paymentIntent.last_payment_error = null
      } else if (url.pathname.endsWith('/confirm')) {
        if (rejections++ === 0) return Response.json({ error: { type: 'invalid_request_error', code: 'parameter_invalid_integer', param: 'amount_to_confirm', message: 'Invalid amount.' } }, { status: 400 })
        if (paymentIntent.payment_method === 'pm_declined') {
          if (++declines === 1) {
            const waiting = await call(`${paymentPath}?claim=${claim}`)
            assert.equal(waiting.status, 200, await waiting.clone().text())
            assert.equal((await waiting.json()).state, 'processing')
            const pendingReturn = await call(`${paymentPath}/return`, { claim })
            assert.equal(pendingReturn.status, 200, await pendingReturn.clone().text())
            assert.deepEqual(await pendingReturn.json(), { state: 'processing' })
            const concurrent = await call(`${paymentPath}/confirm`, { claim, payment_method_id: 'pm_declined', total: expected })
            assert.equal(concurrent.status, 409, await concurrent.clone().text())
            assert.equal((await concurrent.json()).data?.code, 'payment_in_progress')
          }
          const decline = { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' }
          paymentIntent.status = 'requires_payment_method'
          paymentIntent.last_payment_error = decline
          return Response.json({ error: { ...decline, payment_intent: paymentIntent } }, { status: 402 })
        }
        releaseCompetingMethod(undefined)
        const competing = await competingReview
        assert.equal(competing.status, 409, await competing.clone().text())
        assert.equal((await competing.json()).data.code, 'payment_in_progress')
        assert.deepEqual([paymentIntent.payment_method, paymentIntent.amount, paymentIntent.hooks.inputs.tax.calculation], ['pm_other', 32_000, 'taxcalc_other'])
        const params = new URLSearchParams(String(init?.body))
        paymentIntent.payment_method = params.get('payment_method') ?? paymentIntent.payment_method
        paymentIntent.amount = Number(params.get('amount_to_confirm') ?? paymentIntent.amount)
        paymentIntent.hooks.inputs.tax.calculation = params.get('hooks[inputs][tax][calculation]') ?? paymentIntent.hooks.inputs.tax.calculation
        assert.deepEqual([paymentIntent.payment_method, paymentIntent.amount, paymentIntent.hooks.inputs.tax.calculation], ['pm_card', expected, 'taxcalc_reviewed'])
        // Authorization started before the deadline, so its in-flight checkout stays accessible.
        t.mock.timers.setTime(now + 86_400_001)
        const resumed = await call(`/api/account/bookings/${bookingId}/pay`, {})
        assert.equal(resumed.status, 200, await resumed.clone().text())
        assert.deepEqual(await resumed.json(), { pay_url: approvedPayUrl })
        assert.equal(intentCount, 1)
        const activityRead = await call(`/api/account/bookings/${activity}?lookup=conversation`)
        assert.equal(activityRead.status, 200, await activityRead.clone().text())
        const paying = await activityRead.json() as GuestStayAccount
        assert.equal(paying.booking.status, 'pending')
        assert.equal(paying.payment_processing, true)
        assert.deepEqual(requestActions(await getThreadOperationalRecord(db, activity), new Date().toISOString()), [])
        const withdraw = await call(`/api/account/bookings/${bookingId}/cancel`, { version: paying.booking.version })
        assert.equal(withdraw.status, 409)
        paymentIntent.latest_charge = charge
        paymentIntent.status = 'requires_capture'
      } else if (url.pathname.endsWith('/capture')) {
        assert.equal(await db.prepare('SELECT status FROM bookings WHERE id=?').bind(bookingId).first('status'), 'confirmed')
        assert.deepEqual(await db.prepare('SELECT subject_id,captured_amount FROM payments WHERE id=?').bind(paymentIntent.metadata.krabiclaw_payment_id).first(),
          { subject_id: bookingId, captured_amount: 0 })
        paymentIntent.amount_received = expected
        paymentIntent.status = 'succeeded'
        captures++
      } else {
        assert.equal(url.pathname, '/v1/payment_intents/pi_approved_stay')
        assert.equal(init?.method, 'GET')
      }
      return Response.json(paymentIntent)
    })

    const date = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    const requestBody = {
      guest_name: 'Ana', guest_email: 'ana@example.com', guest_phone: '+12025550123', check_in_date: date(10), check_out_date: date(12),
      adults: 2, idempotency_key: 'stay-request', confirmation_mode: 'review',
    }
    const submitStayRequest = (session: string, body = requestBody) => createProductBooking(new H3Event(Object.assign(new Request('https://proof.example/api/public/stays/cabin/bookings', {
      headers: { cookie: session, 'cf-connecting-ip': '192.0.2.1' },
    }), { runtime: runtimeContext })), { organizationId: ORG, slug: cabin.slug, body })
    const concurrent = await Promise.all([submitStayRequest(siteCookie), submitStayRequest(siteCookie)])
    const [initial, duplicate] = concurrent.sort((left, right) => right.status - left.status)
    assert(initial && duplicate)
    assert.equal(initial.status, 201, JSON.stringify(initial.body))
    assert.equal(initial.body.status, 'pending')
    assert.equal(initial.body.request_status, 'awaiting_approval')
    assert.deepEqual(duplicate, { status: 200, body: { ...initial.body, replayed: true } })
    bookingId = initial.body.booking_id as string
    activity = initial.body.conversation_id as string
    const payPath = `/api/account/bookings/${bookingId}/pay`
    const scheduledReservationMessage = () => db.prepare('SELECT status, due_at FROM scheduled_guest_messages WHERE booking_id=? AND template_id=?').bind(bookingId, template.id).first()
    const read = async () => {
      const response = await call(`/api/account/bookings/${activity}?lookup=conversation`)
      assert.equal(response.status, 200, await response.clone().text())
      return await response.json() as GuestStayAccount
    }

    assert.equal(await db.prepare('SELECT user_id FROM bookings WHERE id=?').bind(bookingId).first('user_id'), anonymous.response!.user.id)
    assert.equal((await read()).booking.request_status, 'awaiting_approval')
    assert.equal(await scheduledReservationMessage(), null)
    assert.equal(await db.prepare('SELECT user_id FROM bookings WHERE id=?').bind(bookingId).first('user_id'), buyer)
    assert.equal((await call(payPath, {})).status, 409)
    assert.equal(intentCount, 0)
    const originalClaims = await db.prepare('SELECT date,booking_id FROM stay_nights WHERE booking_id=? ORDER BY date').bind(bookingId).all()
    assert.deepEqual(originalClaims.results, [date(10), date(11)].map(date => ({ date, booking_id: bookingId })))

    const decision = await executeGuestThreadOperation(db, { threadId: activity, organizationId: ORG, action: 'confirm', actorUserId: OWNER,
      idempotencyKey: 'approve-stay-request', stayManager: true, version: (await read()).booking.version, env })
    assert.equal(decision.ok, true, JSON.stringify(decision))
    assert.equal((await read()).booking.request_status, 'awaiting_payment')
    const approvedReplay = await submitStayRequest(cookie)
    assert.equal(approvedReplay.status, 200)
    assert.equal(approvedReplay.body.request_status, 'awaiting_payment')
    assert.equal(approvedReplay.body.booking_id, bookingId)
    assert.deepEqual(requestActions(await getThreadOperationalRecord(db, activity), new Date().toISOString()), ['cancel'])
    assert.equal(await scheduledReservationMessage(), null)
    assert.equal((await read()).home.location, null)
    const pay = await call(payPath, {})
    assert.equal(pay.status, 200, await pay.clone().text())
    const { pay_url: url } = await pay.json() as { pay_url: string }
    approvedPayUrl = url
    const target = new URL(url)
    assert.equal(target.origin, 'https://demo.sites.example')
    const claim = target.hash.slice(1)
    const paymentPath = target.pathname.replace('/pay/', '/api/public/payments/')
    const beforeNote = await getStay(db, manager, bookingId)
    const note = await call(`/api/dashboard/bookings/${bookingId}?org=${ORG}`, {
      version: beforeNote.version, private_notes: 'Guest asked about parking',
    }, ownerCookie, 'PATCH')
    assert.equal(note.status, 409, await note.clone().text())
    assert.equal((await note.json()).data.code, 'STAY_REQUEST_PENDING')
    const afterNote = await getStay(db, manager, bookingId)
    assert.deepEqual([afterNote.private_notes, afterNote.version], [beforeNote.private_notes, beforeNote.version])
    assert.deepEqual(await (await call(payPath, {})).json(), { pay_url: url })
    assert.equal(intentCount, 1)
    t.mock.timers.setTime(now + 86_400_000 - 60_000)
    const rejectedReview = await call(`${paymentPath}/review`, { claim, payment_method_id: 'pm_declined' })
    assert.equal(rejectedReview.status, 200, await rejectedReview.clone().text())
    const rejected = await call(`${paymentPath}/confirm`, { claim, payment_method_id: 'pm_declined', total: expected })
    assert.equal(rejected.status, 400, await rejected.clone().text())
    assert.equal((await read()).payment_processing, false)
    assert.equal(await db.prepare(`SELECT h.expires_at=p.checkout_expires_at AS deadline_restored
      FROM payment_checkout_holds h JOIN payments p ON p.id=h.payment_id WHERE p.id=?`).bind(paymentIntent.metadata.krabiclaw_payment_id).first('deadline_restored'), 1)
    t.mock.timers.setTime(Date.now() + 1)
    const declinedReview = await call(`${paymentPath}/review`, { claim, payment_method_id: 'pm_declined' })
    assert.equal(declinedReview.status, 200, await declinedReview.clone().text())
    const declined = await call(`${paymentPath}/confirm`, { claim, payment_method_id: 'pm_declined', total: expected })
    assert.equal(declined.status, 402, await declined.clone().text())
    const afterDecline = await read()
    assert.equal(afterDecline.booking.request_status, 'awaiting_payment')
    assert.equal(afterDecline.payment_processing, false)
    assert.equal(await db.prepare(`SELECT h.expires_at=p.checkout_expires_at AS deadline_restored
      FROM payment_checkout_holds h JOIN payments p ON p.id=h.payment_id WHERE p.id=?`).bind(paymentIntent.metadata.krabiclaw_payment_id).first('deadline_restored'), 1)
    t.mock.timers.setTime(Date.now() + 1)
    const review = await call(`${paymentPath}/review`, { claim, payment_method_id: 'pm_card' })
    assert.equal(review.status, 200, await review.clone().text())
    assert.equal((await review.json()).total, expected)
    const competingReview = call(`${paymentPath}/review`, { claim, payment_method_id: 'pm_other' })
    await competingMethodRequested
    const confirm = await call(`${paymentPath}/confirm`, { claim, payment_method_id: 'pm_card', total: expected })
    assert.equal(confirm.status, 200, await confirm.clone().text())
    assert.equal((await confirm.json()).status, 'succeeded')
    assert.equal(captures, 1)

    const receipt = await call(`${paymentPath}/return`, { claim }, '')
    assert.equal(receipt.status, 200, await receipt.clone().text())
    assert.equal((await receipt.json()).activity_id, activity)
    assert.deepEqual(receipt.headers.getSetCookie(), [])
    const confirmed = await read()
    assert.deepEqual({ id: confirmed.booking.booking_id, status: confirmed.booking.status, paid: confirmed.booking.paid_minor,
      progress: confirmed.booking.request_status }, { id: bookingId, status: 'confirmed', paid: expected, progress: null })
    const confirmedReplay = await submitStayRequest(cookie)
    assert.equal(confirmedReplay.status, 200)
    assert.equal(confirmedReplay.body.status, 'confirmed')
    assert.equal(confirmedReplay.body.request_status, null)
    assert.equal(confirmedReplay.body.activity_path, initial.body.activity_path)
    await assert.rejects(submitStayRequest(cookie, { ...requestBody, adults: 1 }), code('IDEMPOTENCY_CONFLICT'))
    await assert.rejects(submitStayRequest('', requestBody), code('IDEMPOTENCY_CONFLICT'))
    assert.equal(await db.prepare('SELECT received_at FROM bookings WHERE id=?').bind(bookingId).first('received_at'), new Date(now).toISOString())
    assert.equal(await scheduledReservationMessage(), null)
    assert(queue.pending.some(item => item.body.type === 'payment.captured' && item.body.booking?.unit === 'nights' && item.body.booking.id === bookingId))
    await queue.drain(env, 'payment.captured')
    await queue.drain(env, 'stay.changed')
    assert.deepEqual(await scheduledReservationMessage(), { status: 'pending', due_at: new Date(Date.now() + 5 * 60_000).toISOString() })
    assert.deepEqual((await db.prepare('SELECT date,booking_id FROM stay_nights WHERE booking_id=? ORDER BY date').bind(bookingId).all()).results, originalClaims.results)
    assert.equal(await db.prepare('SELECT COUNT(*) FROM bookings WHERE product_id=?').bind(cabin.id).first('COUNT(*)'), 1)

    const toWithdraw = { ...requestBody, idempotency_key: 'withdraw-this-stay', check_in_date: date(14), check_out_date: date(16) }
    const second = await submitStayRequest(cookie, toWithdraw)
    const secondId = second.body.booking_id as string
    const cancellable = await call(`/api/account/bookings/${secondId}`)
    assert.equal(cancellable.status, 200, await cancellable.clone().text())
    const { booking: { version } } = await cancellable.json() as GuestStayAccount
    const withdrawn = await call(`/api/account/bookings/${secondId}/cancel`, { version })
    assert.equal(withdrawn.status, 200, await withdrawn.clone().text())
    const cancelledReplay = await submitStayRequest(cookie, toWithdraw)
    assert.equal(cancelledReplay.status, 200)
    assert.equal(cancelledReplay.body.status, 'cancelled')
    assert.equal(cancelledReplay.body.request_status, null)
    assert.equal(cancelledReplay.body.booking_id, secondId)
    assert.equal(cancelledReplay.body.activity_path, second.body.activity_path)

    app.post('/api/public/products/:slug/book', publicBookingRoute)
    const bookFromSameIp = (attempt: number) => app.request(Object.assign(new Request(`https://proof.example/api/public/products/${cabin.slug}/book`, {
      method: 'POST',
      headers: { cookie, origin: 'https://proof.example', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.41' },
      body: JSON.stringify({
        ...requestBody,
        idempotency_key: `repeat-stay-${attempt}`,
        check_in_date: date(22 + attempt * 3),
        check_out_date: date(24 + attempt * 3),
      }),
    }), { runtime: runtimeContext }))
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await bookFromSameIp(attempt)
      assert.equal(response.status, 201, await response.clone().text())
    }
    const limited = await bookFromSameIp(6)
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).data?.code, 'RATE_LIMITED')
    const { results: repeatedStays } = await db.prepare("SELECT idempotency_key, status FROM bookings WHERE organization_id=? AND idempotency_key LIKE 'repeat-stay-%' ORDER BY idempotency_key").bind(ORG).all()
    assert.deepEqual(repeatedStays, Array.from({ length: 5 }, (_, index) => ({ idempotency_key: `repeat-stay-${index + 1}`, status: 'pending' })))
  } finally {
    await runtime.dispose()
  }
})

test('stay request decisions and expiry reconcile the host task and the exact nights', { timeout: 120_000 }, async (t) => {
  const { runtime, db, env: bindings, queue } = await boot()
  try {
    const env = {
      ...bindings, ...JOB_ALERT_ENV, NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-stay-reply', EMAIL_DELIVERY_MODE: 'log_only',
    }
    await db.prepare("INSERT INTO organization_locales(id,organization_id,locale,is_source,status) VALUES('org-en',?,'en',1,'published')").bind(ORG).run()
    const cabin = await home(db, env, { name: 'Cabin', location: 'cabin-site', member: `m-${CLEANER}` })
    await writeMemberScheduling({ env, userId: OWNER, organizationId: ORG }, `m-${CLEANER}`, { updated_at: null, public_name: 'Cabin host', public_approved: true })
    await updateStayHome(env, db, manager, cabin.id, { cancellation_policy: 'moderate', long_term_cancellation_policy: 'firm' })
    await setProductPublication(db, { env, organizationId: ORG, productId: cabin.id, published: true, actor: { actorId: OWNER } })
    const date = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    const submit = async (key: string, offset: number) => {
      const listing = await readPublicStayHome(db, ORG, cabin.id)
      const quote = await quoteStay(db, ORG, listing, { check_in_date: date(offset), check_out_date: date(offset + 2), adults: 2 })
      return createStayRequest(db, env, { organizationId: ORG, buyerUserId: OUTSIDER, key, fingerprint: key, home: listing, quote, policy: stayCheckoutPolicy(listing.guestTerms, quote),
        guest: { name: 'Ana', email: 'ana@example.com', phone: null, notes: null }, locale: 'en', ipHash: 'proof', websiteSource: 'Direct' })
    }
    const decide = (stay: Awaited<ReturnType<typeof submit>>, action: 'confirm' | 'reject', suffix = '') => executeGuestThreadOperation(db, {
      threadId: stay.conversation_id, organizationId: ORG, action, actorUserId: OWNER, idempotencyKey: `${action}:${stay.id}${suffix}`, stayManager: true,
      version: stay.version, env,
    })
    const claims = async (id: string) => await db.prepare('SELECT count(*) AS n FROM stay_nights WHERE booking_id=?').bind(id).first('n')
    const owner = await resolveMembership(env, { organizationId: ORG, userId: OWNER })
    const cleanerMembership = await resolveMembership(env, { organizationId: ORG, userId: CLEANER })
    const visibleTasks = async (membership: NonNullable<typeof owner>) => (await listTasks(db,
      await taskViewer(memberAccessPrincipal(membership, { env })), parseTaskListQuery({ kind: 'booking_review' }))).sections.flatMap(section => section.tasks)

    const approved = await submit('stay-approval', 8)
    assert.equal(approved.request_status, 'awaiting_approval')
    assert.equal(await claims(approved.id), 2)
    assert((await visibleTasks(owner!)).some(task => task.booking_id === approved.id && task.action?.path === `/dashboard/org/bookings/${approved.id}`))
    assert.equal((await visibleTasks(cleanerMembership!)).length, 0)
    const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName(ORG))
    await queue.runNext(env, 'stay.changed')
    assert.deepEqual(await (await hub.fetch('https://inbox.test/deadlines')).json(), [{ kind: 'checkout', due_at: Date.parse(approved.respond_by!) }])
    await notifyProductBookingCreated(env, db, ORG, approved.conversation_id)
    const { results: deliveries } = await db.prepare(`SELECT d.purpose, d.status FROM guest_thread_deliveries d JOIN messages m ON m.id=d.message_id
      WHERE m.conversation_id=? AND d.channel='email' AND d.purpose IN ('owner_alert','guest_acknowledgement') ORDER BY d.purpose`).bind(approved.conversation_id).all()
    assert.deepEqual(deliveries, [{ purpose: 'guest_acknowledgement', status: 'sent' }, { purpose: 'owner_alert', status: 'sent' }])
    assert.equal((await decide(approved, 'confirm')).ok, true)
    assert.equal((await getStay(db, manager, approved.id)).request_status, 'awaiting_payment')
    await queue.runNext(env, 'booking.status_changed')
    await queue.runNext(env, 'stay.changed')
    const approval = await db.prepare(`SELECT json_extract(m.payload_json, '$.subject') AS subject, json_extract(m.payload_json, '$.email.html') AS html,
      d.status FROM messages m JOIN guest_thread_deliveries d ON d.message_id=m.id WHERE m.conversation_id=? AND m.event_name='booking.confirm'`).bind(approved.conversation_id).first<{ subject: string; html: string; status: string }>()
    assert.equal(approval?.subject, 'Stay request approved — Cabin')
    assert(approval?.html.includes(`/dashboard/account/messages/${approved.conversation_id}/reservation`))
    assert.equal(approval?.status, 'sent')
    assert.equal(await db.prepare('SELECT status FROM tasks WHERE dedupe_key=?').bind(`booking_review:${approved.id}`).first('status'), 'done')
    assert.equal(await claims(approved.id), 2)

    const declined = await submit('stay-decline', 12)
    assert.equal((await decide(declined, 'reject')).ok, true)
    assert.equal((await getStay(db, manager, declined.id)).cancellation_reason, 'host_rejected')
    assert.equal(await claims(declined.id), 0)
    assert.equal(await db.prepare('SELECT status FROM tasks WHERE dedupe_key=?').bind(`booking_review:${declined.id}`).first('status'), 'cancelled')

    const withdrawn = await submit('stay-withdraw', 16)
    const cancelled = await cancelStayAsGuest(db, env, ORG, withdrawn.id, OUTSIDER, undefined, withdrawn.version)
    assert.equal(cancelled.stay.cancellation_reason, 'guest_withdrew')
    assert.equal(cancelled.refund_minor, 0)
    assert.equal(await claims(withdrawn.id), 0)

    const expired = await submit('stay-expire', 20)
    const payBy = (await getStay(db, manager, approved.id)).pay_by!
    const deadlines = [Date.parse(expired.respond_by!), Date.parse(payBy)]
    assert.equal(await dispatchStayCheckoutDeadlines(env, ORG, Math.min(...deadlines) - 1), Math.min(...deadlines))
    assert.equal(queue.pending.filter(item => item.body.type === 'stay.checkout_expired').length, 0)
    const due = Math.max(...deadlines)
    t.mock.timers.enable({ apis: ['Date'], now: due })
    try {
      assert.equal(await dispatchStayCheckoutDeadlines(env, ORG, due), null)
      assert.deepEqual(queue.pending.flatMap(item => item.body.type === 'stay.checkout_expired' ? [item.body.id] : []).sort(), [approved.id, expired.id].sort())
      await queue.drain(env, 'stay.checkout_expired')
    } finally {
      t.mock.timers.reset()
    }
    for (const entry of [expired, approved]) {
      assert.equal((await getStay(db, manager, entry.id)).cancellation_reason, 'stay_request_expired')
      assert.equal(await claims(entry.id), 0)
    }

    await updateStayHome(env, db, manager, cabin.id, { timezone: 'Asia/Bangkok', check_in_time: null, check_out_time: null })
    const collision = await submit('stay-ota-conflict', 24)
    assert.equal(collision.starts_at, date(24))
    await updateStayHome(env, db, manager, cabin.id, { check_in_time: '16:00', check_out_time: '01:00' })
    const channel = await applyChannelBooking(db, env, ORG, cabin.id, {
      provider: 'channex', external_booking_id: 'ota-stay-review-conflict', channel_booking_id: null, channel: 'airbnb',
      revision_id: 'ota-stay-review-revision', provider_updated_at: new Date().toISOString(), cancelled: false,
      check_in_date: date(23), check_out_date: date(25), adults: 2, children: 0, infants: 0,
      guest_name: null, guest_surname: null, guest_email: null, guest_phone: null, total_minor: 20_000, currency: 'USD',
    })
    assert.equal(channel.overbooked, true)
    assert.equal(channel.ends_at.slice(0, 10), date(24))
    assert.equal((await decide(collision, 'confirm')).ok, false)
    assert.equal((await getStay(db, manager, collision.id)).request_status, 'awaiting_approval')
    assert.equal((await decide(collision, 'reject')).ok, true)
    assert.equal(await claims(collision.id), 0)
    await assert.rejects(submit('stay-ota-refused', 24), code('STAY_NIGHTS_UNAVAILABLE'))
    const adjacent = await submit('stay-ota-adjacent', 25)
    assert.equal((await decide(adjacent, 'confirm')).ok, true)
    assert.equal((await getStay(db, manager, adjacent.id)).request_status, 'awaiting_payment')
  } finally {
    await runtime.dispose()
  }
})
