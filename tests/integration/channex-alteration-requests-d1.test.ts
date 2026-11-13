import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyBookingRevision } from '../../server/integrations/channex/booking-revisions.ts'
import { mirrorChannexThread } from '../../server/domain/guest-threads/channel-messages.ts'
import { runAlterationRequestFeed } from '../../server/domain/guest-threads/stay-change-requests.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { getStay } from '../../server/domain/stays.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import todayRoute from '../../server/api/dashboard/today.get.ts'
import bookingDetailsRoute from '../../server/api/dashboard/bookings/[booking_id].get.ts'
import bookingActionRoute from '../../server/api/dashboard/bookings/[booking_id]/[action].post.ts'
import type { TaskSection } from '../../server/domain/tasks.ts'
import type { OpportunityView } from '../../server/domain/opportunities.ts'

// An Airbnb guest's change request, from Channex's live feed to the stay's
// conversation and back: recorded once and alerted, answered through
// POST /live_feed/{id}/resolve, the stay changed only by Airbnb's confirmed
// revision, and a request resolved on Airbnb reconciled from what Channex holds.

const ORG = 'org', OWNER = 'owner', MEMBER = 'assigned-member', PROPERTY = 'property'
const RAW = '2026-10-15T23:12:00.123456'

type Stay = { arrival: string; departure: string; adults: number; amount: string }

class FakeChannex {
  revisions = new Map<string, Record<string, unknown>>()
  acked: string[] = []
  /** Alteration requests as Channex holds them: the booking after the change, and Airbnb's outcome once resolved. */
  requests = new Map<string, { booking: string; after: Stay; status: 'ACCEPTED' | 'DECLINED' | 'CANCELED' | null; by?: 'guest' | 'host' }>()
  resolutions: Array<{ id: string; body: unknown }> = []
  /** What Airbnb confirms after an accepted change: the booking's next revision, in order. */
  revisionCount = 0

  revise(booking: string, stay: Stay, status: 'new' | 'modified') {
    this.revisionCount += 1
    const id = `rev-${this.revisionCount}`
    this.revisions.set(id, {
      booking_id: booking, property_id: PROPERTY, status, ota_name: 'AirBNB', ota_reservation_code: `HM${booking}`,
      inserted_at: `2026-10-15T0${this.revisionCount}:00:00Z`, arrival_date: stay.arrival, departure_date: stay.departure, amount: stay.amount, currency: 'USD',
      customer: { name: 'Lee', surname: 'Park', mail: null, phone: null }, occupancy: { adults: stay.adults, children: 0, infants: 0 },
    })
    return id
  }

