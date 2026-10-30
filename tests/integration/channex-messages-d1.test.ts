import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'h3'
import { hashPassword } from 'better-auth/crypto'
import sharp from 'sharp'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, type ChannelBooking } from '../../server/domain/stays.ts'
import { backfillChannexMessages, mirrorChannexMessageEvent, mirrorChannexThread } from '../../server/domain/guest-threads/channel-messages.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { createDeliveryReceipt } from '../../server/domain/guest-threads/deliveries.ts'
import { getGuestRequest } from '../../server/domain/requests.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import todayRoute from '../../server/api/dashboard/today.get.ts'
import type { TodayFeedPayload } from '../../shared/dashboard-today.ts'
import { guestThreadListPage, parseGuestThreadListQuery } from '../../server/utils/dashboard-guest-threads.ts'
import { assertAssignedBookingAccess, memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { listBusinessOutcomes } from '../../server/utils/business-outcomes.ts'

const ORG = 'org', OWNER = 'owner'
const NOW = '2026-10-16T00:00:00.000Z'
const RAW = '2026-10-15T23:12:00.123456'
const code = (expected: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected

class Provider {
  threadId = 'thread'
  bookingId: string | null = null
  propertyId = 'property'
  /** Booking revisions Channex has not had acknowledged: what a conversation naming an unlanded booking lands first. */
  pendingRevisions: Array<{ id: string; attributes: Record<string, unknown> }> = []
  acked: string[] = []
  empty = false
  uncertain = false
  refuseAttachment = false
  attachmentNetworkFailure = false
  refuseMessage = false
  airbnbUnavailable = false
  sends = 0
  uploads: Array<{ file: string; file_name: string; file_type: string }> = []
  images = new Map<string, Uint8Array<ArrayBuffer>>()
  imageReads = 0
  refuseImageRead = false
  onSend?: () => void
  holdReply?: Promise<void>
  messages = [this.message('first', 'guest', 'Hello'), this.message('second', 'system', null, ['/attachment/file'])]

  thread() {
    return { id: this.threadId, type: 'message_thread', attributes: { title: 'Conversation supplied by Airbnb', provider: 'AirBNB', is_closed: false, message_count: this.messages.length, inserted_at: RAW, updated_at: RAW },
      relationships: { property: { data: { type: 'property', id: this.propertyId } }, channel: { data: { type: 'channel', id: 'channel' } }, booking: { data: this.bookingId === null ? null : { type: 'booking', id: this.bookingId } } } }
  }

  message(id: string, sender: string, text: string | null, attachments: string[] = []) {
    return { id, type: 'message', attributes: { sender, message: text, attachments, inserted_at: RAW, updated_at: RAW, meta: sender === 'system' ? { inquiry: true } : null },
      relationships: { message_thread: { data: { type: 'message_thread', id: this.threadId } } } }
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init.method ?? 'GET'
    const json = (body: unknown) => Response.json(body)
    if (url.hostname === 'api.cloudflare.com') {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-images-key')
      if (method === 'POST' && url.pathname === '/client/v4/accounts/account-proof/images/v1') {
        assert.ok(init.body instanceof FormData)
        const file = init.body.get('file'), id = init.body.get('id')
        assert.ok(file instanceof File)
        assert.equal(typeof id, 'string')
        this.images.set(id as string, new Uint8Array(await file.arrayBuffer()))
        return json({ result: { id } })
      }
      const blob = url.pathname.match(/^\/client\/v4\/accounts\/account-proof\/images\/v1\/([^/]+)\/blob$/)
      if (method === 'GET' && blob) {
        this.imageReads += 1
        const bytes = this.images.get(decodeURIComponent(blob[1]!))
        return this.refuseImageRead || !bytes ? new Response('Image unavailable', { status: 404 }) : new Response(bytes)
      }
    }
    if (method === 'GET' && url.pathname === '/api/v1/message_threads') return json({ data: this.empty ? [] : [this.thread()], meta: { total: this.empty ? 0 : 1 } })
    if (method === 'GET' && url.pathname === `/api/v1/message_threads/${this.threadId}`) return json({ data: this.thread() })
    // Bookings reach KrabiClaw as revisions only; a booking read by id is not answered.
    if (method === 'GET' && url.pathname === '/api/v1/booking_revisions/feed') {
      assert.equal(url.searchParams.get('filter[property_id]'), this.propertyId)
      const pending = this.pendingRevisions.filter(revision => !this.acked.includes(revision.id))
      return json({ data: pending.map(revision => ({ ...revision, type: 'booking_revision' })), meta: { total: pending.length } })
    }
    const ack = url.pathname.match(/^\/api\/v1\/booking_revisions\/([^/]+)\/ack$/)
    if (method === 'POST' && ack) { this.acked.push(ack[1]!); return json({ meta: { message: 'Success' } }) }
    if (method === 'GET' && url.pathname === `/api/v1/message_threads/${this.threadId}/messages`) {
      assert.equal(url.searchParams.get('order[inserted_at]'), 'asc')
      return json({ data: this.messages, meta: { total: this.messages.length } })
    }
    if (method === 'POST' && url.pathname === '/api/v1/attachments') {
      const body = JSON.parse(String(init.body)) as { attachment: { file: string; file_name: string; file_type: string } }
      this.uploads.push(body.attachment)
      if (this.refuseAttachment) return Response.json({ errors: { code: 'not_supported', title: 'Attachment refused' } }, { status: 422 })
      if (this.attachmentNetworkFailure) throw new TypeError('The attachment upload connection ended without an answer')
      return json({ data: { id: `photo-${this.uploads.length}`, type: 'attachment' } })
    }
    if (method === 'POST' && url.pathname === `/api/v1/message_threads/${this.threadId}/messages`) {
      this.sends += 1
      if (this.refuseMessage) return Response.json({ errors: { code: 'not_supported', title: 'Message refused' } }, { status: 422 })
      const body = JSON.parse(String(init.body)) as { message: { message?: string; attachment_id?: string } }
      if (body.message.attachment_id) assert.deepEqual(Object.keys(body.message), ['attachment_id'])
      const sent = this.message(`accepted-${this.sends}`, 'property', body.message.message ?? null, body.message.attachment_id ? [`attachments/${body.message.attachment_id}`] : [])
      this.messages.push(sent)
      this.onSend?.()
      if (this.holdReply) await this.holdReply
      if (this.uncertain) throw new TypeError('The connection ended after the provider accepted the write')
      if (this.airbnbUnavailable) return Response.json({ errors: { error_code: 500, error_message: 'Airbnb could not complete the request' } }, { status: 422 })
      return json({ data: sent })
    }
    throw new Error(`Unexpected provider boundary: ${method} ${url.pathname}`)
  }
}

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'channel-messages-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'channel-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('owner-member', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('location', ?, 'cabin', 'Cabin', 'active', 'America/Denver', ?, ?)`).bind(ORG, NOW, NOW).run()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), MEDIA_BASE_URL: 'https://media.example.test', CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'test-provider-key', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'location', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'owner-member', assigned_team_id: null },
    } })
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing', 'channel', 'property', 'room', 'rate', 'complete', 1)`).bind(ORG, home.id).run()
    return { runtime, db, env, productId: home.id }
  } catch (error) { await runtime.dispose(); throw error }
}

