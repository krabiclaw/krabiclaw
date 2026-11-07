import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'h3'
import { createHmac } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import sharp from 'sharp'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyChannelBooking, createStay, type ChannelBooking } from '../../server/domain/stays.ts'
import { backfillChannexMessages, mirrorChannexMessageEvent, mirrorChannexThread } from '../../server/domain/guest-threads/channel-messages.ts'
import { executeGuestThreadOperation, sendScheduledGuestReply } from '../../server/domain/guest-threads/operations.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { getInboxThread } from '../../server/domain/guest-threads/inbox.ts'
import { executeBatch } from '../../server/db/index.ts'
import { conversationTaskQueries, expireReplyTasks, listGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { createDeliveryReceipt, recordDeliveryOutcome } from '../../server/domain/guest-threads/deliveries.ts'
import { getGuestRequest } from '../../server/domain/requests.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import todayRoute from '../../server/api/dashboard/today.get.ts'
import { closeTask, listTasks, reopenTask, parseTaskListQuery, taskViewer, type TaskSection } from '../../server/domain/tasks.ts'
import type { OpportunityView } from '../../server/domain/opportunities.ts'
import { guestThreadListPage, parseGuestThreadListQuery } from '../../server/utils/dashboard-guest-threads.ts'
import { assertAssignedBookingAccess, memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { listBusinessOutcomes } from '../../server/utils/business-outcomes.ts'
import whatsappWebhook from '../../server/api/whatsapp/webhook.post.ts'
import { getWhatsAppWorkspaceState } from '../../server/utils/mcp-context.ts'
import { useNitroHooks } from 'nitro/app'
import { ChannexError } from '../../server/integrations/channex/client.ts'

const ORG = 'org', OWNER = 'owner'
const NOW = '2026-10-16T00:00:00.000Z'
const RAW = '2026-10-15T23:12:00.123456'
/**
 * A real photo, what a guest's Airbnb attachment is once downloaded. AVIF is the
 * photo type the media store keeps in R2; JPEG and PNG go to Cloudflare Images,
 * which only production configures.
 */
const GUEST_PHOTO = Uint8Array.from(await sharp({ create: { width: 4, height: 3, channels: 3, background: '#16a34a' } }).avif().toBuffer())
type TodayPayload = { tasks: TaskSection[]; opportunities: OpportunityView[] }
/** Today in outline: each task as its kind and conversation, each opportunity as the operation it records. */
async function todayOutline(db: D1Database, today: TodayPayload) {
  const operations = new Map((await db.prepare('SELECT id, operation FROM opportunities WHERE organization_id = ?').bind(ORG).all<{ id: string; operation: string }>()).results.map(row => [row.id, row.operation]))
  return { tasks: today.tasks.flatMap(section => section.tasks.map(task => [task.kind, task.requestId])), opportunities: today.opportunities.map(opportunity => operations.get(opportunity.id)) }
}
/** The guest message each open reply task is about, by its ledger dedupe key, and the organization the task belongs to. */
const openReplies = (db: D1Database, threadId: string) => db.prepare(`SELECT t.organization_id, e.dedupe_key AS entry FROM tasks t JOIN activity_entries e ON t.dedupe_key = 'guest_reply:' || t.subject_id || ':' || e.id
  WHERE t.kind = 'guest_reply' AND t.subject_type = 'request' AND t.subject_id = ? AND t.status = 'open' ORDER BY e.sequence`).bind(threadId).all<{ organization_id: string; entry: string }>().then(rows => rows.results)
const waitingOn = async (db: D1Database, threadId: string) => (await openReplies(db, threadId)).map(row => row.entry)
/** The reply tasks on Today as the owner reads them at `now`: conversation and status line ("Asked 1d ago · home"). */
async function replyEyebrows(db: D1Database, env: CloudflareEnv, now: Date) {
  const viewer = await taskViewer(db, memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env }))
  return (await listTasks(db, viewer, parseTaskListQuery({}), now)).sections.flatMap(section => section.tasks).filter(task => task.kind === 'guest_reply').map(task => [task.requestId, task.statusLine])
}
const GROWTH = ['post.create', 'social.connect', 'article.create']
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
    const rows = await listGuestThreads(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'current' })
    assert.equal(rows.length, 1)
    // An unbooked Airbnb conversation with no guest name reads as the title Airbnb gave it, on the home it was asked about, with no dates invented.
    // Unread follows the owner alerts, and a backfilled history raises none.
    assert.deepEqual({ ...rows[0]!, time: undefined }, { id: rows[0]!.id, kind: 'guest', guestName: 'Conversation supplied by Airbnb', avatarInitial: 'C', channel: 'airbnb', home: 'Cabin', when: null,
      preview: 'Sent a photo', previewFrom: 'Airbnb Support', time: undefined, unread: false })
    assert.deepEqual(await listGuestThreads(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'past' }), [])
    assert.equal(await db.prepare('SELECT product_id FROM channel_threads WHERE request_id = ?').bind(rows[0]!.id).first('product_id'), productId)
    const detail = (await getGuestThreadDetail(db, rows[0]!.id, ORG))!
    assert.deepEqual([detail.operationalRecord, detail.guestEmail, detail.guestPhone, detail.guestName, detail.participantLabel, detail.conversationChannel], [null, null, null, null, 'Conversation supplied by Airbnb', 'airbnb'])
    assert.deepEqual(detail.entries.map(entry => [entry.body, entry.actorKind, entry.providerTimestamp]), [['Hello', 'guest', RAW], [null, 'system', RAW]])
    // Airbnb's photo is read once when the message lands and kept as the business's own media, placed on that message.
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    const stored = await db.prepare(`SELECT ma.id, ma.r2_key, ma.public_url FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id
      WHERE mp.owner_type = 'activity_entry' AND mp.owner_id = ? AND mp.slot = 'attachments' AND mp.status = 'active' AND ma.status = 'active'`).bind(detail.entries[1]!.id).all<{ id: string; r2_key: string; public_url: string }>()
    assert.equal(stored.results.length, 1)
    const photo = stored.results[0]!
    assert.ok(photo.public_url.startsWith('https://media.example.test/'), photo.public_url)
    const kept = await (await runtime.getR2Bucket('MEDIA_BUCKET')).get(photo.r2_key)
    assert.ok(kept)
    assert.deepEqual(new Uint8Array(await kept.arrayBuffer()), GUEST_PHOTO)
    assert.deepEqual(detail.entries[1]!.attachments.map(item => [item.id, item.url]), [[photo.id, photo.public_url]])
    assert.equal(detail.entries.some(entry => entry.attachments.some(item => item.url.startsWith('https://channex.test/'))), false, 'no Channex link reaches the conversation')
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
    const readToday = async () => {
      const response = await app.request(Object.assign(new Request('https://proof.example/api/dashboard/today?org=org', { headers: { authorization: `Bearer ${token}` } }),
        { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      assert.equal(response.status, 200)
      return await response.json() as TodayPayload
    }
    // The inquiry arrived just now and has no reply: it is due. Today shows its
    // recorded conversation title without inventing a guest identity.
    const today = await readToday()
    const replies = today.tasks.flatMap(section => section.tasks).filter(task => task.kind === 'guest_reply')
    assert.deepEqual(replies.map(task => ({ status: task.status, title: task.title, detail: task.detail, path: task.path, action: task.action, requestId: task.requestId, stayId: task.stayId, startsAt: task.startsAt, dueAt: task.dueAt, avatar: task.avatar })), [{
      status: 'open', title: 'Conversation supplied by Airbnb', detail: 'Hello', path: `/dashboard/org/messages/${rows[0]!.id}`, action: { type: 'open', label: 'Reply', path: `/dashboard/org/messages/${rows[0]!.id}` },
      requestId: rows[0]!.id, stayId: null, startsAt: null, dueAt: null, avatar: { initial: 'C', tone: 'warm' },
    }])
    assert.match(replies[0]!.statusLine!, /^Asked .+$/)
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
    // Mirrored again, the message finds its photo already placed: nothing is downloaded or stored twice.
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_type = 'activity_entry'").first('count(*)'), 1)
    assert.equal(await db.prepare('SELECT count(*) FROM media_assets').first('count(*)'), 1)
    await assert.rejects(mirrorChannexMessageEvent(db, env, { event: 'message', property_id: 'property', payload: { id: 'not-visible-yet', property_id: 'property', message_thread_id: 'thread' } }), code('CHANNEL_MESSAGE_NOT_READY'))
    provider.propertyId = 'another-property'
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('INVALID_PROVIDER_RESPONSE'))
    assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 1)
    provider.propertyId = 'property'
    provider.messages[0]!.attributes.message = 'Changed after recording'
    await assert.rejects(mirrorChannexThread(db, env, 'thread', 'property'), code('CHANNEL_MESSAGE_ID_CONFLICT'))
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('empty Channex host actions stay recorded without clearing reply work; a real photo reply clears it', async () => {
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
    const requestId = await db.prepare("SELECT request_id FROM channel_threads WHERE external_thread_id = 'thread'").first<string>('request_id')
    assert.ok(requestId)
    const recorded = await db.prepare("SELECT actor_kind, body FROM activity_entries WHERE dedupe_key = 'channex-message:host-action'").first<{ actor_kind: string; body: string | null }>()
    assert.deepEqual(recorded, { actor_kind: 'member', body: null })

    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:first'])

    const password = 'EmptyHostActionProof123!'
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('owner-credential', ?, 'credential', ?, ?, 0, 0)").bind(OWNER, OWNER, await hashPassword(password)).run()
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password }, asResponse: true })
    assert.equal(login.status, 200)
    const token = login.headers.get('set-auth-token')
    assert.ok(token)
    const app = new H3()
    app.get('/api/dashboard/today', todayRoute)
    const readToday = async () => {
      const response = await app.request(Object.assign(new Request('https://proof.example/api/dashboard/today?org=org', { headers: { authorization: `Bearer ${token}` } }),
        { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      assert.equal(response.status, 200)
      return await response.json() as TodayPayload
    }
    const afterEmpty = await readToday()
    assert.deepEqual(await todayOutline(db, afterEmpty), { tasks: [['guest_reply', requestId]], opportunities: GROWTH })

    // The conversation reads as the guest's words alone, and the list previews them.
    const owner = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const thread = (await getInboxThread(db, requestId, ORG, { audience: 'member', userId: OWNER, principal: owner }))!
    assert.deepEqual(thread.stream.filter(item => item.type === 'message').map(item => item.type === 'message' ? [item.side, item.body] : null), [['guest', 'Hello']])
    const [row] = await listGuestThreads(db, ORG, { userId: OWNER, type: 'stay', mailbox: 'current' })
    assert.deepEqual([row!.preview, row!.previewFrom], ['Hello', 'Conversation supplied by Airbnb'])

    // A webhook re-mirror of the same conversation records it once and still succeeds.
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE dedupe_key = 'channex-message:host-action'").first('count(*)'), 1)

    provider.messages.push(provider.message('blank-host-action', 'property', '   ', [], new Date(receivedAt + 2).toISOString()))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:first'])
    const afterBlank = await readToday()
    assert.deepEqual(await todayOutline(db, afterBlank), { tasks: [['guest_reply', requestId]], opportunities: GROWTH })

    // A real image-only host reply is downloaded and placed on its message.
    provider.messages.push(provider.message('host-photo', 'property', null, ['/attachment/file'], new Date(receivedAt + 3).toISOString()))
    await mirrorChannexThread(db, env, 'thread', 'property')
    const detail = (await getGuestThreadDetail(db, requestId, ORG))!
    const photoReply = detail.entries.find(entry => entry.body === null && entry.actorKind === 'member' && entry.attachments.length > 0)
    assert.ok(photoReply)
    assert.equal(photoReply.attachments.length, 1)
    assert.ok(photoReply.attachments[0]!.url.startsWith('https://media.example.test/'))
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    assert.deepEqual(await waitingOn(db, requestId), [])
    const afterPhoto = await readToday()
    // The reply closed its task today, so Today shows it done; the growth opportunities remain.
    assert.deepEqual(afterPhoto.tasks.flatMap(section => section.tasks).map(task => [task.kind, task.status, task.requestId]), [['guest_reply', 'done', requestId]])
    assert.deepEqual((await todayOutline(db, afterPhoto)).opportunities, GROWTH, 'the real photo reply clears only its reply task; useful growth opportunities remain')
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('a dismissed question needs no note and stays closed until the guest writes again; an unanswered one expires after 30 days', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
  try {
    const first = provider.message('first', 'guest', 'Hello', [], at(0))
    provider.messages = [first]
    await backfillChannexMessages(db, env, 'property', ORG)
    const requestId = await db.prepare("SELECT request_id FROM channel_threads WHERE external_thread_id = 'thread'").first<string>('request_id')
    assert.ok(requestId)
    const second = provider.message('second', 'guest', 'Are you there?', [], at(0))
    provider.messages = [first, second]
    await backfillChannexMessages(db, env, 'property', ORG)
    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:first'])

    const viewer = await taskViewer(db, memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env }))
    const taskId = await db.prepare("SELECT id FROM tasks WHERE kind = 'guest_reply' AND subject_id = ? AND status = 'open'").bind(requestId).first<string>('id')
    assert.ok(taskId)
    const dismissed = await closeTask(db, viewer, taskId, { status: 'skipped', note: '', photos: [], env })
    assert.deepEqual([dismissed.status, dismissed.outcome?.note, dismissed.action, dismissed.dismiss], ['skipped', null, { type: 'reopen', label: 'Undo' }, null])
    assert.match(dismissed.statusLine ?? '', /^Dismissed at /)
    assert.deepEqual(await db.prepare('SELECT status, outcome_note FROM tasks WHERE id = ?').bind(taskId).first(), { status: 'skipped', outcome_note: null })

    // Everything said before the dismissal stays closed, whatever touches the conversation next.
    await executeBatch(db, conversationTaskQueries(requestId, at(0)), { operation: 'Touch conversation' })
    assert.deepEqual(await waitingOn(db, requestId), [])

    const third = provider.message('third', 'guest', 'One more question', [], at(0))
    provider.messages = [first, second, third]
    await backfillChannexMessages(db, env, 'property', ORG)
    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:third'])

    // A message recorded at the dismissal's own instant is still something new to answer.
    const dismissedAt = await db.prepare('SELECT closed_at FROM tasks WHERE id = ?').bind(taskId).first<string>('closed_at')
    assert.ok(dismissedAt)
    await db.prepare("UPDATE activity_entries SET occurred_at = ? WHERE dedupe_key = 'channex-message:third'").bind(dismissedAt).run()
    await db.prepare("DELETE FROM tasks WHERE kind = 'guest_reply' AND subject_id = ? AND status = 'open'").bind(requestId).run()
    await executeBatch(db, conversationTaskQueries(requestId, at(0)), { operation: 'Touch conversation' })
    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:third'])

    // An omitted note dismisses the same way an empty one does.
    const thirdTask = await db.prepare("SELECT id FROM tasks WHERE kind = 'guest_reply' AND subject_id = ? AND status = 'open'").bind(requestId).first<string>('id')
    assert.ok(thirdTask)
    const omitted = await closeTask(db, viewer, thirdTask, { status: 'skipped', note: undefined, photos: [], env })
    assert.deepEqual(await db.prepare('SELECT status, outcome_note FROM tasks WHERE id = ?').bind(thirdTask).first(), { status: 'skipped', outcome_note: null })
    await reopenTask(db, viewer, thirdTask, { expectedVersion: omitted.version })
    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:third'])

    // Thirty-one days on the open question has aged out, and the newer one behind it becomes the work.
    const fourth = provider.message('fourth', 'guest', 'Still hoping to hear back', [], at(29))
    provider.messages = [first, second, third, fourth]
    await backfillChannexMessages(db, env, 'property', ORG)
    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:third'])
    assert.deepEqual(await expireReplyTasks(db, at(31)), { conversations: 1 })
    assert.deepEqual(await waitingOn(db, requestId), ['channex-message:fourth'])
    const expired = await db.prepare("SELECT status, closed_by_user_id FROM tasks WHERE dedupe_key LIKE 'guest_reply:%' AND subject_id = ? AND status <> 'open' AND status <> 'skipped'").bind(requestId).first()
    assert.deepEqual(expired, { status: 'cancelled', closed_by_user_id: null })

    // Nothing left to expire closes nothing, and an aged question does not reopen when the conversation is touched.
    assert.deepEqual(await expireReplyTasks(db, at(31)), { conversations: 0 })
    assert.deepEqual(await expireReplyTasks(db, at(60)), { conversations: 1 })
    await executeBatch(db, conversationTaskQueries(requestId, at(60)), { operation: 'Touch conversation' })
    assert.deepEqual(await waitingOn(db, requestId), [])
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
    const requestId = await db.prepare("SELECT request_id FROM channel_threads WHERE external_thread_id = 'thread'").first<string>('request_id')
    assert.ok(requestId)
    const recorded = await appendEntry(db, {
      threadId: requestId, kind: 'message', actorKind: 'system', channel: 'airbnb', body: null, eventName: 'channel.message_mirrored', dedupeKey: 'channex-message:second',
      payloadJson: { provider_message_id: 'second', provider_inserted_at: RAW, provider_updated_at: RAW, attachments: ['https://channex.test/attachment/file'], meta: { inquiry: true } },
    })
    const placements = () => db.prepare("SELECT count(*) AS n FROM media_placements WHERE owner_type = 'activity_entry' AND owner_id = ? AND slot = 'attachments' AND status = 'active'").bind(recorded.id).first<number>('n')
    assert.equal(await placements(), 0)
    assert.deepEqual(provider.fileReads, [])

    // The backfill finds the recorded message and stores its photo on it.
    provider.messages = [provider.messages[0]!, attachmentMessage]
    assert.deepEqual(await backfillChannexMessages(db, env, 'property', ORG), { threads: 1 })
    assert.equal(await placements(), 1)
    assert.deepEqual(provider.fileReads, ['/attachment/file'])
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE dedupe_key = 'channex-message:second'").first('count(*)'), 1)
    const [photo] = (await getGuestThreadDetail(db, requestId, ORG))!.entries.find(entry => entry.id === recorded.id)!.attachments
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
    const payload = JSON.stringify({ guest: { name: 'Guest', email: 'guest@example.test', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null })
    for (const id of ['e', 'c', 'b', 'd', 'a']) {
      await db.prepare("INSERT INTO requests (id, kind, organization_id, payload_json, created_at, updated_at) VALUES (?, 'contact', ?, ?, ?, ?)").bind(id, ORG, payload, NOW, NOW).run()
    }
    const first = guestThreadListPage(await listGuestThreads(db, ORG, { userId: OWNER, limit: 4, offset: 0 }), { limit: 3, offset: 0 })
    assert.deepEqual(first.threads.map(thread => thread.id), ['a', 'b', 'c'])
    assert.deepEqual(first.pagination, { limit: 3, offset: 0, hasMore: true, nextOffset: 3 })
    const last = guestThreadListPage(await listGuestThreads(db, ORG, { userId: OWNER, limit: 4, offset: 3 }), { limit: 3, offset: 3 })
    assert.deepEqual(last.threads.map(thread => thread.id), ['d', 'e'])
    assert.deepEqual(last.pagination, { limit: 3, offset: 3, hasMore: false, nextOffset: null })
    for (const [query, field] of [[{ limit: '0' }, 'limit'], [{ limit: '101' }, 'limit'], [{ offset: '-1' }, 'offset'], [{ limit: ['3'] }, 'limit'],
      [{ type: 'everything' }, 'type'], [{ conversation_state: 'resolved' }, 'conversation_state'], [{ kind: 'team' }, 'kind'], [{ q: 'x'.repeat(201) }, 'q'], [{ mailbox: ['past'] }, 'mailbox'], [{ unread: 'yes' }, 'unread'], [{ location_id: ' ' }, 'location_id'], [{ organization_id: 'org' }, 'organization_id']] as const) {
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
        product_id: productId, idempotency_key: 'hostaway:imported-ota', guest_name: 'Actual', guest_surname: 'Guest', guest_email: 'actual@example.test',
        check_in_date: terms.check_in_date, check_out_date: terms.check_out_date, adults: terms.adults, total_minor: terms.total_minor,
      }, { imported: { source: 'hostaway', source_id: 'imported-ota', row: { id: 'imported-ota' }, fingerprint: 'imported-ota-fingerprint', channel: terms.channel, channel_booking_id: terms.channel_booking_id } }) : null
      if (imported) {
        assert.equal(imported.request_id, null, 'an imported OTA contact does not open a direct conversation')
        assert.equal(await db.prepare('SELECT count(*) FROM requests').first('count(*)'), 0)
      }
      provider.bookingId = 'booking'
      let stay = first === 'booking' ? await applyChannelBooking(db, env, ORG, productId, booking()) : null
      if (stay) assert.equal(stay.request_id, null)
      await mirrorChannexMessageEvent(db, env, { event: 'message_thread_booking_assigned', property_id: 'property', payload: { booking_id: 'booking', message_thread_id: 'thread' } })
      const requestId = (await db.prepare('SELECT request_id FROM channel_threads').first<string>('request_id'))!
      const historical = await appendEntry(db, { threadId: requestId, kind: 'message', actorKind: 'member', actorUserId: OWNER, body: 'Recorded history', channel: 'email', dedupeKey: 'history' })
      const receipt = await createDeliveryReceipt(db, { entryId: historical.id, channel: 'email', provider: 'resend', purpose: 'member_reply', idempotencyKey: 'historical-delivery' })
      stay = await applyChannelBooking(db, env, ORG, productId, { ...booking(), revision_id: 'revision-2', provider_updated_at: '2026-10-16T01:00:00Z' })
      assert.equal(stay.request_id, requestId)
      if (imported) {
        assert.equal(stay.id, imported.id, 'the channel revision adopts the imported stay')
        assert.deepEqual(await db.prepare('SELECT owner, request_id FROM stays WHERE id = ?').bind(imported.id).first(), { owner: 'channel', request_id: requestId })
      }
      assert.equal(await db.prepare('SELECT count(*) FROM stays').first('count(*)'), 1)
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
    await db.prepare(`INSERT INTO requests (id, kind, organization_id, location_id, payload_json, created_at, updated_at)
      VALUES ('history', 'stay', ?, 'location', ?, ?, ?)`).bind(ORG, JSON.stringify({ guest: { name: 'Recorded contact', email: 'recorded@example.test', phone: null } }), NOW, NOW).run()
    await db.prepare("UPDATE stays SET request_id = 'history' WHERE id = ?").bind(stay.id).run()
    await appendEntry(db, { threadId: 'history', kind: 'message', actorKind: 'guest', channel: 'email', body: 'Historical message', dedupeKey: 'old' })
    const input = { threadId: 'history', organizationId: ORG, action: 'reply', body: 'Hello', idempotencyKey: 'unaddressable', actorUserId: OWNER, env }
    // A channel stay with no addressable conversation is nowhere to reply, refused before anything is recorded or sent.
    assert.deepEqual(await executeGuestThreadOperation(db, input), { ok: false, status: 409, reason: 'guest_unreachable', code: 'GUEST_UNREACHABLE', field: 'request_id', message: 'This Airbnb stay has no conversation to reply in yet.' })
    provider.bookingId = 'booking'
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.equal(await db.prepare('SELECT request_id FROM channel_threads').first('request_id'), 'history')
    assert.equal((await getGuestThreadDetail(db, 'history', ORG))!.guestName, 'Recorded contact')
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 3)
    await db.prepare(`INSERT INTO requests (id, kind, organization_id, location_id, payload_json, created_at, updated_at)
      VALUES ('other', 'stay', ?, 'location', ?, ?, ?)`).bind(ORG, JSON.stringify({ guest: { name: 'Other contact', email: 'other@example.test', phone: null } }), NOW, NOW).run()
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
    // Mirroring keeps the photos Channex holds that KrabiClaw does not: the guest's, and the echo of the uncertain reply whose
    // identity was never learned. The echo of the accepted reply is that reply's own photo, already stored, and is not read again.
    assert.deepEqual(provider.fileReads, ['/attachment/file', '/api/v1/attachments/photo-2'])
    const mirroredPhotos = 2
    assert.equal(await db.prepare('SELECT count(*) FROM media_assets').first('count(*)'), 2 + mirroredPhotos)

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
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 3 + mirroredPhotos, 'the losing request retains no active orphan media asset')
    assert.equal((await (await runtime.getR2Bucket('MEDIA_BUCKET')).list({ prefix: `organizations/${ORG}/media/` })).objects.length, 3 + mirroredPhotos, 'only the three retained reply photos and the mirrored photos remain stored')
    assert.equal(await db.prepare("SELECT count(*) FROM media_placements WHERE owner_type = 'activity_entry'").first('count(*)'), 3 + mirroredPhotos)
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
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 4 + mirroredPhotos, 'retry reuses the retained photo')

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
    assert.equal(await db.prepare("SELECT count(*) FROM media_assets WHERE status = 'active'").first('count(*)'), 5 + mirroredPhotos)
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
    // A new reply to a disconnected home is nowhere to send, refused before anything is recorded or sent.
    assert.deepEqual(await executeGuestThreadOperation(db, { ...input, idempotencyKey: 'disconnected-new', body: 'Not attempted' }),
      { ok: false, status: 409, reason: 'guest_unreachable', code: 'GUEST_UNREACHABLE', field: 'request_id', message: 'This home is disconnected from Airbnb, so its guest cannot be replied to here.' })
    // The inbox reads the same rule: a disconnected home's Airbnb conversation shows no composer, and says why.
    const owner = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    assert.deepEqual((await getInboxThread(db, mirrored.request_id, ORG, { audience: 'member', userId: OWNER, principal: owner }))!.composer,
      { channel: 'airbnb', available: false, reason: 'This home is disconnected from Airbnb, so its guest cannot be replied to here.' })
    assert.equal(await db.prepare('SELECT count(*) FROM activity_entries WHERE request_id IS NOT NULL').first('count(*)'), 6, 'failed preflight records no outbound message')
  } finally { release(); globalThis.fetch = realFetch; await runtime.dispose() }
})

