import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'h3'
import { createHmac } from 'node:crypto'
import sharp from 'sharp'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, createStay, type ChannelBooking } from '../../server/domain/stays.ts'
import { backfillChannexMessages, mirrorChannexMessageEvent, mirrorChannexThread } from '../../server/domain/guest-threads/channel-messages.ts'
import { sendGuestThreadReply, sendScheduledGuestReply } from '../../server/domain/guest-threads/operations.ts'
import { conversationPageFor } from './support/conversation-page.ts'
import { listConversations } from '../../server/domain/guest-threads/repository.ts'
import { appendMessage, assertConversationAccess, type MessageRow } from '../../server/domain/conversations.ts'
import { createDeliveryReceipt, listThreadDeliveries, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { getGuestRequest } from '../../server/domain/requests.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { guestThreadListPage, parseGuestThreadListQuery } from '../../server/utils/dashboard-guest-threads.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { listBusinessOutcomes } from '../../server/utils/business-outcomes.ts'
import whatsappWebhook from '../../server/api/whatsapp/webhook.post.ts'
import { receiveMemberEmail } from '../../server/domain/guest-threads/inbound-email.ts'
import { InboundEmailRejection, parseReplyToAddress } from '../../server/utils/reply-address.ts'

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
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('owner-member', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('location', ?, 'cabin', 'Cabin', 'active', 'America/Denver', ?, ?)`).bind(ORG, NOW, NOW).run()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), MEDIA_BASE_URL: 'https://media.example.test', CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'test-provider-key', BETTER_AUTH_SECRET: 'stay-billing-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests', EMAIL_REPLY_SECRET: 'member-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'location', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'owner-member' },
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

/** A member reply these tests expect to complete reports nothing; a report fails the test with its error. */
const unexpectedReport = async (error: unknown) => { throw error }

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
    assert.deepEqual(entries.map(entry => [entry.body, entry.author_kind, JSON.parse(entry.payload_json).provider_inserted_at]), [['Hello', 'guest', RAW], [null, 'krabiclaw', RAW]])
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

test('empty Channex host actions are recorded, and a real photo reply appears in the conversation', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    // The shape Channex returned for message c2f68d4e (read 2026-11-05): a host message, message null, no attachments, no meta.
    const receivedAt = Date.now() - 1000
    const guestAt = new Date(receivedAt).toISOString()
    const empty = provider.message('host-action', 'property', null, [], new Date(receivedAt + 1).toISOString())
    provider.messages = [provider.message('first', 'guest', 'Hello', [], guestAt), empty]
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    const requestId = await db.prepare("SELECT conversation_id AS conversation_id FROM channel_threads WHERE external_thread_id = 'thread'").first<string>('conversation_id')
    assert.ok(requestId)
    const recorded = await db.prepare("SELECT author_kind, body FROM messages WHERE dedupe_key = 'channex-message:host-action'").first<{ author_kind: string; body: string | null }>()
    assert.deepEqual(recorded, { author_kind: 'member', body: null })

    // The conversation reads as the guest's words alone, and the list previews them.
    const owner = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const thread = await conversationPageFor(db, owner, requestId)
    assert.deepEqual(thread.entries.filter(item => item.type === 'message').map(item => item.type === 'message' ? [item.side, item.body] : null), [['guest', 'Hello']])
    const [row] = await listConversations(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'current' })
    assert.deepEqual([row!.preview, row!.preview_from], ['Hello', 'Conversation supplied by Airbnb'])

    // A webhook re-mirror of the same conversation records it once and still succeeds.
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE dedupe_key = 'channex-message:host-action'").first('count(*)'), 1)

    provider.messages.push(provider.message('blank-host-action', 'property', '   ', [], new Date(receivedAt + 2).toISOString()))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual((await hostMessages(db, env, requestId)).map(entry => entry.body), ['Hello'])

    // A real image-only host reply is downloaded and placed on its message.
    provider.messages.push(provider.message('host-photo', 'property', null, ['/attachment/file'], new Date(receivedAt + 3).toISOString()))
    await mirrorChannexThread(db, env, 'thread', 'property')
    const photoReply = (await hostMessages(db, env, requestId)).find(entry => entry.body === null && entry.side === 'business' && entry.photos.length > 0)
    assert.ok(photoReply)
    assert.equal(photoReply.photos.length, 1)
    assert.ok(photoReply.photos[0]!.url.startsWith('https://media.example.test/'))
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('a message mirrored before photos were stored gets its photo on the next backfill or re-mirror, and keeps one set', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    // The conversation as production holds it: adopted, with the attachment message
    // recorded by the earlier mirror, which kept only Channex's link.
    const attachmentMessage = provider.messages[1]!
    provider.messages = [provider.messages[0]!]
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    const requestId = await db.prepare("SELECT conversation_id AS conversation_id FROM channel_threads WHERE external_thread_id = 'thread'").first<string>('conversation_id')
    assert.ok(requestId)
    const recorded = await appendMessage(db, {
      conversationId: requestId, authorKind: 'krabiclaw', authorUserId: null, channel: 'airbnb', body: null, eventName: 'channel.message_mirrored', dedupeKey: 'channex-message:second',
      payload: { provider_message_id: 'second', provider_inserted_at: RAW, provider_updated_at: RAW, attachments: ['https://channex.test/attachment/file'], meta: { inquiry: true } },
    })
    const placements = () => db.prepare("SELECT count(*) AS n FROM media_placements WHERE owner_type = 'message' AND owner_id = ? AND slot = 'attachments' AND status = 'active'").bind(recorded.id).first<number>('n')
    assert.equal(await placements(), 0)
    assert.deepEqual(provider.fileReads, [])

    // The backfill finds the recorded message and stores its photo on it.
    provider.messages = [provider.messages[0]!, attachmentMessage]
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    assert.equal(await placements(), 1)
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    assert.equal(await db.prepare("SELECT count(*) FROM messages WHERE dedupe_key = 'channex-message:second'").first('count(*)'), 1)
    const [photo] = (await hostMessages(db, env, requestId)).find(entry => entry.id === recorded.id)!.photos
    assert.ok(photo && photo.url.startsWith('https://media.example.test/'), 'the message shows our stored photo, not the Channex link')

    // A webhook's re-mirror of the same conversation keeps exactly that one set.
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await placements(), 1)
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 1)
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('the inbox exposes every page with a stable tie order and validates pagination instead of hiding a row cap', async () => {
  const { runtime, db } = await boot()
  try {
    const payload = JSON.stringify({ guest: { name: 'Guest', email: 'guest@example.test', phone: null }, subject: null, consent_at: null, ip_hash: null })
    for (const id of ['e', 'c', 'b', 'd', 'a']) {
      await db.batch([
        db.prepare("INSERT INTO conversations (id, kind, organization_id, payload_json, last_message_at, created_at) VALUES (?, 'contact', ?, ?, ?, ?)").bind(id, ORG, payload, NOW, NOW),
        db.prepare("INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role) VALUES (?, ?, ?, 'member')").bind(id, ORG, OWNER),
      ])
    }
    const first = guestThreadListPage(await listConversations(db, ORG, { userId: OWNER, limit: 4, offset: 0 }), { limit: 3, offset: 0 })
    assert.deepEqual(first.threads.map(thread => thread.id), ['a', 'b', 'c'])
    assert.deepEqual(first.pagination, { limit: 3, offset: 0, has_more: true, next_offset: 3 })
    const last = guestThreadListPage(await listConversations(db, ORG, { userId: OWNER, limit: 4, offset: 3 }), { limit: 3, offset: 3 })
    assert.deepEqual(last.threads.map(thread => thread.id), ['d', 'e'])
    assert.deepEqual(last.pagination, { limit: 3, offset: 3, has_more: false, next_offset: null })
    for (const [query, field] of [[{ limit: '0' }, 'limit'], [{ limit: '101' }, 'limit'], [{ offset: '-1' }, 'offset'], [{ limit: ['3'] }, 'limit'],
      [{ type: 'everything' }, 'type'], [{ conversation_state: 'resolved' }, 'conversation_state'], [{ q: 'x'.repeat(201) }, 'q'], [{ mailbox: ['past'] }, 'mailbox'], [{ unread: 'yes' }, 'unread'], [{ location_id: ' ' }, 'location_id'], [{ organization_id: 'org' }, 'organization_id']] as const) {
      assert.throws(() => parseGuestThreadListQuery(query), { status: 400, data: { code: 'INVALID_GUEST_THREAD_FILTER', field } })
    }
    assert.deepEqual(parseGuestThreadListQuery({ limit: '3', offset: '3' }), { limit: 3, offset: 3, locationId: null, type: null, kind: null, q: null, unreadOnly: false, mailbox: null })
  } finally { await runtime.dispose() }
})

test('booking assignment before or after booking arrival adopts one request and preserves its immutable ledger and receipts', async () => {
  for (const withImport of [false, true]) for (const first of ['conversation', 'booking'] as const) {
    const { runtime, db, env, productId } = await boot()
    const provider = new Provider(), realFetch = globalThis.fetch
    globalThis.fetch = provider.fetch as typeof fetch
    try {
      const terms = booking()
      const imported = withImport ? await createStay(db, env, { organizationId: ORG, actorId: OWNER, manage: true }, {
        product_id: productId, idempotency_key: 'hostaway:imported-ota', guest_name: 'Actual Guest', guest_email: 'actual@example.test',
        check_in_date: terms.check_in_date, check_out_date: terms.check_out_date, adults: terms.adults, total_minor: terms.total_minor,
      }, { imported: { source: 'hostaway', source_id: 'imported-ota', row: { id: 'imported-ota' }, fingerprint: 'imported-ota-fingerprint', channel: terms.channel, channel_booking_id: terms.channel_booking_id } }) : null
      // Every booking has its conversation from the start; the channel's thread is addressed to it when it arrives.
      if (imported) assert.equal(await db.prepare('SELECT count(*) FROM conversations').first('count(*)'), 1)
      provider.bookingId = 'booking'
      let stay = first === 'booking' ? await applyChannelBooking(db, env, ORG, productId, booking()) : null
      const opened = stay?.conversation_id ?? imported?.conversation_id ?? null
      await mirrorChannexMessageEvent(db, env, { event: 'message_thread_booking_assigned', property_id: 'property', payload: { booking_id: 'booking', message_thread_id: 'thread' } })
      const requestId = (await db.prepare('SELECT conversation_id AS conversation_id FROM channel_threads').first<string>('conversation_id'))!
      if (first === 'booking') assert.equal(requestId, opened, 'the channel thread is addressed to the booking\'s own conversation')
      const historical = await appendMessage(db, { conversationId: requestId, authorKind: 'member', authorUserId: OWNER, body: 'Recorded history', channel: 'email', dedupeKey: 'history' })
      const receipt = await createDeliveryReceipt(db, { subject: { messageId: historical.id }, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'historical-delivery' })
      stay = await applyChannelBooking(db, env, ORG, productId, { ...booking(), revision_id: 'revision-2', provider_updated_at: '2026-10-16T01:00:00Z' })
      assert.equal(stay.conversation_id, requestId)
      if (imported) {
        assert.equal(stay.id, imported.id, 'the channel revision adopts the imported stay')
        assert.deepEqual(await db.prepare("SELECT b.owner, c.id AS conversation_id FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking' WHERE b.id = ?").bind(imported.id).first(), { owner: 'channel', conversation_id: requestId })
      }
      assert.equal(await db.prepare('SELECT count(*) FROM bookings').first('count(*)'), 1)
      assert.equal(await db.prepare('SELECT count(*) FROM conversations').first('count(*)'), 1)
      assert.equal(await db.prepare('SELECT message_id FROM guest_thread_deliveries WHERE id = ?').bind(receipt.id).first('message_id'), historical.id)
      const detail = (await getGuestRequest(db, requestId, ORG))!
      assert(detail.kind === 'booking')
      assert.deepEqual([detail.payload.guest.name, detail.payload.participant?.title, detail.booking_id], ['Actual Guest', 'Conversation supplied by Airbnb', stay.id])
      // The two mirrored Airbnb messages and the recorded history; a channel booking opens its conversation with nothing said.
      assert.equal((await recordedMessages(db, requestId)).length, 3)
      await applyChannelBooking(db, env, ORG, productId, { ...booking(), revision_id: 'revision-3', provider_updated_at: '2026-10-16T02:00:00Z', cancelled: true, guest_name: null, guest_surname: null })
      assert.equal((await getGuestRequest(db, requestId, ORG))!.payload.guest.name, null)
      assert.equal(await db.prepare('SELECT count(*) FROM stay_nights').first('count(*)'), 0)
      assert.equal(await db.prepare('SELECT count(*) FROM messages').first('count(*)'), 3)
    } finally { globalThis.fetch = realFetch; await runtime.dispose() }
  }
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
    const ledger = async (id: string) => (await db.prepare('SELECT event_name, author_kind FROM messages WHERE conversation_id = ? ORDER BY sequence').bind(id).all<{ event_name: string | null; author_kind: string }>()).results
    const before = [...await ledger(inquiry), ...await ledger(stay.conversation_id)]
    // Airbnb assigns the conversation to the booking.
    provider.bookingId = 'booking'
    await mirrorChannexMessageEvent(db, env, { event: 'message_thread_booking_assigned', property_id: 'property', payload: { booking_id: 'booking', message_thread_id: 'thread' } })
    assert.deepEqual(await db.prepare("SELECT c.id AS conversation_id FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking' WHERE b.id = ?").bind(stay.id).first(), { conversation_id: inquiry })
    assert.deepEqual(await db.prepare('SELECT id FROM conversations').all().then(rows => rows.results), [{ id: inquiry }])
    // Every entry of both timelines is in the one conversation, the reservation's after the inquiry's.
    assert.deepEqual(await ledger(inquiry), before)
    const request = (await getGuestRequest(db, inquiry, ORG))!
    const detail = (await hostConversation(db, env, inquiry)).conversation
    assert(request.kind === 'booking')
    assert(detail.kind === 'guest')
    assert.deepEqual([request.payload.guest.name, request.payload.participant?.title, detail.booking_id], ['Actual Guest', 'Conversation supplied by Airbnb', stay.id])
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
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
      const requestId = (await db.prepare('SELECT conversation_id AS conversation_id FROM channel_threads').first<string>('conversation_id'))!
      const entries = async () => (await db.prepare("SELECT body, author_kind FROM messages WHERE conversation_id = ? AND event_name = 'channel.message_mirrored' ORDER BY sequence").bind(requestId).all()).results
      assert.deepEqual(await entries(), [{ body: 'Hello', author_kind: 'guest' }, { body: null, author_kind: 'krabiclaw' }])

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


      assert.deepEqual((await db.prepare('SELECT external_thread_id, external_booking_id, moved_from_thread_id, conversation_id AS conversation_id FROM channel_threads').all()).results,
        [{ external_thread_id: 'thread-production', external_booking_id: 'booking-production', moved_from_thread_id: 'thread', conversation_id: requestId }], first)
      assert.deepEqual((await db.prepare("SELECT b.id, b.external_booking_id, c.id AS conversation_id FROM bookings b JOIN conversations c ON c.booking_id = b.id AND c.kind = 'booking'").all()).results, [{ id: stay.id, external_booking_id: 'booking-production', conversation_id: requestId }], first)
      assert.equal(await db.prepare('SELECT count(*) FROM conversations').first('count(*)'), 1, first)
      assert.deepEqual(await entries(), [{ body: 'Hello', author_kind: 'guest' }, { body: null, author_kind: 'krabiclaw' }, { body: 'Arriving late', author_kind: 'guest' }], first)
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
    const history = stay.conversation_id
    await appendMessage(db, { conversationId: history, authorKind: 'guest', authorUserId: null, channel: 'email', body: 'Historical message', dedupeKey: 'old' })
    const input = { threadId: history, organizationId: ORG, body: 'Hello', idempotencyKey: 'unaddressable', actorUserId: OWNER, env }
    // A channel stay with no addressable conversation is nowhere to reply, refused before anything is recorded or sent.
    assert.deepEqual(await sendGuestThreadReply(db, input), { ok: false, status: 409, reason: 'guest_unreachable', code: 'GUEST_UNREACHABLE', field: 'conversation_id', message: 'This Airbnb stay has no conversation to reply in yet.' })
    provider.bookingId = 'booking'
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT conversation_id AS conversation_id FROM channel_threads').first('conversation_id'), history)
    assert.equal((await getGuestRequest(db, history, ORG))!.payload.guest.name, 'Actual Guest')
    // The stay is now another conversation's: the Airbnb thread's conversation no longer names it.
    await db.prepare("UPDATE conversations SET booking_id = NULL WHERE id = ?").bind(history).run()
    await db.prepare(`INSERT INTO conversations (id, kind, organization_id, location_id, booking_id, payload_json, last_message_at, created_at)
      VALUES ('other', 'booking', ?, 'location', ?, ?, ?, ?)`).bind(ORG, stay.id, JSON.stringify({ guest: { name: 'Other contact', email: 'other@example.test', phone: null }, ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } }), NOW, NOW).run()
    await appendMessage(db, { conversationId: 'other', authorKind: 'guest', authorUserId: null, channel: 'email', body: 'Another timeline', dedupeKey: 'other-timeline' })
    const recorded = await db.prepare('SELECT count(*) FROM messages').first('count(*)')
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('CHANNEL_THREAD_ASSOCIATION_CONFLICT'))
    assert.equal(await db.prepare('SELECT count(*) FROM conversations').first('count(*)'), 2)
    assert.equal(await db.prepare('SELECT count(*) FROM messages').first('count(*)'), recorded)
    await db.prepare("DELETE FROM channel_threads").run()
    await db.prepare("UPDATE conversations SET payload_json = ? WHERE id = 'other'").bind(JSON.stringify({ participant: { kind: 'channel', title: 'Unmapped' }, guest: { name: null, email: null, phone: null }, ip_hash: null, cancellation: { token_hash: null, expires_at: null, used_at: null } })).run()
    assert.equal((await getGuestRequest(db, 'other', ORG))?.booking_id, stay.id)
    await db.prepare("UPDATE conversations SET booking_id = NULL WHERE id = 'other'").run()
    await assert.rejects(getGuestRequest(db, 'other', ORG), code('CHANNEL_THREAD_MAPPING_INVALID'))
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('a reply is sent with the message id Channex returns, and any Channex error is a failed reply sent again under its key', async () => {
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
    const input = { threadId: result.conversation_id, organizationId: ORG, body: 'Welcome', idempotencyKey: 'accepted', actorUserId: OWNER, env }
    assert.equal((await sendGuestThreadReply(db, input)).ok, true)
    assert.equal((await sendGuestThreadReply(db, input)).ok, true)
    assert.equal(provider.sends, 1)
    assert.deepEqual(await db.prepare("SELECT channel, provider, status, provider_message_id FROM guest_thread_deliveries").first(), { channel: 'airbnb', provider: 'channex', status: 'accepted', provider_message_id: 'accepted-1' })
    // Airbnb's copy of the reply is the reply: it is not stored twice.
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT count(*) FROM messages').first('count(*)'), 3)
    assert.equal((await hostMessages(db, env, result.conversation_id)).length, 3)
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
    const refusedProgress = (await listBusinessOutcomes(db, principal, { limit: 100 })).outcomes.find(outcome => outcome.id === refusedEntry.id)
    assert.deepEqual(refusedProgress?.verification, { status: 'failed', basis: 'provider_acceptance', receipts: [{
      id: `guest-thread-channex:${result.conversation_id}:refused`, channel: 'airbnb', provider: 'channex', status: 'failed', provider_message_id: null,
    }] })
    assert.equal((await listThreadDeliveries(db, result.conversation_id)).filter(delivery => delivery.status === 'failed').length, 3)

    // Sending the failed reply again under its key sends it once, even when two retries race.
    const refusedInput = { ...input, body: 'Reply that fails: refused', idempotencyKey: 'refused' }
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('retry-cohost', 'Cohost', 'retry-cohost@example.test', 1, 0, 0)").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('retry-cohost-member', ?, 'retry-cohost', 'member', 0)").bind(ORG).run()
    await db.prepare("INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role) VALUES (?, ?, 'retry-cohost', 'member')").bind(result.conversation_id, ORG).run()
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
    await db.prepare("DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = 'retry-cohost'").bind(result.conversation_id).run()
    assert.deepEqual(await sendGuestThreadReply(db, explicitRetry), { ok: false, status: 404, reason: 'thread_not_found' })
    assert.equal(provider.sends - sendsBefore, 1, 'a revoked cohost cannot replay the delivered message')
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, error FROM guest_thread_deliveries WHERE message_id = ?').bind(refusedEntry.id).first(),
      { status: 'accepted', provider_message_id: `accepted-${provider.sends}`, error: null })
    const recoveredProgress = (await listBusinessOutcomes(db, principal, { limit: 100 })).outcomes.find(outcome => outcome.id === refusedEntry.id)
    assert.deepEqual([recoveredProgress?.verification.status, recoveredProgress?.verification.receipts.map(receipt => [receipt.status, receipt.provider_message_id])],
      ['verified', [['accepted', `accepted-${provider.sends}`]]])
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
    const input = { threadId: mirrored.conversation_id, organizationId: ORG, body: '', idempotencyKey: 'photo', actorUserId: OWNER, env,
      photos: { sourceIds: ['host-photo-id'], resolve: async () => { resolutions += 1; return [photo] } } }
    await assert.rejects(sendGuestThreadReply(db, { ...input, body: 'Text would discard this photo' }), code('CHANNEL_PHOTO_MESSAGE_INVALID'))
    await assert.rejects(sendGuestThreadReply(db, { ...input, photos: [photo, photo] }), code('CHANNEL_PHOTO_MESSAGE_INVALID'))
    const invalid = await sendGuestThreadReply(db, { ...input, photos: [{ filename: 'document.svg', bytes: new TextEncoder().encode('<svg/>') }] })
    assert.deepEqual(invalid, { ok: false, status: 400, reason: 'invalid_photo', message: 'document.svg is not a JPEG, PNG, WebP, GIF or AVIF photo.' })
    assert.equal(provider.sends, 0)
    assert.equal(provider.uploads.length, 0)
    assert.equal(await db.prepare('SELECT count(*) FROM guest_thread_deliveries').first('count(*)'), 0)

    assert.equal((await sendGuestThreadReply(db, input)).ok, true)
    assert.deepEqual(provider.uploads, [{ file: Buffer.from(bytes).toString('base64'), file_name: 'entry.avif', file_type: 'image/avif' }])
    const asset = await db.prepare(`SELECT ma.id, ma.r2_key, ma.public_url FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id
      JOIN messages a ON a.id = mp.owner_id WHERE mp.owner_type = 'message' AND mp.status = 'active' AND a.conversation_id = ? AND a.event_name = 'thread.member_reply'`).bind(mirrored.conversation_id).first<{ id: string; r2_key: string; public_url: string }>()
    assert.ok(asset)
    const saved = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(asset.r2_key)
    assert.ok(saved)
    assert.deepEqual(new Uint8Array(await saved.arrayBuffer()), bytes, 'the canonical media store retained the actual uploaded image')
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id FROM guest_thread_deliveries').first(), { status: 'accepted', provider_message_id: 'accepted-1' })
    await mirrorChannexThread(db, env, 'thread', 'property')
    const messages = await hostMessages(db, env, mirrored.conversation_id)
    assert.equal(messages.length, 3, 'the receipt suppresses only its exact provider echo')
    assert.deepEqual(messages[2]!.photos.map(item => [item.id, item.url]), [[asset.id, asset.public_url]])
    assert.equal(messages[2]!.body, '')
    const replay = { ...input, photos: { sourceIds: ['host-photo-id'], resolve: async () => { throw new Error('Host download has expired') } } }
    assert.equal((await sendGuestThreadReply(db, replay)).ok, true)
    assert.deepEqual([resolutions, provider.sends, provider.uploads.length], [1, 1, 1])
    await assert.rejects(sendGuestThreadReply(db, { ...replay, photos: { ...replay.photos, sourceIds: ['different-photo-id'] } }), code('IDEMPOTENCY_CONFLICT'))

    // The connection ends after Channex stored the photo: the reply failed, with Channex's error.
    provider.uncertain = true
    const lostInput = { ...input, idempotencyKey: 'lost-photo' }
    const lost = await sendGuestThreadReply(db, lostInput)
    if (lost.ok || lost.reason !== 'delivery_failed') throw new Error('Expected a failed reply')
    assert.deepEqual([lost.code, lost.retry_with_same_idempotency_key], ['CHANNEL_REPLY_FAILED', true])
    assert.deepEqual([resolutions, provider.sends, provider.uploads.length], [2, 2, 2])
    await mirrorChannexThread(db, env, 'thread', 'property')
    const afterLost = await hostMessages(db, env, mirrored.conversation_id)
    assert.equal(afterLost.length, 5, 'without Channex\'s message id the failed reply and the message Channex stored are both shown')
    assert.equal(afterLost.find(entry => entry.receipt === 'Not delivered')?.receipt, 'Not delivered')
    // Mirroring keeps the photos Channex holds that KrabiClaw does not: the guest's, and the echo of the failed reply whose
    // identity was never learned. The echo of the accepted reply is that reply's own photo, already stored, and is not read again.
    assert.deepEqual(provider.fileReads, ['/attachment/file', '/api/v1/attachments/photo-2'])
    const mirroredPhotos = 2
    assert.equal(await db.prepare('SELECT count(*) FROM media_assets').first('count(*)'), 2 + mirroredPhotos)

    provider.uncertain = false
    const simultaneous = { ...input, idempotencyKey: 'simultaneous-photo' }
    const raced = await Promise.all([sendGuestThreadReply(db, simultaneous), sendGuestThreadReply(db, simultaneous)])
    assert.ok(raced.some(outcome => outcome.ok), 'one concurrent request completes the actual send')
    for (const outcome of raced) {
      if (outcome.ok) continue
      if (outcome.reason !== 'delivery_failed') throw new Error(`Unexpected concurrent reply result: ${outcome.reason}`)
      assert.deepEqual([outcome.status, outcome.code], [409, 'CHANNEL_REPLY_FAILED'])
    }
    assert.deepEqual([provider.sends, provider.uploads.length], [3, 3], 'the same concurrent photo intent delivers once')
    assert.deepEqual(await db.prepare(`SELECT d.status, d.provider_message_id, COUNT(mp.asset_id) AS photos FROM guest_thread_deliveries d
      JOIN messages a ON a.id = d.message_id LEFT JOIN media_placements mp ON mp.owner_type = 'message' AND mp.owner_id = a.id AND mp.status = 'active'
      WHERE a.dedupe_key = ? GROUP BY d.id`).bind(`guest-thread-operation:${mirrored.conversation_id}:simultaneous-photo`).first(),
    { status: 'accepted', provider_message_id: 'accepted-3', photos: 1 })
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 3 + mirroredPhotos, 'the losing request retains no active orphan media asset')
    assert.equal((await (await runtime.getR2Bucket('MEDIA_BUCKET')).list({ prefix: `organizations/${ORG}/media/` })).objects.length, 3 + mirroredPhotos, 'only the three retained reply photos and the mirrored photos remain stored')
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_type = 'message'").first('count(*)'), 3 + mirroredPhotos)
    assert.equal((await recordedMessages(db, mirrored.conversation_id)).filter(entry => entry.event_name === 'thread.member_reply').length, 3)

    provider.refuseAttachment = true
    const refusedInput = { ...input, idempotencyKey: 'refused-photo-upload' }
    const refused = await sendGuestThreadReply(db, refusedInput)
    if (refused.ok || refused.reason !== 'delivery_failed') throw new Error('Expected a recorded attachment preparation failure')
    assert.deepEqual([refused.status, refused.code, refused.retry_with_same_idempotency_key], [502, 'CHANNEL_REPLY_FAILED', true])
    assert.equal(refused.provider_error?.uncertain, false)
    assert.deepEqual([provider.sends, provider.uploads.length], [3, 4], 'a refused upload never calls the guest message endpoint')
    const refusedReceipt = await db.prepare(`SELECT d.status, d.provider_message_id, d.error, a.id FROM guest_thread_deliveries d
      JOIN messages a ON a.id = d.message_id WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${mirrored.conversation_id}:refused-photo-upload`)
      .first<{ status: string; provider_message_id: string | null; error: string; id: string }>()
    assert.ok(refusedReceipt)
    assert.deepEqual([refusedReceipt.status, refusedReceipt.provider_message_id], ['failed', null])
    assert.match(refusedReceipt.error, /no guest message was sent/)
    const refusalDetail = await hostMessages(db, env, mirrored.conversation_id)
    assert.equal(refusalDetail.find(entry => entry.id === refusedReceipt.id)!.photos.length, 1, 'the failed send retains the chosen photo for review')
    assert.equal(refusalDetail.find(entry => entry.id === refusedReceipt.id)?.receipt, 'Not delivered')
    // A failed upload proves no guest message was sent; the same intent can recover.
    const refusedPhoto = refusalDetail.find(entry => entry.id === refusedReceipt.id)!
    const retainedPhoto = await db.prepare(`SELECT ma.id, ma.r2_key, mp.id AS placement_id FROM media_assets ma
      JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id
      WHERE mp.owner_type = 'message' AND mp.owner_id = ? AND mp.slot = 'attachments' AND mp.status = 'active' AND ma.status = 'active'`)
      .bind(refusedReceipt.id).first<{ id: string; r2_key: string; placement_id: string }>()
    assert.ok(retainedPhoto)
    const photoBucket = await runtime.getR2Bucket('MEDIA_BUCKET')
    const beforeRecoveryResolutions = resolutions
    const expiredRefused = { ...refusedInput, photos: { sourceIds: ['host-photo-id'], resolve: async () => { throw new Error('Host download has expired') } } }
    await db.prepare("UPDATE media_placements SET status = 'deleted' WHERE id = ?").bind(retainedPhoto.placement_id).run()
    await assert.rejects(sendGuestThreadReply(db, expiredRefused), code('CHANNEL_REPLY_PHOTO_UNAVAILABLE'))
    await db.prepare("UPDATE media_placements SET status = 'active' WHERE id = ?").bind(retainedPhoto.placement_id).run()
    await photoBucket.delete(retainedPhoto.r2_key)
    await assert.rejects(sendGuestThreadReply(db, expiredRefused), code('CHANNEL_REPLY_PHOTO_UNAVAILABLE'))
    await photoBucket.put(retainedPhoto.r2_key, new Uint8Array(bytes.byteLength))
    await assert.rejects(sendGuestThreadReply(db, expiredRefused), code('CHANNEL_REPLY_PHOTO_UNAVAILABLE'))
    await photoBucket.put(retainedPhoto.r2_key, bytes, { httpMetadata: { contentType: 'image/avif' } })
    assert.deepEqual([provider.sends, provider.uploads.length], [3, 4], 'missing or invalid retained media never reaches the provider or caller resolver')
    assert.deepEqual(await db.prepare('SELECT status FROM guest_thread_deliveries WHERE message_id = ?').bind(refusedReceipt.id).first(),
      { status: 'failed' }, 'media validation happens before the retry claim')
    provider.refuseAttachment = false
    const recovered = await Promise.all([sendGuestThreadReply(db, expiredRefused), sendGuestThreadReply(db, expiredRefused)])
    assert.ok(recovered.some(outcome => outcome.ok))
    for (const outcome of recovered) {
      if (outcome.ok) continue
      if (outcome.reason !== 'delivery_failed') throw new Error(`Unexpected concurrent photo retry result: ${outcome.reason}`)
      assert.deepEqual([outcome.status, outcome.code], [409, 'CHANNEL_REPLY_FAILED'])
    }
    assert.deepEqual([provider.sends, provider.uploads.length], [4, 5], 'concurrent retries of the failed reply send one photo')
    assert.equal(resolutions, beforeRecoveryResolutions, 'matching retries never re-resolve the expired host source')
    assert.deepEqual(provider.uploads[4], provider.uploads[3], 'the retry sends the same stored photo bytes and filename')
    const recoveredDetail = await hostMessages(db, env, mirrored.conversation_id)
    assert.deepEqual(recoveredDetail.filter(entry => entry.id === refusedReceipt.id).map(entry => entry.photos), [refusedPhoto.photos])
    assert.deepEqual(await db.prepare(`SELECT ma.id, ma.r2_key, mp.id AS placement_id FROM media_assets ma
      JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id
      WHERE mp.owner_type = 'message' AND mp.owner_id = ? AND mp.slot = 'attachments' AND mp.status = 'active' AND ma.status = 'active'`)
      .bind(refusedReceipt.id).first(), retainedPhoto)
    const recoveredBytes = await photoBucket.get(retainedPhoto.r2_key)
    assert.ok(recoveredBytes)
    assert.deepEqual(new Uint8Array(await recoveredBytes.arrayBuffer()), bytes)
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, error FROM guest_thread_deliveries WHERE message_id = ?').bind(refusedReceipt.id).first(),
      { status: 'accepted', provider_message_id: 'accepted-4', error: null })
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 4 + mirroredPhotos, 'retry reuses the retained photo')

    provider.attachmentNetworkFailure = true
    const networkInput = { ...input, idempotencyKey: 'interrupted-photo-upload' }
    const interrupted = await sendGuestThreadReply(db, networkInput)
    if (interrupted.ok || interrupted.reason !== 'delivery_failed') throw new Error('Expected a failed attachment preparation')
    assert.deepEqual([interrupted.code, interrupted.retry_with_same_idempotency_key, interrupted.provider_error?.uncertain], ['CHANNEL_REPLY_FAILED', true, false])
    assert.deepEqual([provider.sends, provider.uploads.length], [4, 6], 'an upload network error precedes every guest message call')
    const retained = await db.prepare(`SELECT a.id, ma.id AS asset_id, ma.r2_key, ma.public_url FROM messages a
      JOIN media_placements mp ON mp.owner_type = 'message' AND mp.owner_id = a.id AND mp.status = 'active'
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
      WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${mirrored.conversation_id}:interrupted-photo-upload`)
      .first<{ id: string; asset_id: string; r2_key: string; public_url: string }>()
    assert.ok(retained)
    const retainedBytes = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(retained.r2_key)
    assert.ok(retainedBytes)
    assert.deepEqual(new Uint8Array(await retainedBytes.arrayBuffer()), bytes)
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id FROM guest_thread_deliveries WHERE message_id = ?').bind(retained.id).first(),
      { status: 'failed', provider_message_id: null }, 'an interrupted upload is a failed reply')
    provider.attachmentNetworkFailure = false
    assert.equal((await sendGuestThreadReply(db, networkInput)).ok, true)
    assert.deepEqual([provider.sends, provider.uploads.length], [5, 7])
    assert.deepEqual((await hostMessages(db, env, mirrored.conversation_id)).filter(entry => entry.id === retained.id).map(entry => entry.photos.map(photo => [photo.id, photo.url])),
      [[[retained.asset_id, retained.public_url]]])
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id, error FROM guest_thread_deliveries WHERE message_id = ?').bind(retained.id).first(),
      { status: 'accepted', provider_message_id: 'accepted-5', error: null })
    assert.equal(await db.prepare('SELECT count(*) FROM messages WHERE dedupe_key = ?').bind(`guest-thread-operation:${mirrored.conversation_id}:interrupted-photo-upload`).first('count(*)'), 1)
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 5 + mirroredPhotos)
    assert.equal((await sendGuestThreadReply(db, networkInput)).ok, true)
    assert.deepEqual([provider.sends, provider.uploads.length], [5, 7], 'a successful receipt still prevents all repeat sends')

    // JPEG/PNG photos keep their configured Cloudflare Images owner. Its
    // authenticated stored-blob API also permits recovery after host expiry.
    const imageBytes = Uint8Array.from(await sharp({ create: { width: 12, height: 8, channels: 3, background: '#2563eb' } }).png().toBuffer())
    let imageResolutions = 0
    const imageInput = { ...input, idempotencyKey: 'images-photo', env: { ...env, CF_ACCOUNT_ID: 'account-proof', CLOUDFLARE_IMAGES_API_TOKEN: 'test-images-key', CLOUDFLARE_IMAGES_VARIANT_BASE: 'https://imagedelivery.net/proof' },
      photos: { sourceIds: ['host-png-id'], resolve: async () => { imageResolutions += 1; return [{ filename: 'entry.png', bytes: imageBytes }] } } }
    provider.refuseAttachment = true
    const imageRefused = await sendGuestThreadReply(db, imageInput)
    if (imageRefused.ok || imageRefused.reason !== 'delivery_failed') throw new Error('Expected a failed photo preparation')
    assert.deepEqual([imageRefused.code, imageRefused.retry_with_same_idempotency_key], ['CHANNEL_REPLY_FAILED', true])
    const imageAsset = await db.prepare(`SELECT a.id AS entry_id, ma.id, ma.provider, ma.cloudflare_image_id, ma.r2_key, mp.id AS placement_id FROM messages a
      JOIN media_placements mp ON mp.owner_type = 'message' AND mp.owner_id = a.id AND mp.status = 'active'
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
      WHERE a.dedupe_key = ?`).bind(`guest-thread-operation:${mirrored.conversation_id}:images-photo`)
      .first<{ entry_id: string; id: string; provider: string; cloudflare_image_id: string; r2_key: null; placement_id: string }>()
    assert.ok(imageAsset)
    assert.deepEqual([imageAsset.provider, imageAsset.r2_key, provider.images.size, provider.imageReads, imageResolutions], ['cloudflare_images', null, 1, 1, 1])
    assert.deepEqual(provider.images.get(imageAsset.cloudflare_image_id), imageBytes)
    const expiredImage = { ...imageInput, photos: { sourceIds: ['host-png-id'], resolve: async () => { throw new Error('Host PNG download has expired') } } }
    provider.refuseAttachment = false
    provider.refuseImageRead = true
    const beforeMissingImage = await db.prepare('SELECT * FROM guest_thread_deliveries WHERE message_id = ?').bind(imageAsset.entry_id).first()
    await assert.rejects(sendGuestThreadReply(db, expiredImage), { status: 409, data: { code: 'CHANNEL_REPLY_PHOTO_UNAVAILABLE', field: 'photos' } })
    assert.deepEqual(await db.prepare('SELECT * FROM guest_thread_deliveries WHERE message_id = ?').bind(imageAsset.entry_id).first(), beforeMissingImage, 'a missing stored image neither claims nor changes the recorded attempt')
    assert.deepEqual([provider.sends, provider.uploads.length], [5, 8], 'a missing stored Images blob is visible before guest dispatch')
    provider.refuseImageRead = false
    assert.equal((await sendGuestThreadReply(db, expiredImage)).ok, true)
    assert.deepEqual([provider.sends, provider.uploads.length, provider.images.size, provider.imageReads, imageResolutions], [6, 9, 1, 3, 1])
    assert.deepEqual(provider.uploads[8], { file: Buffer.from(imageBytes).toString('base64'), file_name: 'entry.png', file_type: 'image/png' })
    const imageDetail = await hostMessages(db, env, mirrored.conversation_id)
    assert.deepEqual(imageDetail.find(entry => entry.id === imageAsset.entry_id)!.photos.map(photo => photo.id), [imageAsset.id])
    assert.deepEqual(await db.prepare('SELECT status, provider_message_id FROM guest_thread_deliveries WHERE message_id = ?').bind(imageAsset.entry_id).first(),
      { status: 'accepted', provider_message_id: 'accepted-6' })
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
    const input = { threadId: mirrored.conversation_id, organizationId: ORG, body: 'Reply being accepted', idempotencyKey: 'in-flight', actorUserId: OWNER, env }
    const operation = sendGuestThreadReply(db, input)
    await started
    provider.messages.push(provider.message('host-on-airbnb', 'property', 'A real host message'), provider.message('new-guest', 'guest', 'Another guest message'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await db.prepare('SELECT status FROM guest_thread_deliveries').first(), { status: 'sending' })
    const pending = await hostMessages(db, env, mirrored.conversation_id)
    assert.equal(pending.length, 6)
    assert.equal(pending.filter(entry => entry.body === input.body).length, 2, 'unknown identity preserves the attempt and the actual resource')
    const retry = await sendGuestThreadReply(db, input)
    assert.equal(retry.ok, false)
    if (retry.ok || retry.reason !== 'delivery_failed') throw new Error('Expected the reply being sent to refuse a second send')
    assert.deepEqual([retry.status, retry.code, retry.message], [409, 'CHANNEL_REPLY_FAILED', 'This reply is already being sent.'])
    assert.equal(provider.sends, 1)
    release()
    assert.equal((await operation).ok, true)
    const accepted = await hostMessages(db, env, mirrored.conversation_id)
    assert.equal(accepted.length, 5)
    assert.equal(accepted.filter(entry => entry.body === input.body).length, 1)
    assert(accepted.some(entry => entry.body === 'A real host message'))
    assert(accepted.some(entry => entry.body === 'Another guest message'))
    assert.equal(await db.prepare('SELECT count(*) FROM messages').first('count(*)'), 5, 'the copy Airbnb echoed while the reply was in flight is not kept beside the reply')
    await db.prepare("UPDATE product_channel_mappings SET enabled = 0").run()
    assert.equal((await sendGuestThreadReply(db, input)).ok, true, 'an actual recorded receipt replays without a new provider request')
    // A new reply to a disconnected home is nowhere to send, refused before anything is recorded or sent.
    assert.deepEqual(await sendGuestThreadReply(db, { ...input, idempotencyKey: 'disconnected-new', body: 'Not attempted' }),
      { ok: false, status: 409, reason: 'guest_unreachable', code: 'GUEST_UNREACHABLE', field: 'conversation_id', message: 'This home is disconnected from Airbnb, so its guest cannot be replied to here.' })
    // Disconnecting the provider leaves the conversation readable and its composer identifies the channel.
    const owner = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const disconnected = await conversationPageFor(db, owner, mirrored.conversation_id)
    assert.equal(disconnected.conversation.kind, 'guest')
    assert.deepEqual(disconnected.conversation.composer, { channel: 'airbnb' })
    assert.deepEqual(disconnected.entries.filter(entry => entry.type === 'message'), accepted)
    assert.equal(await db.prepare('SELECT count(*) FROM messages').first('count(*)'), 5, 'failed preflight records no outbound message')
  } finally { release(); globalThis.fetch = realFetch; await runtime.dispose() }
})

test('a scheduled Airbnb message and its provider echo appear once in the conversation', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    provider.messages = [provider.message('waiting-guest', 'guest', 'Can we check in early?')]
    const mirrored = await mirrorChannexThread(db, env, 'thread', 'property')
    if (mirrored.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    const threadId = mirrored.conversation_id
    const body = 'Your scheduled check-in instructions'
    const scheduled = await sendScheduledGuestReply(db, { threadId, organizationId: ORG, body, idempotencyKey: 'automatic-instructions', env })
    assert.equal(scheduled.outcome.ok, true)
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual((await hostMessages(db, env, threadId)).filter(entry => entry.body === body).map(entry => [entry.id, entry.author, entry.automatic]),
      [[scheduled.messageId, 'Automatic', true]])
    assert.deepEqual((await listThreadDeliveries(db, threadId)).filter(delivery => delivery.message_id === scheduled.messageId).map(delivery => [delivery.status, delivery.provider_message_id]),
      [['accepted', 'accepted-1']])
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

// A WhatsApp reply to an Airbnb conversation that fails, whether the reply operation throws or
// returns the failure, is never shown raw: the manager reads a fixed notice, and the message fails
// so Meta delivers it again, whose replay under the same key retries the reply without repeating it.
test('a failed WhatsApp reply tells the manager a fixed notice and fails the message for redelivery', async () => {
  const { runtime, db, env: base } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  const sent: string[] = []
  let failure: 'channex' | 'invariant' | null = null
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname === 'graph.facebook.com') {
      sent.push(JSON.parse(String(init.body)).text.body)
      return Response.json({ messages: [{ id: `meta-out-${sent.length}` }] })
    }
    if (failure === 'channex' && url.pathname === `/api/v1/message_threads/${provider.threadId}`) return new Response('<html>Bad gateway from upstream</html>', { status: 502 })
    return provider.fetch(input, init)
  }) as typeof fetch
  try {
    const env = { ...base, WHATSAPP_DELIVERY_MODE: 'provider', WHATSAPP_PHONE_NUMBER_ID: 'local-proof-phone-id', WHATSAPP_ACCESS_TOKEN: 'local-proof-no-live-token', WHATSAPP_APP_SECRET: 'whatsapp-secret' } as CloudflareEnv
    await db.prepare("UPDATE user SET phoneNumber = '+66812345678', phoneNumberVerified = 1 WHERE id = ?").bind(OWNER).run()
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('sub', 'growth', ?, 'active', ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86400).run()
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    const threadId = (await db.prepare('SELECT conversation_id AS conversation_id FROM channel_threads').first<{ conversation_id: string }>())!.conversation_id
    const entry = await appendMessage(db, { conversationId: threadId, authorKind: 'guest', authorUserId: null, channel: 'airbnb', body: 'Is there parking?', dedupeKey: 'whatsapp-alerted' })
    const alert = await createDeliveryReceipt(db, { subject: { messageId: entry.id }, channel: 'whatsapp', provider: 'meta', purpose: 'owner_alert', idempotencyKey: 'alert' })
    await recordDeliveryOutcome(db, { deliveryId: alert.id, status: 'sent', providerMessageId: 'meta-alert' })
    const app = new H3()
    app.post('/api/whatsapp/webhook', whatsappWebhook)
    let inbound = 0
    const write = async (text: string, quoting?: string) => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: `wamid-${++inbound}`, from: '66812345678', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...(quoting && { context: { id: quoting } }) }] } }] }] })
      return await app.request(Object.assign(new Request('https://proof.example/api/whatsapp/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'whatsapp-secret').update(body).digest('hex')}` }, body,
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    }

    const alerted = 'Reply not sent. The team has been alerted.'
    // Each failure: how it is made, the webhook status it reports with, the exact messages the manager
    // receives for that reply, and how many writes reached Airbnb.
    const cases = [
      // Channex answers with an HTML error page: a ChannexError the operation throws before writing.
      { mode: 'channex', notices: [alerted], writes: 0 },
      // Channex names a property that is not the home's: the operation's own 502 invariant.
      { mode: 'invariant', notices: [alerted], writes: 0 },
      // Airbnb refuses the message: a returned failure, never told in Channex's words.
      { mode: 'refused', notices: [alerted], writes: 1 },
      // The connection ended after Channex took it: a failed reply with Channex's error.
      { mode: 'uncertain', notices: [alerted], writes: 1 },
    ] as const
    for (const { mode, notices, writes } of cases) {
      failure = null
      Object.assign(provider, { propertyId: 'property', refuseMessage: false, uncertain: false })
      if (mode === 'channex') failure = 'channex'
      if (mode === 'invariant') provider.propertyId = 'another-property'
      if (mode === 'refused') provider.refuseMessage = true
      if (mode === 'uncertain') provider.uncertain = true
      const [sentBefore, writesBefore] = [sent.length, provider.sends]
      const failed = await write(`Reply for ${mode}`, 'meta-alert')
      assert.ok(failed.status >= 500, `${mode}: the failed reply fails the message, so Meta delivers it again (${failed.status})`)
      assert.deepEqual(sent.slice(sentBefore), notices, `${mode}: exactly these messages reach the manager, and nothing raw`)
      assert.equal(provider.sends - writesBefore, writes, `${mode}: writes that reached Airbnb`)
    }
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