function booking(id = 'booking'): ChannelBooking {
  return { provider: 'channex', external_booking_id: id, channel_booking_id: 'Airbnb-booking', channel: 'airbnb', revision_id: 'revision', provider_updated_at: '2026-10-16T00:00:00Z',
    cancelled: false, check_in_date: '2027-01-01', check_out_date: '2027-01-03', adults: 2, children: 0, infants: 0,
    guest_name: 'Actual', guest_surname: 'Guest', guest_email: null, guest_phone: null, total_minor: 30_000, currency: 'USD' }
}

test('empty greenfield collections are valid; inquiries mirror into the canonical inbox without invented guest contact or clock', async () => {
  const { runtime, db, env, productId } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    provider.empty = true
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 0 })
    assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 0)
    provider.empty = false
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    const rows = await listGuestThreads(db, ORG, { userId: OWNER, type: 'stay' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.productId, productId)
    assert.equal(rows[0]!.stayChannel, null)
    assert.deepEqual([rows[0]!.guestName, rows[0]!.participantLabel, rows[0]!.replyChannel, rows[0]!.mailbox], [null, 'Conversation supplied by Airbnb', 'airbnb', 'current'])
    const detail = (await getGuestThreadDetail(db, rows[0]!.id, ORG))!
    assert.deepEqual([detail.operationalRecord, detail.guestEmail, detail.guestPhone], [null, null, null])
    assert.deepEqual(detail.entries.map(entry => [entry.body, entry.actorKind, entry.providerTimestamp]), [['Hello', 'guest', RAW], [null, 'system', RAW]])
    assert.equal(detail.entries[1]!.attachments[0]!.url, 'https://channex.test/attachment/file')
    assert.notEqual(detail.entries[0]!.occurredAt, RAW)
    // The actual imported inquiry has no guest identity or linked stay. Today
    // displays its recorded conversation title without inventing either one.
    const password = 'ChannelInquiryProof123!'
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('owner-credential', ?, 'credential', ?, ?, 0, 0)").bind(OWNER, OWNER, await hashPassword(password)).run()
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password }, asResponse: true })
    assert.equal(login.status, 200)
    const token = login.headers.get('set-auth-token')
    assert.ok(token)
    const app = new H3()
    app.get('/api/dashboard/today', todayRoute)
    const response = await app.request(Object.assign(new Request('https://proof.example/api/dashboard/today?org=org', { headers: { authorization: `Bearer ${token}` } }),
      { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal(response.status, 200)
    const today = await response.json() as TodayFeedPayload
    assert.equal(today.cards.find(card => card.id === 'offer:calendar_sync')?.imageUrl, 'https://proof.example/images/offers/calendar.webp', 'Today exposes its platform illustration as an absolute HTTPS URL for native clients')
    assert.deepEqual(today.cards.filter(card => card.priority === 'attention').map(card => ({ id: card.id, headline: card.headline, to: card.to, bookingKind: card.bookingKind,
      stayId: card.stayId, productId: card.productId, occurrenceAt: card.occurrenceAt, timeZone: card.timeZone, imageIcon: card.imageIcon })), [{
      id: `attention:${rows[0]!.id}`, headline: 'Review conversation: Conversation supplied by Airbnb', to: `/dashboard/org/messages/${rows[0]!.id}`,
      bookingKind: null, stayId: null, productId, occurrenceAt: null, timeZone: null, imageIcon: 'i-lucide-message-circle',
    }])
    const afterToday = (await getGuestThreadDetail(db, rows[0]!.id, ORG))!
    assert.deepEqual([afterToday.guestName, afterToday.guestEmail, afterToday.guestPhone, afterToday.operationalRecord], [null, null, null, null])
    assert.equal(await db.prepare('SELECT count(*) FROM stays').first('count(*)'), 0)
    // An Airbnb conversation is the stay's guest conversation: owners and admins open it; a member does not, even one responsible for the home.
    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, organizationId: ORG, role }, { env })
    await assertAssignedBookingAccess(db, { ...principal(OWNER, 'owner'), requestId: rows[0]!.id })
    await assert.rejects(assertAssignedBookingAccess(db, { ...principal(OWNER, 'member'), requestId: rows[0]!.id }), code('THREAD_NOT_FOUND'))
    await assert.rejects(assertAssignedBookingAccess(db, { ...principal('unassigned-user', 'member'), requestId: rows[0]!.id }), code('THREAD_NOT_FOUND'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 2)
    await assert.rejects(mirrorChannexMessageEvent(db, env, { event: 'message', property_id: 'property', payload: { id: 'not-visible-yet', property_id: 'property', message_thread_id: 'thread' } }), code('CHANNEL_MESSAGE_NOT_READY'))
    provider.propertyId = 'another-property'
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('INVALID_PROVIDER_RESPONSE'))
    assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 1)
    provider.propertyId = 'property'
    provider.messages[0]!.attributes.message = 'Changed after recording'
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('CHANNEL_MESSAGE_ID_CONFLICT'))
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('the inbox exposes every page with a stable tie order and validates pagination instead of hiding a row cap', async () => {
  const { runtime, db } = await boot()
  try {
    const payload = JSON.stringify({ guest: { name: 'Guest', email: 'guest@example.test', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null })
    for (const id of ['e', 'c', 'b', 'd', 'a']) {
      await db.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json, created_at, updated_at) VALUES (?, 'contact', ?, 'needs_attention', ?, ?, ?)").bind(id, ORG, payload, NOW, NOW).run()
    }
    const first = guestThreadListPage(await listGuestThreads(db, ORG, { userId: OWNER, limit: 4, offset: 0 }), { limit: 3, offset: 0 })
    assert.deepEqual(first.threads.map(thread => thread.id), ['a', 'b', 'c'])
    assert.deepEqual(first.pagination, { limit: 3, offset: 0, hasMore: true, nextOffset: 3 })
    const last = guestThreadListPage(await listGuestThreads(db, ORG, { userId: OWNER, limit: 4, offset: 3 }), { limit: 3, offset: 3 })
    assert.deepEqual(last.threads.map(thread => thread.id), ['d', 'e'])
    assert.deepEqual(last.pagination, { limit: 3, offset: 3, hasMore: false, nextOffset: null })
    for (const [query, field] of [[{ limit: '0' }, 'limit'], [{ limit: '101' }, 'limit'], [{ offset: '-1' }, 'offset'], [{ limit: ['3'] }, 'limit'],
      [{ type: 'everything' }, 'type'], [{ conversation_state: '' }, 'conversation_state'], [{ mailbox: ['past'] }, 'mailbox'], [{ unread: 'yes' }, 'unread'], [{ location_id: ' ' }, 'location_id'], [{ organization_id: 'org' }, 'organization_id']] as const) {
      assert.throws(() => parseGuestThreadListQuery(query), { status: 400, data: { code: 'INVALID_GUEST_THREAD_FILTER', field } })
    }
    assert.deepEqual(parseGuestThreadListQuery({ limit: '3', offset: '3' }), { limit: 3, offset: 3, locationId: null, type: null, conversationState: null, unreadOnly: false, mailbox: null })
  } finally { await runtime.dispose() }
})

