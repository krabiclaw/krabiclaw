import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
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
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { guestThreadListPage, parseGuestThreadListQuery } from '../../server/utils/dashboard-guest-threads.ts'
import { assertAssignedBookingAccess, memberAccessPrincipal } from '../../server/utils/member-access.ts'

const ORG = 'org', OWNER = 'owner'
const NOW = '2026-10-16T00:00:00.000Z'
const RAW = '2026-10-15T23:12:00.123456'
const code = (expected: string) => (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected

class Provider {
  bookingId: string | null = null
  propertyId = 'property'
  empty = false
  uncertain = false
  sends = 0
  onSend?: () => void
  holdReply?: Promise<void>
  messages = [this.message('first', 'guest', 'Hello'), this.message('second', 'system', null, ['/attachment/file'])]

  thread() {
    return { id: 'thread', type: 'message_thread', attributes: { title: 'Conversation supplied by Airbnb', provider: 'AirBNB', is_closed: false, message_count: this.messages.length, inserted_at: RAW, updated_at: RAW },
      relationships: { property: { data: { type: 'property', id: this.propertyId } }, channel: { data: { type: 'channel', id: 'channel' } }, booking: { data: this.bookingId === null ? null : { type: 'booking', id: this.bookingId } } } }
  }

  message(id: string, sender: string, text: string | null, attachments: string[] = []) {
    return { id, type: 'message', attributes: { sender, message: text, attachments, inserted_at: RAW, updated_at: RAW, meta: sender === 'system' ? { inquiry: true } : null },
      relationships: { message_thread: { data: { type: 'message_thread', id: 'thread' } } } }
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init.method ?? 'GET'
    const json = (body: unknown) => Response.json(body)
    if (method === 'GET' && url.pathname === '/api/v1/message_threads') return json({ data: this.empty ? [] : [this.thread()], meta: { total: this.empty ? 0 : 1 } })
    if (method === 'GET' && url.pathname === '/api/v1/message_threads/thread') return json({ data: this.thread() })
    if (method === 'GET' && url.pathname === '/api/v1/message_threads/thread/messages') {
      assert.equal(url.searchParams.get('order[inserted_at]'), 'asc')
      return json({ data: this.messages, meta: { total: this.messages.length } })
    }
    if (method === 'POST' && url.pathname === '/api/v1/message_threads/thread/messages') {
      this.sends += 1
      const body = JSON.parse(String(init.body)) as { message: { message: string } }
      const sent = this.message(`accepted-${this.sends}`, 'property', body.message.message)
      this.messages.push(sent)
      this.onSend?.()
      if (this.holdReply) await this.holdReply
      if (this.uncertain) throw new TypeError('The connection ended after the provider accepted the write')
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
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'channel-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('owner-member', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('location', ?, 'cabin', 'Cabin', 'active', 'America/Denver', ?, ?)`).bind(ORG, NOW, NOW).run()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'test-provider-key', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests' } as CloudflareEnv
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
  const { runtime, db, env } = await boot()
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
    assert.deepEqual([rows[0]!.guestName, rows[0]!.participantLabel, rows[0]!.replyChannel, rows[0]!.mailbox], [null, 'Conversation supplied by Airbnb', 'airbnb', 'current'])
    const detail = (await getGuestThreadDetail(db, rows[0]!.id, ORG))!
    assert.deepEqual([detail.operationalRecord, detail.guestEmail, detail.guestPhone], [null, null, null])
    assert.deepEqual(detail.entries.map(entry => [entry.body, entry.actorKind, entry.providerTimestamp]), [['Hello', 'guest', RAW], [null, 'system', RAW]])
    assert.equal(detail.entries[1]!.attachments[0]!.url, 'https://channex.test/attachment/file')
    assert.notEqual(detail.entries[0]!.occurredAt, RAW)
    const principal = (userId: string) => memberAccessPrincipal({ userId, organizationId: ORG, role: 'member' }, { env })
    await assertAssignedBookingAccess(db, { ...principal(OWNER), requestId: rows[0]!.id })
    await assert.rejects(assertAssignedBookingAccess(db, { ...principal('unassigned-user'), requestId: rows[0]!.id }), code('THREAD_NOT_FOUND'))
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
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    const result = await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(result.status, 'mirrored')
    if (result.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    const input = { threadId: result.request_id, organizationId: ORG, action: 'reply', body: 'Welcome', idempotencyKey: 'accepted', actorUserId: OWNER, env }
    assert.equal((await executeGuestThreadOperation(db, input)).ok, true)
    assert.equal((await executeGuestThreadOperation(db, input)).ok, true)
    assert.equal(provider.sends, 1)
    assert.deepEqual(await db.prepare("SELECT channel, provider, status, provider_message_id FROM guest_thread_deliveries").first(), { channel: 'airbnb', provider: 'channex', status: 'accepted', provider_message_id: 'accepted-1' })
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
    await assert.rejects(executeGuestThreadOperation(db, { ...input, body: 'Changed text' }), code('IDEMPOTENCY_CONFLICT'))
    await assert.rejects(executeGuestThreadOperation(db, { ...input, photos: [{ filename: 'file', bytes: new Uint8Array([1]) }] }), code('CHANNEL_ATTACHMENTS_UNSUPPORTED'))
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
    assert.equal(await db.prepare('SELECT status FROM guest_thread_deliveries').first('status'), 'sending')
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