// A guest's Airbnb photo reaches the owner's alert as the stored photo, under
// the conversation so far, and replying to that alert email answers on Airbnb
// as the owner. Only Channex's HTTP boundary is a stand-in; email is log-only,
// so the alert is read from its recorded delivery.
test('an Airbnb photo is in the owner alert, and replying to the alert answers the guest on Airbnb', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    provider.messages.push(provider.message('guest-photo', 'guest', 'The lock is jammed', ['/attachment/file']))
    await mirrorChannexMessageEvent(db, env, { event: 'message', property_id: 'property', payload: { id: 'guest-photo', message_thread_id: 'thread', property_id: 'property' } })
    const threadId = (await db.prepare('SELECT conversation_id AS conversation_id FROM channel_threads').first<{ conversation_id: string }>())!.conversation_id
    const photo = await db.prepare(`SELECT ma.public_url FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id JOIN messages e ON e.id = mp.owner_id
      WHERE e.dedupe_key = 'channex-message:guest-photo' AND mp.slot = 'attachments'`).first<string>('public_url')
    assert.match(photo!, /^https:\/\/media\.example\.test\//u)
    const alert = await db.prepare(`SELECT d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id
      WHERE e.dedupe_key = 'channex-message:guest-photo' AND d.channel = 'email' AND d.purpose = 'owner_alert'`).first<string>('email_json')
    const sent = JSON.parse(alert!).message as { to: string; subject: string; html: string; text: string; replyTo: string }
    assert.equal(sent.to, 'owner@example.test')
    assert.ok(sent.html.includes(`src="${photo}"`), 'the alert shows the photo as the media store serves it')
    assert.match(sent.text, /The lock is jammed/u)
    assert.match(sent.text, /Earlier in this conversation\s+[^:]+: Hello/u)
    assert.match(sent.text, /Reply to this email or from the dashboard\./u)
    assert.doesNotMatch(sent.text, /are not delivered/u)
    // The reply address names the guest's message the alert was about.
    const guestEntry = await db.prepare("SELECT id FROM messages WHERE dedupe_key = 'channex-message:guest-photo'").first<string>('id')
    const address = parseReplyToAddress(env, sent.replyTo)
    assert.deepEqual({ kind: address.kind, messageId: address.messageId }, { kind: 'member', messageId: guestEntry })

    // The owner replies to that email: the words reach the Airbnb conversation as the host's, once.
    const reply = { entryId: guestEntry!, token: address.token, from: 'owner@example.test', body: 'Lift the handle as you turn the key.', files: [], messageId: '<owner-reply-1@mail.example.test>' }
    await receiveMemberEmail(env, reply, unexpectedReport)
    assert.equal(provider.sends, 1)
    assert.equal(provider.messages.at(-1)!.attributes.message, 'Lift the handle as you turn the key.')
    const answered = await db.prepare("SELECT author_user_id, channel, body FROM messages WHERE conversation_id = ? AND event_name = 'thread.member_reply'").bind(threadId).all()
    assert.deepEqual(answered.results, [{ author_user_id: OWNER, channel: 'airbnb', body: 'Lift the handle as you turn the key.' }])
    // The same email delivered again sends nothing again.
    await receiveMemberEmail(env, reply, unexpectedReport)
    assert.equal(provider.sends, 1)

    // Another address replying with this signature, or one tampered with, bounces with the reason.
    await assert.rejects(receiveMemberEmail(env, { ...reply, from: 'someone@example.test', messageId: '<other@mail.example.test>' }, unexpectedReport), InboundEmailRejection)
    await assert.rejects(receiveMemberEmail(env, { ...reply, token: '0'.repeat(24), messageId: '<forged@mail.example.test>' }, unexpectedReport), InboundEmailRejection)
    // Airbnb takes a photo or words, not both: the owner is told so, and nothing is sent.
    await assert.rejects(receiveMemberEmail(env, { ...reply, files: [{ bytes: GUEST_PHOTO, filename: 'door.avif' }], messageId: '<both@mail.example.test>' }, unexpectedReport),
      (error: unknown) => error instanceof InboundEmailRejection && error.message === 'Reply not sent: Send one Airbnb photo at a time, separately from text')
    // The connection ends after Channex took the words: the reply failed, so the email's delivery fails
    // with Channex's error and its redelivery sends the reply again under the same key.
    provider.uncertain = true
    const lost = { ...reply, body: 'The spare key is under the mat.', messageId: '<lost@mail.example.test>' }
    await assert.rejects(receiveMemberEmail(env, lost, unexpectedReport), (error: unknown) => !(error instanceof InboundEmailRejection) && /CHANNEL_REPLY_FAILED/u.test(String((error as Error).message)))
    assert.equal(provider.sends, 2)
    provider.uncertain = false
    await receiveMemberEmail(env, lost, unexpectedReport)
    assert.equal(provider.sends, 3)
    // A member who has left the business is refused before anything is sent.
    await db.prepare("DELETE FROM member WHERE id = 'owner-member'").run()
    await assert.rejects(receiveMemberEmail(env, { ...reply, messageId: '<after-leaving@mail.example.test>' }, unexpectedReport),
      (error: unknown) => error instanceof InboundEmailRejection && error.message === 'Reply not sent: You are no longer a member of this business.')
    assert.equal(provider.sends, 3)
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})