  /** The event as Channex staging served one on 2026-10-30: bms amounts in minor units, flat occupancy, Airbnb's reservation in raw_message. */
  event(id: string) {
    const request = this.requests.get(id)!
    return { id, type: 'live_feed_event', attributes: { id, event: 'alteration_request', property_id: PROPERTY, channel_id: 'channel', inserted_at: RAW, payload: {
      id: `airbnb-${id}`, message_thread_id: 'thread', resolved: request.status !== null, ...(request.status ? { status: request.status, resolution: request.status.toLowerCase(), comment: 'Resolved at 2026-10-16 00:00:00Z' } : {}),
      bms: { booking_id: request.booking, status: 'modified', arrival_date: request.after.arrival, departure_date: request.after.departure, amount: Math.round(Number(request.after.amount) * 100), currency: 'USD',
        occ_adults: request.after.adults, occ_children: 0, occ_infants: 0, property_id: null, revision_id: null, raw_message: { reservation: { initiated_by: request.by ?? 'guest', status: 'modified' } } },
    } } }
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '')
    const json = (body: unknown) => Response.json(body)
    if (method === 'GET' && path === '/live_feed') {
      assert.equal(url.searchParams.get('filter[event]'), 'alteration_request')
      const rows = [...this.requests.keys()].reverse().map(id => this.event(id))
      return json({ data: rows, meta: { total: rows.length } })
    }
    let match = path.match(/^\/live_feed\/([^/]+)\/resolve$/)
    if (method === 'POST' && match) {
      const id = match[1]!, body = JSON.parse(String(init.body)) as { resolution: { accept: string } }
      this.resolutions.push({ id, body })
      const request = this.requests.get(id)!
      // Resolving a resolved event returns it unchanged.
      if (request.status === null) {
        request.status = body.resolution.accept === 'accept' ? 'ACCEPTED' : 'DECLINED'
        if (request.status === 'ACCEPTED') this.revise(request.booking, request.after, 'modified')
      }
      return json({ data: this.event(id) })
    }
    match = path.match(/^\/live_feed\/([^/]+)$/)
    if (method === 'GET' && match) return json({ data: this.event(match[1]!) })
    if (method === 'GET' && path === '/booking_revisions/feed') {
      const pending = [...this.revisions.keys()].filter(id => !this.acked.includes(id))
      return json({ data: pending.map(id => ({ id, type: 'booking_revision', attributes: this.revisions.get(id) })), meta: { total: pending.length } })
    }
    match = path.match(/^\/booking_revisions\/([^/]+)\/ack$/)
    if (method === 'POST' && match) { this.acked.push(match[1]!); return json({ meta: { message: 'Success' } }) }
    match = path.match(/^\/booking_revisions\/([^/]+)$/)
    if (method === 'GET' && match) return json({ data: { id: match[1], type: 'booking_revision', attributes: this.revisions.get(match[1]!) } })
    // The booking's Airbnb conversation, which the stay's change requests are recorded in.
    const thread = { id: 'thread', type: 'message_thread', attributes: { title: 'Lee', provider: 'AirBNB', is_closed: false, message_count: 1, inserted_at: RAW, updated_at: RAW },
      relationships: { property: { data: { type: 'property', id: PROPERTY } }, channel: { data: { type: 'channel', id: 'channel' } }, booking: { data: { type: 'booking', id: 'bk-1' } } } }
    if (method === 'GET' && path === '/message_threads/thread') return json({ data: thread })
    if (method === 'GET' && path === '/message_threads/thread/messages') {
      return json({ data: [{ id: 'hello', type: 'message', attributes: { sender: 'guest', message: 'Hello', attachments: [], inserted_at: RAW, updated_at: RAW, meta: null },
        relationships: { message_thread: { data: { type: 'message_thread', id: 'thread' } } } }], meta: { total: 1 } })
    }
    if (method === 'POST' && (path === '/restrictions' || path === '/availability')) return json({ data: [{ id: crypto.randomUUID(), type: 'task' }], meta: { message: 'Success', warnings: [] } })
    throw new Error(`Unexpected provider boundary: ${method} ${path}`)
  }
}

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'alteration-requests-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, AI: { type: 'ai' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'alteration-requests-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('owner-member', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('location', ?, 'cabin', 'Cabin', 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG).run()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'location', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'owner-member' },
    } })
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing', 'channel', ?, 'room', 'rate', 'complete', 1)`).bind(ORG, home.id, PROPERTY).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Assigned member', 'assigned-member@example.test', 1, 0, 0)").bind(MEMBER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('assigned-member-membership', ?, ?, 'member', 0)").bind(ORG, MEMBER).run()
    const auth = createAuth(env)
    const password = 'AlterationTodayProof123!'
    const hashedPassword = await hashPassword(password)
    const tokens = new Map<string, string>()
    for (const user of [OWNER, MEMBER]) {
      await db.prepare("INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,0,0)").bind(`${user}-credential`, user, user, hashedPassword).run()
      const login = await auth.api.signInEmail({ body: { email: `${user}@example.test`, password }, asResponse: true })
      assert.equal(login.status, 200)
      const token = login.headers.get('set-auth-token')
      assert.ok(token)
      tokens.set(user, token)
    }
    const app = new H3()
    app.get('/api/dashboard/today', todayRoute)
    app.get('/api/dashboard/bookings/:booking_id', bookingDetailsRoute)
    app.post('/api/dashboard/bookings/:booking_id/:action', bookingActionRoute)
    const request = (path: string, user = OWNER, body?: Record<string, unknown>) => app.request(Object.assign(new Request(`https://proof.example/api/dashboard/${path}?org=${ORG}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${tokens.get(user)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    /** Today as the dashboard reads it: each task as kind and conversation, each opportunity as the operation it records. */
    const today = async () => {
      const response = await request('today')
      const body = await response.text()
      assert.equal(response.status, 200, body)
      const feed = JSON.parse(body) as { tasks: TaskSection[]; opportunities: OpportunityView[] }
      const operations = new Map((await db.prepare('SELECT id, operation FROM opportunities WHERE organization_id = ?').bind(ORG).all<{ id: string; operation: string }>()).results.map(row => [row.id, row.operation]))
      return {
        tasks: feed.tasks.flatMap(section => section.tasks.map(task => [task.kind, task.conversation_id])),
        changePath: feed.tasks.flatMap(section => section.tasks).find(task => task.kind === 'booking_change')?.action?.path,
        opportunities: feed.opportunities.map(opportunity => operations.get(opportunity.id)),
      }
    }
    const reservation = async (bookingId: string, user = OWNER) => {
      const response = await request(`bookings/${bookingId}`, user)
      const body = await response.text()
      assert.equal(response.status, 200, body)
      return JSON.parse(body) as { booking: { pending_changes?: Awaited<ReturnType<typeof import('../../server/domain/guest-threads/stay-change-requests.ts').pendingStayChanges>> }; manage: boolean }
    }
    const answer = (bookingId: string, requestId: string, action: 'accept_change' | 'decline_change', user = OWNER) =>
      request(`bookings/${bookingId}/${action}`, user, { message_id: requestId })
    return { runtime, db, env, reservation, answer, today }
  } catch (error) { await runtime.dispose(); throw error }
}

/** An Airbnb booking landed from its revision, as Channex delivers it, with its conversation mirrored or not yet arrived. */
async function airbnbStay(db: D1Database, env: CloudflareEnv, channex: FakeChannex, conversation = true) {
  await applyBookingRevision(db, env, channex.revise('bk-1', { arrival: '2027-01-10', departure: '2027-01-13', adults: 2, amount: '450.00' }, 'new'))
  if (conversation) assert.equal((await mirrorChannexThread(db, env, 'thread', PROPERTY)).status, 'mirrored')
  // Every booking has its conversation; Airbnb's thread is addressed to it once mirrored.
  const stay = await db.prepare("SELECT b.id, c.id AS conversation_id, EXISTS (SELECT 1 FROM channel_threads t WHERE t.conversation_id = c.id) AS mirrored FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking' WHERE b.external_booking_id = 'bk-1'").first<{ id: string; conversation_id: string; mirrored: number }>()
  assert.equal(stay!.mirrored === 1, conversation)
  return stay!
}

/** The stay as the host's stay screen reads it. */
const stayRow = async (db: D1Database, id: string) => {
  const { check_in_date, check_out_date, adults, total_minor, version } = await getStay(db, { organizationId: ORG, actorId: OWNER, manage: true }, id)
  return { check_in_date, check_out_date, adults, total_minor, version }
}
const requests = (db: D1Database, threadId: string) => db.prepare("SELECT id, author_kind, channel, json_extract(payload_json, '$.live_feed_event_id') AS event FROM messages WHERE conversation_id = ? AND event_name = 'booking_change.requested' ORDER BY sequence").bind(threadId).all<{ id: string; author_kind: string; channel: string | null; event: string }>().then(rows => rows.results)
const decision = (db: D1Database, requestId: string) => db.prepare("SELECT event_name, author_kind, author_user_id, body FROM messages WHERE dedupe_key = ?").bind(`booking-change-decision:${requestId}`).first()
const alerts = (db: D1Database, requestId: string) => db.prepare("SELECT purpose, channel, status FROM guest_thread_deliveries WHERE message_id = ? ORDER BY channel").bind(requestId).all().then(rows => rows.results)
/** The open reply tasks of a conversation, by their dedupe key (the guest entry they are about). */
const openReplies = (db: D1Database, threadId: string) => db.prepare("SELECT dedupe_key FROM tasks WHERE kind = 'guest_reply' AND subject_type = 'conversation' AND subject_id = ? AND status = 'open'").bind(threadId).all<{ dedupe_key: string }>().then(rows => rows.results.map(row => row.dedupe_key))
const firstGuestMessage = (db: D1Database, threadId: string) => db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND author_kind = 'guest' ORDER BY sequence LIMIT 1").bind(threadId).first<string>('id')
const denied = async (response: Response, status: number, code: string) => {
  assert.equal(response.status, status)
  assert.equal((await response.json() as { data: { code: string } }).data.code, code)
}

test('a guest change request lands once in the stay conversation, survives a reload, and accepting resolves it on Channex and lands Airbnb’s revision', { timeout: 120_000 }, async () => {
  const { runtime, db, env, reservation, answer, today } = await boot()
  const channex = new FakeChannex(), realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    // The request arrives before the booking's conversation: the thread it names is mirrored first.
    const { id: stayId } = await airbnbStay(db, env, channex, false)
    channex.requests.set('alt-1', { booking: 'bk-1', after: { arrival: '2027-01-10', departure: '2027-01-14', adults: 3, amount: '600.00' }, status: null })
    assert.deepEqual(await runAlterationRequestFeed(db, env, PROPERTY), { recorded: 1, reconciled: 0 })
    const stay = (await db.prepare("SELECT b.id, c.id AS conversation_id FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking' WHERE b.id = ?").bind(stayId).first<{ id: string; conversation_id: string }>())!
    assert.equal(typeof stay.conversation_id, 'string')
    // A repeated webhook or feed run records nothing twice and alerts nobody twice.
    assert.deepEqual(await runAlterationRequestFeed(db, env), { recorded: 0, reconciled: 0 })
    const [request, ...extra] = await requests(db, stay.conversation_id)
    assert.deepEqual([request && { author_kind: request.author_kind, channel: request.channel, event: request.event }, extra], [{ author_kind: 'krabiclaw', channel: 'airbnb', event: 'alt-1' }, []])
    assert.deepEqual(await alerts(db, request!.id), [{ purpose: 'owner_alert', channel: 'email', status: 'sent' }])
    const guestMessage = await firstGuestMessage(db, stay.conversation_id)
    assert.equal(typeof guestMessage, 'string')
    assert.deepEqual(await openReplies(db, stay.conversation_id), [`guest_reply:${stay.conversation_id}:${guestMessage}`])

    // The reservation shows the current and proposed terms as distinct, before Airbnb confirms a change.
    assert.deepEqual((await reservation(stay.id)).booking.pending_changes, [{
      id: request!.id, requested_by: 'guest',
      before: { dates: 'Jan 10, 2027 – Jan 13, 2027', guests: 2, total: '$450.00' },
      after: { dates: 'Jan 10, 2027 – Jan 14, 2027', guests: 3, total: '$600.00' },
    }])
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-13', adults: 2, total_minor: 45_000, version: 1 })
    // The guest's change is the business's to answer: a change task beside the reply task.
    const expectedToday = { tasks: [['guest_reply', stay.conversation_id], ['booking_change', stay.conversation_id]], opportunities: ['post.create', 'social.connect', 'article.create'] }
    assert.deepEqual(await today(), { ...expectedToday, changePath: `/dashboard/org/bookings/${stay.id}` })

    // Assignment allows the turnover to be read. Even with a thread seat, it gives no decision permission.
    await db.prepare("UPDATE product_booking_configs SET assigned_member_id = 'assigned-member-membership' WHERE organization_id = ?").bind(ORG).run()
    await db.prepare("INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)").bind(stay.conversation_id, ORG, MEMBER, '2026-10-15T00:00:00.000Z').run()
    const turnover = await reservation(stay.id, MEMBER)
    assert.equal(turnover.manage, false)
    assert.equal('pending_changes' in turnover.booking, false)
    await denied(await answer(stay.id, request!.id, 'accept_change', MEMBER), 403, 'STAY_ROLE_REQUIRED')
    // A stay manager who left the conversation keeps the reservation and loses access to the request.
    await db.prepare("DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?").bind(stay.conversation_id, OWNER).run()
    assert.deepEqual((await reservation(stay.id)).booking.pending_changes, [])
    await denied(await answer(stay.id, request!.id, 'accept_change'), 404, 'THREAD_NOT_FOUND')
    assert.deepEqual(channex.resolutions, [])
    await db.prepare("INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)").bind(stay.conversation_id, ORG, OWNER, '2026-10-15T00:00:00.000Z').run()

    const accepted = await answer(stay.id, request!.id, 'accept_change')
    assert.equal(accepted.status, 204, await accepted.text())
    assert.deepEqual(channex.resolutions, [{ id: 'alt-1', body: { resolution: { accept: 'accept' } } }])
    assert.deepEqual(await decision(db, request!.id), { event_name: 'booking_change.accepted', author_kind: 'krabiclaw', author_user_id: OWNER, body: 'Accepted the guest’s change on Airbnb.' })
    // Airbnb's confirmed revision is the change: landed and acknowledged, the stay now as the guest asked.
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-14', adults: 3, total_minor: 60_000, version: 2 })
    assert.deepEqual(channex.acked, ['rev-1', 'rev-2'])
    // Answering the change closes its task, by the member who answered; the guest's message is still owed a reply.
    assert.deepEqual(await db.prepare("SELECT status, closed_by_user_id FROM tasks WHERE dedupe_key = ?").bind(`booking_change:${request!.id}`).first(), { status: 'done', closed_by_user_id: OWNER })
    assert.deepEqual(await openReplies(db, stay.conversation_id), [`guest_reply:${stay.conversation_id}:${guestMessage}`])
    const answeredThread = (await getGuestThreadDetail(db, stay.conversation_id, ORG))!
    assert.equal(answeredThread.needsReply, true, 'the inbox preserves the separate unanswered message after a booking decision')
    assert.deepEqual((await reservation(stay.id)).booking.pending_changes, [])
    // The accepted change is recorded above; the guest's separate unanswered
    // message remains the only action, rather than adding completion history.
    assert.deepEqual(await today(), { ...expectedToday, changePath: undefined })

    // Answering again, or the feed seeing it resolved, changes nothing and sends nothing to Channex.
    assert.equal((await answer(stay.id, request!.id, 'accept_change')).status, 204)
    assert.deepEqual(await runAlterationRequestFeed(db, env), { recorded: 0, reconciled: 0 })
    assert.equal(channex.resolutions.length, 1)
    assert.deepEqual(await today(), { ...expectedToday, changePath: undefined })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('declining leaves the stay as it is; a request withdrawn or answered on Airbnb is reconciled from Channex, and one never seen pending is not recorded', { timeout: 120_000 }, async () => {
  const { runtime, db, env, reservation, answer } = await boot()
  const channex = new FakeChannex(), realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const stay = await airbnbStay(db, env, channex)
    const later = { arrival: '2027-01-11', departure: '2027-01-14', adults: 2, amount: '450.00' }
    channex.requests.set('alt-old', { booking: 'bk-1', after: later, status: 'DECLINED' })
    for (const id of ['alt-decline', 'alt-withdrawn', 'alt-answered']) channex.requests.set(id, { booking: 'bk-1', after: later, status: null })
    // A change the host proposed on Airbnb is recorded waiting on the guest: nobody here is alerted or may answer it.
    channex.requests.set('alt-host', { booking: 'bk-1', after: later, status: null, by: 'host' })
    assert.deepEqual(await runAlterationRequestFeed(db, env, PROPERTY), { recorded: 3, reconciled: 0 })
    const recorded = new Map((await requests(db, stay.conversation_id!)).map(row => [row.event, row.id]))
    assert.deepEqual([...recorded.keys()].sort(), ['alt-answered', 'alt-decline', 'alt-host', 'alt-withdrawn'])
    const hostProposal = recorded.get('alt-host')!
    assert.deepEqual(await alerts(db, hostProposal), [])
    assert.equal((await reservation(stay.id)).booking.pending_changes?.find(change => change.id === hostProposal)?.requested_by, 'host')
    await denied(await answer(stay.id, hostProposal, 'accept_change'), 409, 'CHANGE_REQUEST_AWAITS_GUEST')
    recorded.delete('alt-host')

    assert.equal((await answer(stay.id, recorded.get('alt-decline')!, 'decline_change')).status, 204)
    assert.deepEqual(channex.resolutions, [{ id: 'alt-decline', body: { resolution: { accept: 'decline' } } }])
    assert.deepEqual(await decision(db, recorded.get('alt-decline')!), { event_name: 'booking_change.declined', author_kind: 'krabiclaw', author_user_id: OWNER, body: 'Declined the guest’s change on Airbnb.' })
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-13', adults: 2, total_minor: 45_000, version: 1 })

    // The guest withdrew on Airbnb, which sends no notification: the next feed run reads it.
    // The host's own proposal, accepted by the guest there, reads as the guest's answer.
    channex.requests.get('alt-withdrawn')!.status = 'CANCELED'
    channex.requests.get('alt-host')!.status = 'ACCEPTED'
    assert.deepEqual(await runAlterationRequestFeed(db, env), { recorded: 0, reconciled: 2 })
    assert.deepEqual(await decision(db, recorded.get('alt-withdrawn')!), { event_name: 'booking_change.withdrawn', author_kind: 'krabiclaw', author_user_id: null, body: 'The guest withdrew the change on Airbnb.' })
    assert.deepEqual(await decision(db, hostProposal), { event_name: 'booking_change.accepted', author_kind: 'krabiclaw', author_user_id: null, body: 'The guest accepted the change on Airbnb.' })

    // Declined on Airbnb before the host answered here: the host's accept records Airbnb's outcome and is refused naming it.
    channex.requests.get('alt-answered')!.status = 'DECLINED'
    await denied(await answer(stay.id, recorded.get('alt-answered')!, 'accept_change'), 409, 'CHANGE_REQUEST_RESOLVED')
    assert.deepEqual(await decision(db, recorded.get('alt-answered')!), { event_name: 'booking_change.declined', author_kind: 'krabiclaw', author_user_id: null, body: 'The guest’s change was declined on Airbnb.' })
    assert.equal(channex.resolutions.length, 1)

    assert.deepEqual((await reservation(stay.id)).booking.pending_changes, [])
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-13', adults: 2, total_minor: 45_000, version: 1 })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