test('booking assignment before or after booking arrival adopts one request and preserves its immutable ledger and receipts', async () => {
  for (const first of ['conversation', 'booking'] as const) {
    const { runtime, db, env, productId } = await boot()
    const provider = new Provider(), realFetch = globalThis.fetch
    globalThis.fetch = provider.fetch as typeof fetch
    try {
      provider.bookingId = 'booking'
      let stay = first === 'booking' ? await applyChannelBooking(db, env, ORG, productId, booking()) : null
      if (stay) assert.equal(stay.request_id, null)
      await mirrorChannexMessageEvent(db, env, { event: 'message_thread_booking_assigned', property_id: 'property', payload: { booking_id: 'booking', message_thread_id: 'thread' } })
      const requestId = (await db.prepare('SELECT request_id FROM channel_threads').first<string>('request_id'))!
      const historical = await appendEntry(db, { threadId: requestId, kind: 'message', actorKind: 'member', actorUserId: OWNER, body: 'Recorded history', channel: 'email', dedupeKey: 'history' })
      const receipt = await createDeliveryReceipt(db, { entryId: historical.id, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'historical-delivery' })
      stay = await applyChannelBooking(db, env, ORG, productId, { ...booking(), revision_id: 'revision-2', provider_updated_at: '2026-10-16T01:00:00Z' })
      assert.equal(stay.request_id, requestId)
      assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 1)
      assert.equal(await db.prepare('SELECT entry_id FROM guest_thread_deliveries WHERE id = ?').bind(receipt.id).first('entry_id'), historical.id)
      const detail = (await getGuestThreadDetail(db, requestId, ORG))!
      assert.deepEqual([detail.guestName, detail.participantLabel, detail.operationalRecord?.id], ['Actual Guest', 'Conversation supplied by Airbnb', stay.id])
      assert.equal(detail.entries.length, 3)
      await applyChannelBooking(db, env, ORG, productId, { ...booking(), revision_id: 'revision-3', provider_updated_at: '2026-10-16T02:00:00Z', cancelled: true, guest_name: null, guest_surname: null })
      assert.equal((await getGuestThreadDetail(db, requestId, ORG))!.guestName, null)
      assert.equal(await db.prepare('SELECT count(*) FROM stay_nights').first('count(*)'), 0)
      assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 3)
    } finally { globalThis.fetch = realFetch; await runtime.dispose() }
  }
})

test('a reservation moved to a new Channex account keeps its conversation in either arrival order, and its re-delivered history is not recorded twice', async () => {
  for (const first of ['booking', 'conversation'] as const) {
    const { runtime, db, env, productId } = await boot()
    const provider = new Provider(), realFetch = globalThis.fetch
    globalThis.fetch = provider.fetch as typeof fetch
    try {
      provider.bookingId = 'booking'
      const stay = await applyChannelBooking(db, env, ORG, productId, booking())
      await mirrorChannexThread(db, env, 'thread', 'property')
      const requestId = (await db.prepare('SELECT request_id FROM channel_threads').first<string>('request_id'))!
      const entries = async () => (await db.prepare("SELECT body, actor_kind FROM activity_entries WHERE request_id = ? AND event_name = 'channel.message_mirrored' ORDER BY sequence").bind(requestId).all()).results
      assert.deepEqual(await entries(), [{ body: 'Hello', actor_kind: 'guest' }, { body: null, actor_kind: 'system' }])

      // The new account has the same reservation, thread and Airbnb history under its own ids, and one message since.
      provider.threadId = 'thread-production'
      provider.bookingId = 'booking-production'
      provider.messages = [provider.message('production-first', 'guest', 'Hello'), provider.message('production-second', 'system', null, ['/attachment/file']), provider.message('production-third', 'guest', 'Arriving late')]
      const moved = { ...booking('booking-production'), revision_id: 'revision-production', provider_updated_at: '2026-10-20T00:00:00Z' }
      if (first === 'booking') await applyChannelBooking(db, env, ORG, productId, moved)
      // The conversation arriving first finds its booking's revision still unacknowledged in the feed and lands it.
      else provider.pendingRevisions = [{ id: 'revision-production', attributes: { booking_id: 'booking-production', property_id: 'property', status: 'modified', ota_name: 'Airbnb', ota_reservation_code: 'Airbnb-booking',
        inserted_at: '2026-10-20T00:00:00Z', arrival_date: '2027-01-01', departure_date: '2027-01-03', amount: '300.00', currency: 'USD', customer: { name: 'Actual', surname: 'Guest', mail: null, phone: null }, occupancy: { adults: 2, children: 0, infants: 0 } } }]
      await mirrorChannexThread(db, env, 'thread-production', 'property')
      if (first === 'conversation') {
        assert.deepEqual(provider.acked, ['revision-production'], first)
        assert.deepEqual(await applyChannelBooking(db, env, ORG, productId, moved).then(result => result.applied), false, 'the revision the conversation landed is the current one')
      }


      assert.deepEqual((await db.prepare('SELECT external_thread_id, external_booking_id, moved_from_thread_id, request_id FROM channel_threads').all()).results,
        [{ external_thread_id: 'thread-production', external_booking_id: 'booking-production', moved_from_thread_id: 'thread', request_id: requestId }], first)
      assert.deepEqual((await db.prepare('SELECT id, external_booking_id, request_id FROM stays').all()).results, [{ id: stay.id, external_booking_id: 'booking-production', request_id: requestId }], first)
      assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 1, first)
      assert.deepEqual(await entries(), [{ body: 'Hello', actor_kind: 'guest' }, { body: null, actor_kind: 'system' }, { body: 'Arriving late', actor_kind: 'guest' }], first)
      // A message whose text differs at the same Airbnb time is its own message.
      provider.messages.push(provider.message('production-fourth', 'guest', 'Hello again'))
      await mirrorChannexThread(db, env, 'thread-production', 'property')
      assert.equal((await entries()).length, 4, first)
    } finally { globalThis.fetch = realFetch; await runtime.dispose() }
  }
})