test('customer work follows actual provider replies, keeps the first waiting instant, and survives failed or automatic sends', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    provider.messages = [provider.message('waiting-guest', 'guest', 'Can we check in early?', [], '2026-10-15T23:12:00.123456')]
    const mirrored = await mirrorChannexThread(db, env, 'thread', 'property')
    if (mirrored.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    const threadId = mirrored.request_id
    const waiting = () => waitingOn(db, threadId)
    const first = 'channex-message:waiting-guest'
    assert.deepEqual(await openReplies(db, threadId), [{ organization_id: ORG, entry: first }], 'the reply task belongs to the organization that owns the conversation')

    provider.messages.push(provider.message('followup-guest', 'guest', 'We would arrive at noon.', [], '2026-10-15T23:13:00.123456'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await waiting(), [first], 'a follow-up does not reset how long this customer has waited')

    // An old provider resource can first become visible during a later pull.
    provider.messages.unshift(provider.message('historical-host', 'property', 'A previous conversation reply', [], '2026-10-15T23:10:00.123456'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await waiting(), [first], 'late-imported history cannot answer a newer guest message')

    provider.refuseMessage = true
    const failed = await executeGuestThreadOperation(db, { threadId, organizationId: ORG, action: 'reply', body: 'An attempted reply', idempotencyKey: 'failed-response', actorUserId: OWNER, env })
    assert.equal(failed.ok, false)
    assert.deepEqual(await waiting(), [first], 'a failed delivery leaves the guest waiting')
    provider.refuseMessage = false

    const logged = await appendEntry(db, { threadId, kind: 'message', actorKind: 'member', actorUserId: OWNER,
      channel: 'email', eventName: 'thread.member_reply', body: 'Logged response only', dedupeKey: 'logged-response-only' })
    const loggedReceipt = await createDeliveryReceipt(db, { entryId: logged.id, channel: 'email', provider: 'log_only', purpose: 'member_reply', idempotencyKey: 'logged-response-only' })
    await recordDeliveryOutcome(db, { deliveryId: loggedReceipt.id, status: 'sent', providerMessageId: 'log-only:response' })
    assert.deepEqual(await waiting(), [first], 'a log-only send does not reach the guest')
    provider.replyAt = '2026-10-15T23:13:30.123456'
    const automatic = await sendScheduledGuestReply(db, { threadId, organizationId: ORG, body: 'Your scheduled check-in instructions', idempotencyKey: 'automatic-instructions', env })
    assert.equal(automatic.outcome.ok, true)
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await waiting(), [first], 'a template and its mirrored provider echo are not a response to this question')

    provider.messages.push(provider.message('answered-on-airbnb', 'property', 'Yes, noon is fine.', [], '2026-10-15T23:14:00.123456'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await waiting(), [], 'the actual host response on Airbnb clears the outstanding reply')

    provider.messages.push(provider.message('new-guest-question', 'guest', 'Can we leave our bags later?', [], '2026-10-15T23:15:00.123456'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    const newFirst = 'channex-message:new-guest-question'
    assert.deepEqual(await waiting(), [newFirst], 'new guest work reopens after a successful response')
    provider.messages.push(provider.message('airbnb-agent', 'agent', 'Support has updated the thread.', [], '2026-10-15T23:16:00.123456'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await waiting(), [newFirst], 'Airbnb Support is not a business response to the customer')

    provider.replyAt = '2026-10-15T23:17:00.123456'
    const replied = await executeGuestThreadOperation(db, { threadId, organizationId: ORG, action: 'reply', body: 'Yes, we can store them.', idempotencyKey: 'successful-response', actorUserId: OWNER, env })
    assert.equal(replied.ok, true)
    assert.deepEqual(await waiting(), [], 'a provider-accepted reply made through KrabiClaw also clears the work')
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

test('explicit provider instants order replies across offsets without losing submillisecond precision', async () => {
  const { runtime, db, env } = await boot()
  const provider = new Provider(), realFetch = globalThis.fetch
  globalThis.fetch = provider.fetch as typeof fetch
  try {
    provider.messages = [provider.message('offset-guest', 'guest', 'Are you open?', [], '2026-10-15T23:12:00.123456+07:00')]
    const mirrored = await mirrorChannexThread(db, env, 'thread', 'property')
    if (mirrored.status !== 'mirrored') throw new Error('Expected mapped inquiry')
    assert.deepEqual(await waitingOn(db, mirrored.request_id), ['channex-message:offset-guest'])
    // Asked at 2026-10-15T16:12:00.123Z by its explicit offset; read exactly a day later it is a day old, however recently it was imported.
    assert.deepEqual(await replyEyebrows(db, env, new Date('2026-10-16T16:12:00.123Z')), [[mirrored.request_id, 'Asked 1d ago · Cabin']], 'an explicit original instant supplies the waiting age instead of the later import time')
    provider.messages.push(provider.message('offset-answer', 'property', 'Yes.', [], '2026-10-15T16:12:00.123457Z'))
    await mirrorChannexThread(db, env, 'thread', 'property')
    assert.deepEqual(await waitingOn(db, mirrored.request_id), [])
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})

// A WhatsApp reply to an Airbnb conversation that fails, whether the reply operation throws or
// returns the failure, is never shown raw: the manager reads a fixed notice (or that it may have
// reached the guest), the pending reply is cleared, and the failure is reported through the error
// hook while the message is answered, so Meta's redelivery runs nothing again.
test('a failed WhatsApp reply tells the manager a fixed notice and reports the failure', async () => {
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
    const threadId = (await db.prepare('SELECT request_id FROM channel_threads').first<{ request_id: string }>())!.request_id
    const entry = await appendEntry(db, { threadId, kind: 'message', actorKind: 'guest', channel: 'airbnb', body: 'Is there parking?', dedupeKey: 'whatsapp-alerted' })
    const alert = await createDeliveryReceipt(db, { entryId: entry.id, channel: 'whatsapp', provider: 'meta', purpose: 'owner_alert', idempotencyKey: 'alert' })
    await recordDeliveryOutcome(db, { deliveryId: alert.id, status: 'sent', providerMessageId: 'meta-alert' })
    const app = new H3()
    app.post('/api/whatsapp/webhook', whatsappWebhook)
    let inbound = 0
    const write = async (text: string, quoting?: string) => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: `wamid-${++inbound}`, from: '66812345678', type: 'text', text: { body: text }, ...(quoting && { context: { id: quoting } }) }] } }] }] })
      return await app.request(Object.assign(new Request('https://proof.example/api/whatsapp/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'whatsapp-secret').update(body).digest('hex')}` }, body,
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    }
    const pending = async () => (await getWhatsAppWorkspaceState(db, OWNER))?.pending_confirmation ?? null

    const alerted = 'Reply not sent. The team has been alerted.'
    const mayHaveReached = 'This reply may have reached the guest. Check the conversation before sending again.'
    // Each failure: how it is made, the webhook status it reports with, the exact messages the manager
    // receives for that YES, and how many writes reached Airbnb.
    const reported: unknown[] = []
    useNitroHooks().hook('error', error => { reported.push(error) })
    const cases = [
      // Channex answers with an HTML error page: a ChannexError the operation throws before writing.
      { mode: 'channex', notices: [alerted], writes: 0, reports: (error: unknown) => error instanceof ChannexError },
      // Channex names a property that is not the home's: the operation's own 502 invariant.
      { mode: 'invariant', notices: [alerted], writes: 0, reports: code('INVALID_PROVIDER_RESPONSE') },
      // Airbnb refuses the message: a returned failure, never told in Channex's words.
      { mode: 'refused', notices: [alerted], writes: 1, reports: (error: unknown) => /CHANNEL_REPLY_FAILED/u.test(String((error as Error).message)) },
      // Airbnb took the message but the connection ended: it may be with the guest.
      { mode: 'uncertain', notices: [mayHaveReached], writes: 1, reports: (error: unknown) => /CHANNEL_REPLY_UNCERTAIN/u.test(String((error as Error).message)) },
    ] as const
    for (const { mode, notices, writes, reports } of cases) {
      failure = null
      Object.assign(provider, { propertyId: 'property', refuseMessage: false, uncertain: false })
      assert.equal((await write(`Reply for ${mode}`, 'meta-alert')).status, 200)
      assert.equal(sent.at(-1), 'This reply will be sent through Airbnb. Reply YES to send.')
      if (mode === 'channex') failure = 'channex'
      if (mode === 'invariant') provider.propertyId = 'another-property'
      if (mode === 'refused') provider.refuseMessage = true
      if (mode === 'uncertain') provider.uncertain = true
      const [sentBefore, writesBefore, reportedBefore] = [sent.length, provider.sends, reported.length]
      const confirmed = await write('YES')
      assert.equal(confirmed.status, 200, `${mode}: the message is answered, so Meta does not redeliver it`)
      assert.equal(reported.length - reportedBefore, 1, `${mode}: the failure is reported once`)
      assert.ok(reports(reported.at(-1)), `${mode}: the reported error is the reply's own`)
      assert.deepEqual(sent.slice(sentBefore), notices, `${mode}: exactly these messages reach the manager, and nothing raw`)
      assert.equal(await pending(), null, `${mode}: the pending reply is cleared`)
      assert.equal(provider.sends - writesBefore, writes, `${mode}: writes that reached Airbnb`)
    }
  } finally { globalThis.fetch = realFetch; await runtime.dispose() }
})
