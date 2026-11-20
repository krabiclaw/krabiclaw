import { PLATFORM_MESSAGE_AUTHOR_KIND } from '../../shared/messages-contract.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import sharp from 'sharp'
import { captureEvents } from './support/events.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, type ChannelBooking } from '../../server/domain/stays.ts'
import { backfillChannexMessages, mirrorChannexMessageEvent, mirrorChannexThread } from '../../server/domain/guest-threads/channel-messages.ts'
import { sendGuestThreadReply, sendScheduledGuestReply } from '../../server/domain/guest-threads/operations.ts'
import { conversationPageFor } from './support/conversation-page.ts'
import { listConversations } from '../../server/domain/guest-threads/repository.ts'
import { appendMessage, assertConversationAccess, type MessageRow } from '../../server/domain/conversations.ts'
import { setListingAccess } from '../../server/domain/conversation-participants.ts'
import { createDeliveryReceipt, listThreadDeliveries } from '../../server/domain/guest-threads/deliveries.ts'
import { getGuestRequest } from '../../server/domain/requests.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { joinedMemberPrincipal, memberAccessPrincipal } from '../../server/utils/member-access.ts'
import { applySchema } from './support/schema.ts'

const ORG = 'org', OWNER = 'owner'
const hostConversation = (db: D1Database, env: CloudflareEnv, id: string) => conversationPageFor(db, memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env }), id)
const hostMessages = async (db: D1Database, env: CloudflareEnv, id: string) => (await hostConversation(db, env, id)).entries.filter(entry => entry.type === 'message')
const recordedMessages = async (db: D1Database, id: string) => (await db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND organization_id = ? ORDER BY sequence').bind(id, ORG).all<MessageRow>()).results
const NOW = '2026-10-16T00:00:00.000Z'
const RAW = '2026-10-15T23:12:00.123456'
/**
 * A real photo, what a guest's Airbnb attachment is once downloaded. AVIF is the
 * photo type the media store keeps in R2; JPEG and PNG go to Cloudflare Images,
 * which only production configures.
 */
const GUEST_PHOTO = Uint8Array.from(await sharp({ create: { width: 4, height: 3, channels: 3, background: '#16a34a' } }).avif().toBuffer())
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
  replyAt = RAW
  sends = 0
  uploads: Array<{ file: string; file_name: string; file_type: string }> = []
  images = new Map<string, Uint8Array<ArrayBuffer>>()
  imageReads = 0
  refuseImageRead = false
  onSend?: () => void
  holdReply?: Promise<void>
  /** The files Channex serves behind its attachment links, by path: the guest's photo, and each photo uploaded with a reply. */
  files = new Map<string, Uint8Array<ArrayBuffer>>([['/attachment/file', GUEST_PHOTO]])
  fileReads: string[] = []
  messages = [this.message('first', 'guest', 'Hello'), this.message('second', 'system', null, ['/attachment/file'])]

  thread() {
    return { id: this.threadId, type: 'message_thread', attributes: { title: 'Conversation supplied by Airbnb', provider: 'AirBNB', is_closed: false, message_count: this.messages.length, inserted_at: RAW, updated_at: RAW },
      relationships: { property: { data: { type: 'property', id: this.propertyId } }, channel: { data: { type: 'channel', id: 'channel' } }, booking: { data: this.bookingId === null ? null : { type: 'booking', id: this.bookingId } } } }
  }

  message(id: string, sender: string, text: string | null, attachments: string[] = [], at = RAW) {
    return { id, type: 'message', attributes: { sender, message: text, attachments, inserted_at: at, updated_at: at, meta: sender === 'system' ? { inquiry: true } : null },
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
    if (method === 'POST' && ['/api/v1/restrictions', '/api/v1/availability'].includes(url.pathname)) return json({ data: [{ id: crypto.randomUUID(), type: 'task' }], meta: { message: 'Success', warnings: [] } })
    if (method === 'GET' && url.pathname === '/api/v1/message_threads') return json({ data: this.empty ? [] : [this.thread()], meta: { total: this.empty ? 0 : 1 } })
    if (method === 'GET' && url.pathname === `/api/v1/message_threads/${this.threadId}`) return json({ data: this.thread() })
    // Bookings reach Blawby as revisions only; a booking read by id is not answered.
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
      if (!this.refuseAttachment && !this.attachmentNetworkFailure) this.files.set(`/api/v1/attachments/photo-${this.uploads.length}`, Uint8Array.from(Buffer.from(body.attachment.file, 'base64')))
      if (this.refuseAttachment) return Response.json({ errors: { code: 'not_supported', title: 'Attachment refused' } }, { status: 422 })
      if (this.attachmentNetworkFailure) throw new TypeError('The attachment upload connection ended without an answer')
      return json({ data: { id: `photo-${this.uploads.length}`, type: 'attachment' } })
    }
    // An attachment link answers with the file itself once Channex's redirect to its signed download is followed.
    const file = method === 'GET' && url.hostname === 'channex.test' ? this.files.get(url.pathname) : undefined
    if (file) { this.fileReads.push(url.pathname); return new Response(file, { headers: { 'content-type': 'application/octet-stream' } }) }
    if (method === 'POST' && url.pathname === `/api/v1/message_threads/${this.threadId}/messages`) {
      this.sends += 1
      if (this.refuseMessage) return Response.json({ errors: { code: 'not_supported', title: 'Message refused' } }, { status: 422 })
      const body = JSON.parse(String(init.body)) as { message: { message?: string; attachment_id?: string } }
      if (body.message.attachment_id) assert.deepEqual(Object.keys(body.message), ['attachment_id'])
      const sent = this.message(`accepted-${this.sends}`, 'property', body.message.message ?? null, body.message.attachment_id ? [`attachments/${body.message.attachment_id}`] : [], this.replyAt)
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
    env: { DB: { type: 'd1' }, AI: { type: 'ai' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'channel-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await applySchema(db)
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('owner-member', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('location', ?, 'cabin', 'Cabin', 'active', 'America/Denver', ?, ?)`).bind(ORG, NOW, NOW).run()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), EVENTS: captureEvents().binding, MEDIA_BASE_URL: 'https://media.example.test', CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'test-provider-key', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'member-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'location', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'owner-member' },
    } })
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'property', 'room', 'rate', 'complete', 1)`).bind(ORG, home.id).run()
    await db.prepare(`INSERT INTO product_airbnb_listings (organization_id, product_id, listing_id, channel_id, import_stage, enabled)
      VALUES (?, ?, 'listing', 'channel', 'complete', 1)`).bind(ORG, home.id).run()
    return { runtime, db, env, productId: home.id }
  } catch (error) { await runtime.dispose(); throw error }
}

function booking(id = 'booking'): ChannelBooking {
  return { provider: 'channex', external_booking_id: id, channel_booking_id: 'Airbnb-booking', channel: 'airbnb', revision_id: 'revision', provider_updated_at: '2026-10-16T00:00:00Z',
    cancelled: false, check_in_date: '2027-01-01', check_out_date: '2027-01-03', adults: 2, children: 0, infants: 0,
    guest_name: 'Actual', guest_surname: 'Guest', guest_email: null, guest_phone: null, total_minor: 30_000, currency: 'USD' }
}

/** A member reply these tests expect to complete reports nothing; a report fails the test with its error. */

test('empty greenfield collections are valid; inquiries mirror into the canonical inbox without invented guest contact or clock', async () => {
  const { runtime, db, env, productId } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    provider.empty = true
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 0 })
    assert.equal(await db.prepare('SELECT count(*) FROM conversations').first('count(*)'), 0)
    provider.empty = false
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    const rows = await listConversations(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'current' })
    assert.equal(rows.length, 1)
    // An unbooked Airbnb conversation with no guest name reads as the title Airbnb gave it, on the home it was asked about, with no dates invented.
    // The guest's mirrored words are from someone else, so the conversation is unread until the owner opens it.
    assert.deepEqual({ ...rows[0]!, time: undefined }, { id: rows[0]!.id, kind: 'guest', title: 'Conversation supplied by Airbnb', avatar_initial: 'C', channel: 'airbnb', home: 'Cabin', when: null,
      preview: 'Sent a photo', preview_from: 'Airbnb Support', time: undefined, unread: true })
    assert.deepEqual(await listConversations(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'past' }), [])
    assert.equal(await db.prepare('SELECT product_id FROM channel_threads WHERE conversation_id = ?').bind(rows[0]!.id).first('product_id'), productId)
    const thread = (await getGuestRequest(db, rows[0]!.id, ORG))!
    assert(thread.kind === 'booking')
    assert.deepEqual([thread.booking_id, thread.payload.guest.email, thread.payload.guest.phone, thread.payload.guest.name, thread.payload.participant?.title], [null, null, null, null, 'Conversation supplied by Airbnb'])
    const entries = await recordedMessages(db, rows[0]!.id)
    assert.deepEqual(entries.map(entry => [entry.body, entry.author_kind, JSON.parse(entry.payload_json).provider_inserted_at]), [['Hello', 'guest', RAW], [null, PLATFORM_MESSAGE_AUTHOR_KIND, RAW]])
    const detail = await hostConversation(db, env, rows[0]!.id)
    assert(detail.conversation.kind === 'guest')
    assert.deepEqual([detail.conversation.booking_id, detail.conversation.composer, detail.conversation.title], [null, { channel: 'airbnb' }, 'Conversation supplied by Airbnb'])
    const visible = detail.entries.filter(entry => entry.type === 'message')
    // Airbnb's photo is read once when the message lands and kept as the business's own media, placed on that message.
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    const stored = await db.prepare(`SELECT ma.id, ma.r2_key, ma.public_url FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id
      WHERE mp.owner_type = 'message' AND mp.owner_id = ? AND mp.slot = 'attachments' AND mp.status = 'active' AND ma.status = 'active'`).bind(entries[1]!.id).all<{ id: string; r2_key: string; public_url: string }>()
    assert.equal(stored.results.length, 1)
    const photo = stored.results[0]!
    assert.ok(photo.public_url.startsWith('https://media.example.test/'), photo.public_url)
    const kept = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(photo.r2_key)
    assert.ok(kept)
    assert.deepEqual(new Uint8Array(await kept.arrayBuffer()), GUEST_PHOTO)
    assert.deepEqual(visible.find(entry => entry.id === entries[1]!.id)!.photos.map(item => [item.id, item.url]), [[photo.id, photo.public_url]])
    assert.equal(visible.some(entry => entry.photos.some(item => item.url.startsWith('https://channex.test/'))), false, 'no Channex link reaches the conversation')
    assert.notEqual(entries[0]!.occurred_at, RAW)
    assert.equal(await db.prepare('SELECT count(*) FROM bookings').first('count(*)'), 0)
    // The host has a seat from creation. Another member's booking duties cannot grant one.
    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, organizationId: ORG, role }, { env })
    await assertConversationAccess(db, principal(OWNER, 'owner'), rows[0]!.id)
    await assertConversationAccess(db, principal(OWNER, 'member'), rows[0]!.id)
    await assert.rejects(assertConversationAccess(db, principal('unassigned-user', 'member'), rows[0]!.id), code('THREAD_NOT_FOUND'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT count(*) FROM messages').first('count(*)'), 2)
    // Mirrored again, the message finds its photo already placed: nothing is downloaded or stored twice.
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_type = 'message'").first('count(*)'), 1)
    assert.equal(await db.prepare('SELECT count(*) FROM media_assets').first('count(*)'), 1)
    await assert.rejects(mirrorChannexMessageEvent(db, env, { event: 'message', property_id: 'property', payload: { id: 'not-visible-yet', property_id: 'property', message_thread_id: 'thread' } }), code('CHANNEL_MESSAGE_NOT_READY'))
    provider.propertyId = 'another-property'
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('INVALID_PROVIDER_RESPONSE'))
    assert.equal(await db.prepare('SELECT count(*) FROM conversations').first('count(*)'), 1)
    provider.propertyId = 'property'
    provider.messages[0]!.attributes.message = 'Changed after recording'
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('CHANNEL_MESSAGE_ID_CONFLICT'))
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('a guest who wrote before booking keeps one conversation: the reservation\'s own joins the inquiry\'s, nothing discarded', async () => {
  const { runtime, db, env, productId } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    // The inquiry: Airbnb's conversation before any booking.
    await mirrorChannexThread(db, env, 'thread', 'property')
    const inquiry = (await db.prepare('SELECT conversation_id AS conversation_id FROM channel_threads').first<string>('conversation_id'))!
    // The reservation lands with its own conversation, opened by the channel.
    const stay = await applyChannelBooking(db, env, ORG, productId, booking())
    assert.notEqual(stay.conversation_id, inquiry)
    // A receipt the inquiry already holds stays with its message.
    const historical = await appendMessage(db, { conversationId: inquiry, authorKind: 'member', authorUserId: OWNER, body: 'Recorded history', channel: 'email', dedupeKey: 'history' })
    const receipt = await createDeliveryReceipt(db, { subject: { messageId: historical.id }, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'historical-delivery' })
    const ledger = async (id: string) => (await db.prepare('SELECT event_name, author_kind FROM messages WHERE conversation_id = ? ORDER BY sequence').bind(id).all<{ event_name: string | null; author_kind: string }>()).results
    const before = [...await ledger(inquiry), ...await ledger(stay.conversation_id)]
    // Airbnb assigns the conversation to the booking.
    provider.bookingId = 'booking'
    await mirrorChannexMessageEvent(db, env, { event: 'message_thread_booking_assigned', property_id: 'property', payload: { booking_id: 'booking', message_thread_id: 'thread' } })
    assert.deepEqual(await db.prepare("SELECT c.id AS conversation_id FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking' WHERE b.id = ?").bind(stay.id).first(), { conversation_id: inquiry })
    assert.deepEqual(await db.prepare('SELECT id FROM conversations').all().then(rows => rows.results), [{ id: inquiry }])
    // Every entry of both timelines is in the one conversation, the reservation's after the inquiry's.
    assert.deepEqual(await ledger(inquiry), before)
    assert.equal(await db.prepare('SELECT message_id FROM guest_thread_deliveries WHERE id = ?').bind(receipt.id).first('message_id'), historical.id)
    const request = (await getGuestRequest(db, inquiry, ORG))!
    const detail = (await hostConversation(db, env, inquiry)).conversation
    assert(request.kind === 'booking')
    assert(detail.kind === 'guest')
    assert.deepEqual([request.payload.guest.name, request.payload.participant?.title, detail.booking_id], ['Actual Guest', 'Conversation supplied by Airbnb', stay.id])
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('a reply is sent with the message id Channex returns, and any Channex error is a failed reply sent again under its key', async () => {
  const { runtime, db, env, productId } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  let releaseRetry: (() => void) | undefined
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    const result = await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(result.status, 'mirrored')
    if (result.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    const input = { threadId: result.conversation_id, organizationId: ORG, body: 'Welcome', idempotencyKey: 'accepted', actorUserId: OWNER, env }
    assert.equal((await sendGuestThreadReply(db, input)).ok, true)
    assert.equal((await sendGuestThreadReply(db, input)).ok, true)
    assert.equal(provider.sends, 1)
    assert.deepEqual(await db.prepare("SELECT channel, provider, status, provider_message_id FROM guest_thread_deliveries").first(), { channel: 'airbnb', provider: 'channex', status: 'accepted', provider_message_id: 'accepted-1' })
    // Airbnb's copy of the reply is the reply: it is not stored twice.
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT count(*) FROM messages').first('count(*)'), 3)
    assert.equal((await hostMessages(db, env, result.conversation_id)).length, 3)
    // A scheduled message and its echo are one message, shown as automatic.
    const instructions = 'Your scheduled check-in instructions'
    const scheduled = await sendScheduledGuestReply(db, { threadId: result.conversation_id, organizationId: ORG, body: instructions, idempotencyKey: 'automatic-instructions', env })
    assert.equal(scheduled.outcome.ok, true)
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual((await hostMessages(db, env, result.conversation_id)).filter(entry => entry.body === instructions).map(entry => [entry.id, entry.author, entry.automatic]),
      [[scheduled.messageId, 'Automatic', true]])
    await assert.rejects(sendGuestThreadReply(db, { ...input, body: 'Changed text' }), code('IDEMPOTENCY_CONFLICT'))
    await assert.rejects(sendGuestThreadReply(db, { ...input, photos: [{ filename: 'file', bytes: new Uint8Array([1]) }] }), code('CHANNEL_PHOTO_MESSAGE_INVALID'))

    // Each way Channex can answer with an error is a failed reply with Channex's error, shown on the conversation.
    for (const [failure, key] of [['refuseMessage', 'refused'], ['airbnbUnavailable', 'upstream'], ['uncertain', 'connection']] as const) {
      Object.assign(provider, { [failure]: true })
      const failedInput = { ...input, body: `Reply that fails: ${key}`, idempotencyKey: key }
      const failed = await sendGuestThreadReply(db, failedInput)
      if (failed.ok || failed.reason !== 'delivery_failed') throw new Error(`Expected a failed reply for ${key}`)
      assert.deepEqual([failed.status, failed.code, failed.retry_with_same_idempotency_key], [502, 'CHANNEL_REPLY_FAILED', true], key)
      const receipt = await db.prepare(`SELECT d.status, d.provider_message_id, d.error FROM guest_thread_deliveries d JOIN messages a ON a.id = d.message_id
        WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${result.conversation_id}:${key}`).first<{ status: string; provider_message_id: string | null; error: string | null }>()
      assert.deepEqual([receipt?.status, receipt?.provider_message_id], ['failed', null], key)
      assert.ok(receipt?.error, `${key}: Channex's error is recorded`)
      Object.assign(provider, { [failure]: false })
    }
    const refusedEntry = await db.prepare('SELECT id FROM messages WHERE dedupe_key = ?').bind(`guest-thread-operation:${result.conversation_id}:refused`).first<{ id: string }>()
    assert.ok(refusedEntry)
    assert.equal((await listThreadDeliveries(db, result.conversation_id)).filter(delivery => delivery.status === 'failed').length, 3)

    // Sending the failed reply again under its key sends it once, even when two retries race.
    const refusedInput = { ...input, body: 'Reply that fails: refused', idempotencyKey: 'refused' }
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('retry-cohost', 'Cohost', 'retry-cohost@example.test', 1, 0, 0)").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('retry-cohost-member', ?, 'retry-cohost', 'member', 0)").bind(ORG).run()
    const owner = joinedMemberPrincipal({ userId: OWNER, organizationId: ORG, memberId: 'owner-member', role: 'owner' }, { env })
    const grant = { listingId: productId, memberId: 'retry-cohost-member' }
    await setListingAccess(db, env, owner, { ...grant, access: 'messaging' })
    const cohostRetry = { ...refusedInput, actorUserId: 'retry-cohost' }
    await assert.rejects(sendGuestThreadReply(db, cohostRetry), code('IDEMPOTENCY_CONFLICT'))
    assert.deepEqual(await sendGuestThreadReply(db, { ...cohostRetry, retryMessageId: 'missing-message' }),
      { ok: false, status: 404, reason: 'thread_not_found' })
    const explicitRetry = { ...cohostRetry, retryMessageId: refusedEntry.id }
    const started = new Promise<void>(resolve => { provider.onSend = resolve })
    provider.holdReply = new Promise<void>(resolve => { releaseRetry = resolve })
    const sendsBefore = provider.sends
    const recovering = Promise.all([sendGuestThreadReply(db, explicitRetry), sendGuestThreadReply(db, refusedInput)])
    await started
    assert.equal((await db.prepare('SELECT status FROM guest_thread_deliveries WHERE message_id = ?').bind(refusedEntry.id).first('status')), 'sending')
    releaseRetry!()
    const recovered = await recovering
    provider.holdReply = undefined
    provider.onSend = undefined
    assert.ok(recovered.some(outcome => outcome.ok))
    for (const outcome of recovered) {
      if (outcome.ok) continue
      if (outcome.reason !== 'delivery_failed') throw new Error(`Unexpected concurrent retry result: ${outcome.reason}`)
      assert.deepEqual([outcome.status, outcome.code, outcome.message], [409, 'CHANNEL_REPLY_FAILED', 'This reply is already being sent.'])
    }
    assert.equal(provider.sends - sendsBefore, 1, 'concurrent retries send once')
    assert.equal(await db.prepare('SELECT author_user_id FROM messages WHERE id = ?').bind(refusedEntry.id).first('author_user_id'), OWNER)
    await setListingAccess(db, env, owner, { ...grant, access: null })
    assert.deepEqual(await sendGuestThreadReply(db, explicitRetry), { ok: false, status: 404, reason: 'thread_not_found' })
    assert.equal(provider.sends - sendsBefore, 1, 'a revoked cohost cannot replay the delivered message')
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, error FROM guest_thread_deliveries WHERE message_id = ?').bind(refusedEntry.id).first(),
      { status: 'accepted', provider_message_id: `accepted-${provider.sends}`, error: null })
  } finally { releaseRetry?.(); globalThis.fetch = realFetch; await runtime.dispose() }
})