test('an existing stay timeline is adopted intact; two existing timelines fail explicitly rather than discard either', async () => {
  const { runtime, db, env, productId } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    const stay = await applyChannelBooking(db, env, ORG, productId, booking())
    await db.prepare(`INSERT INTO requests (id, kind, organization_id, location_id, conversation_state, payload_json, created_at, updated_at)
      VALUES ('history', 'stay', ?, 'location', 'needs_attention', ?, ?, ?)`).bind(ORG, JSON.stringify({ guest: { name: 'Recorded contact', email: 'recorded@example.test', phone: null } }), NOW, NOW).run()
    await db.prepare("UPDATE stays SET request_id = 'history' WHERE id = ?").bind(stay.id).run()
    await appendEntry(db, { threadId: 'history', kind: 'message', actorKind: 'guest', channel: 'email', body: 'Historical message', dedupeKey: 'old' })
    const input = { threadId: 'history', organizationId: ORG, action: 'reply', body: 'Hello', idempotencyKey: 'unaddressable', actorUserId: OWNER, env }
    await assert.rejects(executeGuestThreadOperation(db, input), code('CHANNEL_THREAD_UNADDRESSABLE'))
    provider.bookingId = 'booking'
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT request_id FROM channel_threads').first('request_id'), 'history')
    assert.equal((await getGuestThreadDetail(db, 'history', ORG))!.guestName, 'Recorded contact')
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 3)
    await db.prepare(`INSERT INTO requests (id, kind, organization_id, location_id, conversation_state, payload_json, created_at, updated_at)
      VALUES ('other', 'stay', ?, 'location', 'needs_attention', ?, ?, ?)`).bind(ORG, JSON.stringify({ guest: { name: 'Other contact', email: 'other@example.test', phone: null } }), NOW, NOW).run()
    await db.prepare("UPDATE stays SET request_id = 'other' WHERE id = ?").bind(stay.id).run()
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('CHANNEL_THREAD_ASSOCIATION_CONFLICT'))
    assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 2)
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 3)
    await db.prepare("DELETE FROM channel_threads").run()
    await db.prepare("UPDATE requests SET payload_json = ? WHERE id = 'other'").bind(JSON.stringify({ participant: { kind: 'channel', title: 'Unmapped' }, guest: { name: null, email: null, phone: null } })).run()
    await assert.rejects(getGuestRequest(db, 'other', ORG), code('CHANNEL_THREAD_MAPPING_INVALID'))
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('replies use actual provider receipts once; an uncertain write remains visible and cannot be blindly resent', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  let releaseRetry: (() => void) | undefined
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    const membership = await resolveMembership(env, { organizationId: ORG, userId: OWNER })
    assert.ok(membership)
    const principal = memberAccessPrincipal(membership, { env })
    const result = await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(result.status, 'mirrored')
    if (result.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    const input = { threadId: result.request_id, organizationId: ORG, action: 'reply', body: 'Welcome', idempotencyKey: 'accepted', actorUserId: OWNER, env }
    assert.equal((await executeGuestThreadOperation(db, input)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, input)).ok, true)
    assert.equal(provider.sends, 1)
    assert.deepEqual(await db.prepare("SELECT channel, provider, status, provider_message_id, non_delivery_confirmed FROM guest_thread_deliveries").first(), { channel: 'airbnb', provider: 'channex', status: 'accepted', provider_message_id: 'accepted-1', non_delivery_confirmed: 0 })
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 4)
    assert.equal((await getGuestThreadDetail(db, result.request_id, ORG))!.entries.length, 3)
    provider.uncertain = true
    const uncertain = { ...input, body: 'Second reply', idempotencyKey: 'uncertain' }
    const failed = await executeGuestThreadOperation(db, uncertain)
    assert.equal(failed.ok, false)
    if (failed.ok || failed.reason !== 'delivery_failed') throw new Error('Expected an explicit recorded delivery failure')
    assert.deepEqual([failed.status, failed.code, failed.field, failed.mutation_applied, failed.retry_with_same_idempotency_key], [502, 'CHANNEL_REPLY_UNCERTAIN', 'delivery.status', true, false])
    const retry = await executeGuestThreadOperation(db, uncertain)
    assert.equal(retry.ok, false)
    if (retry.ok || retry.reason !== 'delivery_failed') throw new Error('Expected explicit review-required result')
    assert.equal(retry.code, 'CHANNEL_REPLY_REVIEW_REQUIRED')
    assert.equal(provider.sends, 2)
    const detail = (await getGuestThreadDetail(db, result.request_id, ORG))!
    assert.equal(detail.deliveryFailures.length, 1)
    assert.equal(detail.deliveryFailures[0]!.status, 'uncertain')
    assert.deepEqual(await db.prepare(`SELECT d.status, d.non_delivery_confirmed FROM guest_thread_deliveries d
      JOIN activity_entries a ON a.id = d.entry_id WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${result.request_id}:uncertain`).first(),
      { status: 'uncertain', non_delivery_confirmed: 0 })
    await assert.rejects(executeGuestThreadOperation(db, { ...input, body: 'Changed text' }), code('IDEMPOTENCY_CONFLICT'))
    await assert.rejects(executeGuestThreadOperation(db, { ...input, photos: [{ filename: 'file', bytes: new Uint8Array([1]) }] }), code('CHANNEL_PHOTO_MESSAGE_INVALID'))

    provider.uncertain = false
    provider.refuseMessage = true
    const refusedInput = { ...input, body: 'Recovered host reply', idempotencyKey: 'certain-refusal' }
    const refused = await executeGuestThreadOperation(db, refusedInput)
    if (refused.ok || refused.reason !== 'delivery_failed') throw new Error('Expected a definite recorded refusal')
    assert.deepEqual([refused.code, refused.retry_with_same_idempotency_key], ['CHANNEL_REPLY_FAILED', true])
    const refusedEntry = await db.prepare('SELECT id, payload_json FROM activity_entries WHERE dedupe_key = ?').bind(`guest-thread-operation:${result.request_id}:certain-refusal`).first<{ id: string; payload_json: string }>()
    assert.ok(refusedEntry)
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, non_delivery_confirmed FROM guest_thread_deliveries WHERE entry_id = ?').bind(refusedEntry.id).first(),
      { status: 'failed', provider_message_id: null, non_delivery_confirmed: 1 })
    const refusedProgress = (await listBusinessOutcomes(db, principal, { limit: 100 })).outcomes.find(outcome => outcome.id === refusedEntry.id)
    assert.deepEqual(refusedProgress?.verification, { status: 'failed', basis: 'provider_acceptance', receipts: [{
      id: `guest-thread-channex:${result.request_id}:certain-refusal`, channel: 'airbnb', provider: 'channex', status: 'failed', providerMessageId: null, nonDeliveryConfirmed: true,
    }] })
    provider.refuseMessage = false
    const started = new Promise<void>(resolve => { provider.onSend = resolve })
    provider.holdReply = new Promise<void>(resolve => { releaseRetry = resolve })
    const recovering = Promise.all([executeGuestThreadOperation(db, refusedInput), executeGuestThreadOperation(db, refusedInput)])
    await started
    assert.deepEqual(await db.prepare('SELECT status, error, non_delivery_confirmed FROM guest_thread_deliveries WHERE entry_id = ?').bind(refusedEntry.id).first(),
      { status: 'sending', error: null, non_delivery_confirmed: null }, 'claiming the retry atomically clears the previous attempt’s non-delivery proof')
    const sendingProgress = (await listBusinessOutcomes(db, principal, { limit: 100 })).outcomes.find(outcome => outcome.id === refusedEntry.id)
    assert.deepEqual([sendingProgress?.verification.status, sendingProgress?.verification.receipts.map(receipt => [receipt.status, receipt.nonDeliveryConfirmed])],
      ['unconfirmed', [['sending', null]]])
    releaseRetry!()
    const recovered = await recovering
    provider.holdReply = undefined
    provider.onSend = undefined
    assert.ok(recovered.some(outcome => outcome.ok))
    for (const outcome of recovered) {
      if (outcome.ok) continue
      if (outcome.reason !== 'delivery_failed') throw new Error(`Unexpected concurrent retry result: ${outcome.reason}`)
      assert.deepEqual([outcome.status, outcome.code], [409, 'CHANNEL_REPLY_REVIEW_REQUIRED'])
    }
    assert.equal(provider.sends, 4, 'the refused text retry sends once, including concurrent retries')
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual((await getGuestThreadDetail(db, result.request_id, ORG))!.entries.filter(entry => entry.id === refusedEntry.id).map(entry => entry.body), [refusedInput.body])
    assert.deepEqual(await db.prepare(`SELECT d.status, d.provider_message_id, d.error, d.non_delivery_confirmed FROM guest_thread_deliveries d
      JOIN activity_entries a ON a.id = d.entry_id WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${result.request_id}:certain-refusal`).first(),
      { status: 'accepted', provider_message_id: 'accepted-4', error: null, non_delivery_confirmed: 0 })
    const recoveredProgress = (await listBusinessOutcomes(db, principal, { limit: 100 })).outcomes.find(outcome => outcome.id === refusedEntry.id)
    assert.deepEqual([recoveredProgress?.verification.status, recoveredProgress?.verification.receipts.map(receipt => [receipt.status, receipt.providerMessageId, receipt.nonDeliveryConfirmed])],
      ['verified', [['accepted', 'accepted-4', false]]])

    // A Channex 422 carrying an upstream Airbnb 500 does not prove refusal.
    provider.airbnbUnavailable = true
    const upstreamInput = { ...input, body: 'Reply with an upstream unknown outcome', idempotencyKey: 'upstream-unknown' }
    const upstream = await executeGuestThreadOperation(db, upstreamInput)
    if (upstream.ok || upstream.reason !== 'delivery_failed') throw new Error('Expected an uncertain upstream write')
    assert.deepEqual([upstream.code, upstream.retry_with_same_idempotency_key, upstream.provider_error?.code, upstream.provider_error?.uncertain], ['CHANNEL_REPLY_UNCERTAIN', false, 'AIRBNB_UNAVAILABLE', true])
    const upstreamRetry = await executeGuestThreadOperation(db, upstreamInput)
    if (upstreamRetry.ok || upstreamRetry.reason !== 'delivery_failed') throw new Error('Expected an unknown write to require review')
    assert.deepEqual([upstreamRetry.status, upstreamRetry.code, upstreamRetry.retry_with_same_idempotency_key], [409, 'CHANNEL_REPLY_REVIEW_REQUIRED', false])
    assert.equal(provider.sends, 5)
    assert.deepEqual(await db.prepare(`SELECT d.status, d.provider_message_id, d.non_delivery_confirmed FROM guest_thread_deliveries d
      JOIN activity_entries a ON a.id = d.entry_id WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${result.request_id}:upstream-unknown`).first(),
      { status: 'uncertain', provider_message_id: null, non_delivery_confirmed: 0 })

    // An old writer can still persist a failed status after this additive
    // migration. Its omitted proof is unknown, even if the error says refused.
    const oldInput = { ...refusedInput, idempotencyKey: 'old-writer' }
    const oldEntry = await appendEntry(db, { threadId: result.request_id, kind: 'message', actorKind: 'member', actorUserId: OWNER,
      body: oldInput.body, channel: 'airbnb', eventName: 'thread.member_reply', payloadJson: JSON.parse(refusedEntry.payload_json),
      dedupeKey: `guest-thread-operation:${result.request_id}:old-writer` })
    const oldReceipt = await createDeliveryReceipt(db, { entryId: oldEntry.id, channel: 'airbnb', provider: 'channex', purpose: 'member_reply',
      idempotencyKey: `guest-thread-channex:${result.request_id}:old-writer` })
    await db.prepare("UPDATE guest_thread_deliveries SET status = 'failed', error = 'Channex refused the reply' WHERE id = ?").bind(oldReceipt.id).run()
    assert.deepEqual(await db.prepare('SELECT status, non_delivery_confirmed FROM guest_thread_deliveries WHERE id = ?').bind(oldReceipt.id).first(),
      { status: 'failed', non_delivery_confirmed: null })
    for (const proof of [null, 0]) {
      await db.prepare('UPDATE guest_thread_deliveries SET non_delivery_confirmed = ? WHERE id = ?').bind(proof, oldReceipt.id).run()
      const blocked = await executeGuestThreadOperation(db, oldInput)
      if (blocked.ok || blocked.reason !== 'delivery_failed') throw new Error('Expected failed receipts without proven non-delivery to require review')
      assert.deepEqual([blocked.status, blocked.code, blocked.retry_with_same_idempotency_key], [409, 'CHANNEL_REPLY_REVIEW_REQUIRED', false])
      assert.deepEqual(await db.prepare('SELECT status, non_delivery_confirmed FROM guest_thread_deliveries WHERE id = ?').bind(oldReceipt.id).first(),
        { status: 'failed', non_delivery_confirmed: proof })
      const oldProgress = (await listBusinessOutcomes(db, principal, { limit: 100 })).outcomes.find(outcome => outcome.id === oldEntry.id)
      assert.deepEqual([oldProgress?.verification.status, oldProgress?.verification.receipts.map(receipt => [receipt.status, receipt.nonDeliveryConfirmed])],
        ['unconfirmed', [['failed', proof === null ? null : false]]])
    }
    assert.equal(provider.sends, 5, 'neither an old-writer null nor explicit negative proof permits another provider call')
  } finally { releaseRetry?.(); globalThis.fetch = realFetch; await runtime.dispose() }
})

test('photo replies retain their canonical media, replay without expired source resolution and dedupe only accepted provider identities', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    const mirrored = await mirrorChannexThread(db, env, 'thread', 'property')
    if (mirrored.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    const bytes = Uint8Array.from(await sharp({ create: { width: 12, height: 8, channels: 3, background: '#2563eb' } }).avif().toBuffer())
    const photo = { filename: 'entry.avif', bytes }
    let resolutions = 0
    const input = { threadId: mirrored.request_id, organizationId: ORG, action: 'reply', body: '', idempotencyKey: 'photo', actorUserId: OWNER, env,
      photos: { sourceIds: ['host-photo-id'], resolve: async () => { resolutions += 1; return [photo] } } }
    await assert.rejects(executeGuestThreadOperation(db, { ...input, body: 'Text would discard this photo' }), code('CHANNEL_PHOTO_MESSAGE_INVALID'))
    await assert.rejects(executeGuestThreadOperation(db, { ...input, photos: [photo, photo] }), code('CHANNEL_PHOTO_MESSAGE_INVALID'))
    const invalid = await executeGuestThreadOperation(db, { ...input, photos: [{ filename: 'document.svg', bytes: new TextEncoder().encode('<svg/>') }] })
    assert.deepEqual(invalid, { ok: false, status: 400, reason: 'invalid_photo', message: 'document.svg is not a JPEG, PNG, WebP, GIF or AVIF photo.' })
    assert.equal(provider.sends, 0)
    assert.equal(provider.uploads.length, 0)
    assert.equal(await db.prepare('SELECT count(*) FROM guest_thread_deliveries').first('count(*)'), 0)

    assert.equal((await executeGuestThreadOperation(db, input)).ok, true)
    assert.deepEqual(provider.uploads, [{ file: Buffer.from(bytes).toString('base64'), file_name: 'entry.avif', file_type: 'image/avif' }])
    const asset = await db.prepare(`SELECT ma.id, ma.r2_key, ma.public_url FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id
      JOIN activity_entries a ON a.id = mp.owner_id WHERE mp.owner_type = 'activity_entry' AND mp.status = 'active' AND a.request_id = ? AND a.event_name = 'thread.member_reply'`).bind(mirrored.request_id).first<{ id: string; r2_key: string; public_url: string }>()
    assert.ok(asset)
    const saved = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(asset.r2_key)
    assert.ok(saved)
    assert.deepEqual(new Uint8Array(await saved.arrayBuffer()), bytes, 'the canonical media store retained the actual uploaded image')
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, non_delivery_confirmed FROM guest_thread_deliveries').first(), { status: 'accepted', provider_message_id: 'accepted-1', non_delivery_confirmed: 0 })
    await mirrorChannexThread(db, env, 'thread', 'property')
    const detail = (await getGuestThreadDetail(db, mirrored.request_id, ORG))!
    assert.equal(detail.entries.length, 3, 'the receipt suppresses only its exact provider echo')
    assert.deepEqual(detail.entries[2]!.attachments.map(item => [item.id, item.url]), [[asset.id, asset.public_url]])
    assert.equal(detail.entries[2]!.body, '')
    const replay = { ...input, photos: { sourceIds: ['host-photo-id'], resolve: async () => { throw new Error('Host download has expired') } } }
    assert.equal((await executeGuestThreadOperation(db, replay)).ok, true)
    assert.deepEqual([resolutions, provider.sends, provider.uploads.length], [1, 1, 1])
    await assert.rejects(executeGuestThreadOperation(db, { ...replay, photos: { ...replay.photos, sourceIds: ['different-photo-id'] } }), code('IDEMPOTENCY_CONFLICT'))

    provider.uncertain = true
    const uncertainInput = { ...input, idempotencyKey: 'uncertain-photo' }
    const uncertain = await executeGuestThreadOperation(db, uncertainInput)
    if (uncertain.ok || uncertain.reason !== 'delivery_failed') throw new Error('Expected an explicit recorded delivery failure')
    assert.equal(uncertain.code, 'CHANNEL_REPLY_UNCERTAIN')
    const retry = await executeGuestThreadOperation(db, uncertainInput)
    if (retry.ok || retry.reason !== 'delivery_failed') throw new Error('Expected explicit review-required result')
    assert.equal(retry.code, 'CHANNEL_REPLY_REVIEW_REQUIRED')
    assert.deepEqual([resolutions, provider.sends, provider.uploads.length], [2, 2, 2])
    await mirrorChannexThread(db, env, 'thread', 'property')
    const afterUncertain = (await getGuestThreadDetail(db, mirrored.request_id, ORG))!
    assert.equal(afterUncertain.entries.length, 5, 'an unknown provider identity preserves both the attempted photo and actual resource')
    assert.equal(afterUncertain.deliveryFailures[0]!.status, 'uncertain')
    assert.equal(await db.prepare('SELECT count(*) FROM media_assets').first('count(*)'), 2)

    provider.uncertain = false
    const simultaneous = { ...input, idempotencyKey: 'simultaneous-photo' }
    const raced = await Promise.all([executeGuestThreadOperation(db, simultaneous), executeGuestThreadOperation(db, simultaneous)])
    assert.ok(raced.some(outcome => outcome.ok), 'one concurrent request completes the actual send')
    for (const outcome of raced) {
      if (outcome.ok) continue
      if (outcome.reason !== 'delivery_failed') throw new Error(`Unexpected concurrent reply result: ${outcome.reason}`)
      assert.deepEqual([outcome.status, outcome.code], [409, 'CHANNEL_REPLY_REVIEW_REQUIRED'])
    }
    assert.deepEqual([provider.sends, provider.uploads.length], [3, 3], 'the same concurrent photo intent delivers once')
    assert.deepEqual(await db.prepare(`SELECT d.status, d.provider_message_id, COUNT(mp.asset_id) AS photos FROM guest_thread_deliveries d
      JOIN activity_entries a ON a.id = d.entry_id LEFT JOIN media_placements mp ON mp.owner_type = 'activity_entry' AND mp.owner_id = a.id AND mp.status = 'active'
      WHERE a.dedupe_key = ? GROUP BY d.id`).bind(`guest-thread-operation:${mirrored.request_id}:simultaneous-photo`).first(),
    { status: 'accepted', provider_message_id: 'accepted-3', photos: 1 })
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 3, 'the losing request retains no active orphan media asset')
    assert.equal((await (await runtime.getR2Bucket('MEDIA_BUCKET')).list({ prefix: `organizations/${ORG}/media/` })).objects.length, 3, 'only the three retained photos remain stored')
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_type = 'activity_entry'").first('count(*)'), 3)
    assert.equal((await getGuestThreadDetail(db, mirrored.request_id, ORG))!.entries.filter(entry => entry.eventName === 'thread.member_reply').length, 3)

    provider.refuseAttachment = true
    const refusedInput = { ...input, idempotencyKey: 'refused-photo-upload' }
    const refused = await executeGuestThreadOperation(db, refusedInput)
    if (refused.ok || refused.reason !== 'delivery_failed') throw new Error('Expected a recorded attachment preparation failure')
    assert.deepEqual([refused.status, refused.code, refused.retry_with_same_idempotency_key], [502, 'CHANNEL_REPLY_FAILED', true])
    assert.equal(refused.provider_error?.uncertain, false)
    assert.deepEqual([provider.sends, provider.uploads.length], [3, 4], 'a refused upload never calls the guest message endpoint')
    const refusedReceipt = await db.prepare(`SELECT d.status, d.provider_message_id, d.error, d.non_delivery_confirmed, a.id FROM guest_thread_deliveries d
      JOIN activity_entries a ON a.id = d.entry_id WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${mirrored.request_id}:refused-photo-upload`)
      .first<{ status: string; provider_message_id: string | null; error: string; non_delivery_confirmed: number; id: string }>()
    assert.ok(refusedReceipt)
    assert.deepEqual([refusedReceipt.status, refusedReceipt.provider_message_id, refusedReceipt.non_delivery_confirmed], ['failed', null, 1])
    assert.match(refusedReceipt.error, /no guest message was sent/)
    const refusalDetail = (await getGuestThreadDetail(db, mirrored.request_id, ORG))!
    assert.equal(refusalDetail.entries.find(entry => entry.id === refusedReceipt.id)!.attachments.length, 1, 'the failed send retains the chosen photo for review')
    assert.equal(refusalDetail.deliveryFailures.find(delivery => delivery.status === 'failed')?.error, refusedReceipt.error)
    // A failed upload proves no guest message was sent; the same intent can recover.
    const refusedPhoto = refusalDetail.entries.find(entry => entry.id === refusedReceipt.id)!
    const retainedPhoto = await db.prepare(`SELECT ma.id, ma.r2_key, mp.id AS placement_id FROM media_assets ma
      JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id
      WHERE mp.owner_type = 'activity_entry' AND mp.owner_id = ? AND mp.slot = 'attachments' AND mp.status = 'active' AND ma.status = 'active'`)
      .bind(refusedReceipt.id).first<{ id: string; r2_key: string; placement_id: string }>()
    assert.ok(retainedPhoto)
    const photoBucket = await runtime.getR2Bucket('MEDIA_BUCKET')
    const beforeRecoveryResolutions = resolutions
    const expiredRefused = { ...refusedInput, photos: { sourceIds: ['host-photo-id'], resolve: async () => { throw new Error('Host download has expired') } } }
    await db.prepare("UPDATE media_placements SET status = 'deleted' WHERE id = ?").bind(retainedPhoto.placement_id).run()
    await assert.rejects(executeGuestThreadOperation(db, expiredRefused), code('CHANNEL_REPLY_PHOTO_UNAVAILABLE'))
    await db.prepare("UPDATE media_placements SET status = 'active' WHERE id = ?").bind(retainedPhoto.placement_id).run()
    await photoBucket.delete(retainedPhoto.r2_key)
    await assert.rejects(executeGuestThreadOperation(db, expiredRefused), code('CHANNEL_REPLY_PHOTO_UNAVAILABLE'))
    await photoBucket.put(retainedPhoto.r2_key, new Uint8Array(bytes.byteLength))
    await assert.rejects(executeGuestThreadOperation(db, expiredRefused), code('CHANNEL_REPLY_PHOTO_UNAVAILABLE'))
    await photoBucket.put(retainedPhoto.r2_key, bytes, { httpMetadata: { contentType: 'image/avif' } })
    assert.deepEqual([provider.sends, provider.uploads.length], [3, 4], 'missing or invalid retained media never reaches the provider or caller resolver')
    assert.deepEqual(await db.prepare('SELECT status, non_delivery_confirmed FROM guest_thread_deliveries WHERE entry_id = ?').bind(refusedReceipt.id).first(),
      { status: 'failed', non_delivery_confirmed: 1 }, 'media validation happens before the retry claim')
    provider.refuseAttachment = false
    const recovered = await Promise.all([executeGuestThreadOperation(db, expiredRefused), executeGuestThreadOperation(db, expiredRefused)])
    assert.ok(recovered.some(outcome => outcome.ok))
    for (const outcome of recovered) {
      if (outcome.ok) continue
      if (outcome.reason !== 'delivery_failed') throw new Error(`Unexpected concurrent photo retry result: ${outcome.reason}`)
      assert.deepEqual([outcome.status, outcome.code], [409, 'CHANNEL_REPLY_REVIEW_REQUIRED'])
    }
    assert.deepEqual([provider.sends, provider.uploads.length], [4, 5], 'concurrent retries of the proven non-delivery send one photo')
    assert.equal(resolutions, beforeRecoveryResolutions, 'matching retries never re-resolve the expired host source')
    assert.deepEqual(provider.uploads[4], provider.uploads[3], 'the retry sends the same stored photo bytes and filename')
    const recoveredDetail = (await getGuestThreadDetail(db, mirrored.request_id, ORG))!
    assert.deepEqual(recoveredDetail.entries.filter(entry => entry.id === refusedReceipt.id).map(entry => entry.attachments), [refusedPhoto.attachments])
    assert.deepEqual(await db.prepare(`SELECT ma.id, ma.r2_key, mp.id AS placement_id FROM media_assets ma
      JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id
      WHERE mp.owner_type = 'activity_entry' AND mp.owner_id = ? AND mp.slot = 'attachments' AND mp.status = 'active' AND ma.status = 'active'`)
      .bind(refusedReceipt.id).first(), retainedPhoto)
    const recoveredBytes = await photoBucket.get(retainedPhoto.r2_key)
    assert.ok(recoveredBytes)
    assert.deepEqual(new Uint8Array(await recoveredBytes.arrayBuffer()), bytes)
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, error, non_delivery_confirmed FROM guest_thread_deliveries WHERE entry_id = ?').bind(refusedReceipt.id).first(),
      { status: 'accepted', provider_message_id: 'accepted-4', error: null, non_delivery_confirmed: 0 })
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 4, 'retry reuses the retained photo')

    provider.attachmentNetworkFailure = true
    const networkInput = { ...input, idempotencyKey: 'interrupted-photo-upload' }
    const interrupted = await executeGuestThreadOperation(db, networkInput)
    if (interrupted.ok || interrupted.reason !== 'delivery_failed') throw new Error('Expected a failed attachment preparation')
    assert.deepEqual([interrupted.code, interrupted.retry_with_same_idempotency_key, interrupted.provider_error?.uncertain], ['CHANNEL_REPLY_FAILED', true, false])
    assert.deepEqual([provider.sends, provider.uploads.length], [4, 6], 'an upload network error precedes every guest message call')
    const retained = await db.prepare(`SELECT a.id, ma.id AS asset_id, ma.r2_key, ma.public_url FROM activity_entries a
      JOIN media_placements mp ON mp.owner_type = 'activity_entry' AND mp.owner_id = a.id AND mp.status = 'active'
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
      WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${mirrored.request_id}:interrupted-photo-upload`)
      .first<{ id: string; asset_id: string; r2_key: string; public_url: string }>()
    assert.ok(retained)
    const retainedBytes = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(retained.r2_key)
    assert.ok(retainedBytes)
    assert.deepEqual(new Uint8Array(await retainedBytes.arrayBuffer()), bytes)
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, non_delivery_confirmed FROM guest_thread_deliveries WHERE entry_id = ?').bind(retained.id).first(),
      { status: 'failed', provider_message_id: null, non_delivery_confirmed: 1 }, 'an interrupted upload still proves the guest-message endpoint was never called')
    provider.attachmentNetworkFailure = false
    assert.equal((await executeGuestThreadOperation(db, networkInput)).ok, true)
    assert.deepEqual([provider.sends, provider.uploads.length], [5, 7])
    assert.deepEqual((await getGuestThreadDetail(db, mirrored.request_id, ORG))!.entries.filter(entry => entry.id === retained.id).map(entry => entry.attachments.map(photo => [photo.id, photo.url])),
      [[[retained.asset_id, retained.public_url]]])
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, error, non_delivery_confirmed FROM guest_thread_deliveries WHERE entry_id = ?').bind(retained.id).first(),
      { status: 'accepted', provider_message_id: 'accepted-5', error: null, non_delivery_confirmed: 0 })
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE dedupe_key = ?').bind(`guest-thread-operation:${mirrored.request_id}:interrupted-photo-upload`).first('count(*)'), 1)
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 5)
    assert.equal((await executeGuestThreadOperation(db, networkInput)).ok, true)
    assert.deepEqual([provider.sends, provider.uploads.length], [5, 7], 'a successful receipt still prevents all repeat sends')

    // JPEG/PNG photos keep their configured Cloudflare Images owner. Its
    // authenticated stored-blob API also permits recovery after host expiry.
    const imageBytes = Uint8Array.from(await sharp({ create: { width: 12, height: 8, channels: 3, background: '#2563eb' } }).png().toBuffer())
    let imageResolutions = 0
    const imageInput = { ...input, idempotencyKey: 'images-photo', env: { ...env, CF_ACCOUNT_ID: 'account-proof', CLOUDFLARE_IMAGES_API_TOKEN: 'test-images-key', CLOUDFLARE_IMAGES_VARIANT_BASE: 'https://imagedelivery.net/proof' },
      photos: { sourceIds: ['host-png-id'], resolve: async () => { imageResolutions += 1; return [{ filename: 'entry.png', bytes: imageBytes }] } } }
    provider.refuseAttachment = true
    const imageRefused = await executeGuestThreadOperation(db, imageInput)
    if (imageRefused.ok || imageRefused.reason !== 'delivery_failed') throw new Error('Expected a failed photo preparation')
    assert.deepEqual([imageRefused.code, imageRefused.retry_with_same_idempotency_key], ['CHANNEL_REPLY_FAILED', true])
    const imageAsset = await db.prepare(`SELECT a.id AS entry_id, ma.id, ma.provider, ma.cloudflare_image_id, ma.r2_key, mp.id AS placement_id FROM activity_entries a
      JOIN media_placements mp ON mp.owner_type = 'activity_entry' AND mp.owner_id = a.id AND mp.status = 'active'
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
      WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${mirrored.request_id}:images-photo`)
      .first<{ entry_id: string; id: string; provider: string; cloudflare_image_id: string; r2_key: null; placement_id: string }>()
    assert.ok(imageAsset)
    assert.deepEqual([imageAsset.provider, imageAsset.r2_key, provider.images.size, provider.imageReads, imageResolutions], ['cloudflare_images', null, 1, 1, 1])
    assert.deepEqual(provider.images.get(imageAsset.cloudflare_image_id), imageBytes)
    const expiredImage = { ...imageInput, photos: { sourceIds: ['host-png-id'], resolve: async () => { throw new Error('Host PNG download has expired') } } }
    provider.refuseAttachment = false
    provider.refuseImageRead = true
    const beforeMissingImage = await db.prepare('SELECT * FROM guest_thread_deliveries WHERE entry_id = ?').bind(imageAsset.entry_id).first()
    await assert.rejects(executeGuestThreadOperation(db, expiredImage), { status: 409, data: { code: 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', field: 'photos' } })
    assert.deepEqual(await db.prepare('SELECT * FROM guest_thread_deliveries WHERE entry_id = ?').bind(imageAsset.entry_id).first(), beforeMissingImage, 'a missing stored image neither claims nor changes the recorded attempt')
    assert.deepEqual([provider.sends, provider.uploads.length], [5, 8], 'a missing stored Images blob is visible before guest dispatch')
    provider.refuseImageRead = false
    assert.equal((await executeGuestThreadOperation(db, expiredImage)).ok, true)
    assert.deepEqual([provider.sends, provider.uploads.length, provider.images.size, provider.imageReads, imageResolutions], [6, 9, 1, 3, 1])
    assert.deepEqual(provider.uploads[8], { file: Buffer.from(imageBytes).toString('base64'), file_name: 'entry.png', file_type: 'image/png' })
    const imageDetail = (await getGuestThreadDetail(db, mirrored.request_id, ORG))!
    assert.deepEqual(imageDetail.entries.find(entry => entry.id === imageAsset.entry_id)!.attachments.map(photo => photo.id), [imageAsset.id])
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, non_delivery_confirmed FROM guest_thread_deliveries WHERE entry_id = ?').bind(imageAsset.entry_id).first(),
      { status: 'accepted', provider_message_id: 'accepted-6', non_delivery_confirmed: 0 })
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('an in-flight or interrupted reply never blocks actual provider messages and only a known receipt ID dedupes its presentation', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  let release!: () => void
  const started = new Promise<void>(resolve => { provider.onSend = resolve })
  provider.holdReply = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    const mirrored = await mirrorChannexThread(db, env, 'thread', 'property')
    if (mirrored.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    const input = { threadId: mirrored.request_id, organizationId: ORG, action: 'reply', body: 'Reply being accepted', idempotencyKey: 'in-flight', actorUserId: OWNER, env }
    const operation = executeGuestThreadOperation(db, input)
    await started
    provider.messages.push(provider.message('host-on-airbnb', 'property', 'A real host message'), provider.message('new-guest', 'guest', 'Another guest message'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await db.prepare('SELECT status, non_delivery_confirmed FROM guest_thread_deliveries').first(), { status: 'sending', non_delivery_confirmed: null })
    const pending = (await getGuestThreadDetail(db, mirrored.request_id, ORG))!
    assert.equal(pending.entries.length, 6)
    assert.equal(pending.entries.filter(entry => entry.body === input.body).length, 2, 'unknown identity preserves the attempt and the actual resource')
    const retry = await executeGuestThreadOperation(db, input)
    assert.equal(retry.ok, false)
    if (retry.ok || retry.reason !== 'delivery_failed') throw new Error('Expected unconfirmed replay to require review')
    assert.equal(retry.code, 'CHANNEL_REPLY_REVIEW_REQUIRED')
    assert.equal(provider.sends, 1)
    release()
    assert.equal((await operation).ok, true)
    const accepted = (await getGuestThreadDetail(db, mirrored.request_id, ORG))!
    assert.equal(accepted.entries.length, 5)
    assert.equal(accepted.entries.filter(entry => entry.body === input.body).length, 1)
    assert(accepted.entries.some(entry => entry.body === 'A real host message'))
    assert(accepted.entries.some(entry => entry.body === 'Another guest message'))
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 6, 'presentation never deletes either immutable fact')
    await db.prepare("UPDATE product_channel_mappings SET enabled = 0").run()
    assert.equal((await executeGuestThreadOperation(db, input)).ok, true, 'an actual recorded receipt replays without a new provider request')
    await assert.rejects(executeGuestThreadOperation(db, { ...input, idempotencyKey: 'disconnected-new', body: 'Not attempted' }), code('CHANNEL_PROPERTY_NOT_READY'))
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 6, 'failed preflight records no outbound message')
  } finally { release(); globalThis.fetch = realFetch; await runtime.dispose() }
})
