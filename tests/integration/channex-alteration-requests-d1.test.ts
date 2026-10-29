import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { applyBookingRevision } from '../../server/integrations/channex/booking-revisions.ts'
import { mirrorChannexThread } from '../../server/domain/guest-threads/channel-messages.ts'
import { runAlterationRequestFeed } from '../../server/domain/guest-threads/stay-change-requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// An Airbnb guest's change request, from Channex's live feed to the stay's
// conversation and back: recorded once and alerted, answered through
// POST /live_feed/{id}/resolve, the stay changed only by Airbnb's confirmed
// revision, and a request resolved on Airbnb reconciled from what Channex holds.

const ORG = 'org', OWNER = 'owner', PROPERTY = 'property'
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
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'alteration-requests-proof', exportName: 'Hub' } },
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
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'location', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
    } })
    await db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
      VALUES (?, ?, 'channex', 'listing', 'channel', ?, 'room', 'rate', 'complete', 1)`).bind(ORG, home.id, PROPERTY).run()
    return { runtime, db, env }
  } catch (error) { await runtime.dispose(); throw error }
}

/** An Airbnb booking landed from its revision, as Channex delivers it, with its conversation mirrored or not yet arrived. */
async function airbnbStay(db: D1Database, env: CloudflareEnv, channex: FakeChannex, conversation = true) {
  await applyBookingRevision(db, env, channex.revise('bk-1', { arrival: '2027-01-10', departure: '2027-01-13', adults: 2, amount: '450.00' }, 'new'))
  if (conversation) assert.equal((await mirrorChannexThread(db, env, 'thread', PROPERTY)).status, 'mirrored')
  const stay = await db.prepare("SELECT id, request_id FROM stays WHERE external_booking_id = 'bk-1'").first<{ id: string; request_id: string | null }>()
  assert.equal(stay!.request_id === null, !conversation)
  return stay!
}

const stayRow = (db: D1Database, id: string) => db.prepare('SELECT check_in_date, check_out_date, adults, total_minor, version FROM stays WHERE id = ?').bind(id).first()
const requests = (db: D1Database, threadId: string) => db.prepare("SELECT id, actor_kind, channel, json_extract(payload_json, '$.live_feed_event_id') AS event FROM activity_entries WHERE request_id = ? AND event_name = 'booking_change.requested' ORDER BY sequence").bind(threadId).all<{ id: string; actor_kind: string; channel: string; event: string }>().then(rows => rows.results)
const decision = (db: D1Database, requestId: string) => db.prepare("SELECT event_name, actor_kind, actor_user_id, body FROM activity_entries WHERE dedupe_key = ?").bind(`booking-change-decision:${requestId}`).first()
const alerts = (db: D1Database, requestId: string) => db.prepare("SELECT purpose, channel, status FROM guest_thread_deliveries WHERE entry_id = ? ORDER BY channel").bind(requestId).all().then(rows => rows.results)
const answer = (db: D1Database, env: CloudflareEnv, threadId: string, requestId: string, action: 'accept_change' | 'decline_change', stayManager = true) =>
  executeGuestThreadOperation(db, { threadId, organizationId: ORG, action, requestId, stayManager, actorUserId: OWNER, idempotencyKey: `${requestId}:${action}`, env })

test('a guest change request lands once in the stay conversation, survives a reload, and accepting resolves it on Channex and lands Airbnb’s revision', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex(), realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    // The request arrives before the booking's conversation: the thread it names is mirrored first.
    const { id: stayId } = await airbnbStay(db, env, channex, false)
    channex.requests.set('alt-1', { booking: 'bk-1', after: { arrival: '2027-01-10', departure: '2027-01-14', adults: 3, amount: '600.00' }, status: null })
    assert.deepEqual(await runAlterationRequestFeed(db, env, PROPERTY), { recorded: 1, reconciled: 0 })
    const stay = (await db.prepare('SELECT id, request_id FROM stays WHERE id = ?').bind(stayId).first<{ id: string; request_id: string }>())!
    assert.equal(typeof stay.request_id, 'string')
    // A repeated webhook or feed run records nothing twice and alerts nobody twice.
    assert.deepEqual(await runAlterationRequestFeed(db, env), { recorded: 0, reconciled: 0 })
    const [request, ...extra] = await requests(db, stay.request_id)
    assert.deepEqual([request && { actor_kind: request.actor_kind, channel: request.channel, event: request.event }, extra], [{ actor_kind: 'guest', channel: 'airbnb', event: 'alt-1' }, []])
    assert.deepEqual(await alerts(db, request!.id), [{ purpose: 'owner_alert', channel: 'email', status: 'sent' }])
    assert.equal((await db.prepare('SELECT conversation_state FROM requests WHERE id = ?').bind(stay.request_id).first('conversation_state')), 'needs_attention')

    // Read back as a fresh conversation load: pending, with the stay as it is and as the guest asked.
    const pending = (await getGuestThreadDetail(db, stay.request_id, ORG))!.entries.find(entry => entry.id === request!.id)!.bookingChange!
    assert.deepEqual({ status: pending.status, requestedBy: pending.requestedBy, channel: pending.channel, before: pending.before, after: pending.after, locationTitle: pending.locationTitle }, {
      status: 'pending', requestedBy: 'guest', channel: 'airbnb', locationTitle: 'Cabin',
      before: { whenLabel: 'Jan 10, 2027 – Jan 13, 2027', partySize: 2, totalLabel: '$450.00', assignedMemberId: null, assignedMemberName: null },
      after: { whenLabel: 'Jan 10, 2027 – Jan 14, 2027', partySize: 3, totalLabel: '$600.00', assignedMemberId: null, assignedMemberName: null },
    })
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-13', adults: 2, total_minor: 45_000, version: 1 })

    // A member who cannot change stays is refused before Channex hears anything.
    await assert.rejects(answer(db, env, stay.request_id, request!.id, 'accept_change', false), (error: unknown) => (error as { data?: { code?: string } }).data?.code === 'STAY_ROLE_REQUIRED')
    assert.deepEqual(channex.resolutions, [])

    const accepted = await answer(db, env, stay.request_id, request!.id, 'accept_change')
    assert.equal(accepted.ok, true)
    assert.deepEqual(channex.resolutions, [{ id: 'alt-1', body: { resolution: { accept: 'accept' } } }])
    assert.deepEqual(await decision(db, request!.id), { event_name: 'booking_change.accepted', actor_kind: 'member', actor_user_id: OWNER, body: 'Accepted the guest’s change on Airbnb.' })
    // Airbnb's confirmed revision is the change: landed and acknowledged, the stay now as the guest asked.
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-14', adults: 3, total_minor: 60_000, version: 2 })
    assert.deepEqual(channex.acked, ['rev-1', 'rev-2'])
    const answered = (await getGuestThreadDetail(db, stay.request_id, ORG))!.entries.find(entry => entry.id === request!.id)!.bookingChange!
    assert.equal(answered.status, 'accepted')

    // Answering again, or the feed seeing it resolved, changes nothing and sends nothing to Channex.
    assert.equal((await answer(db, env, stay.request_id, request!.id, 'accept_change')).ok, true)
    assert.deepEqual(await runAlterationRequestFeed(db, env), { recorded: 0, reconciled: 0 })
    assert.equal(channex.resolutions.length, 1)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('declining leaves the stay as it is; a request withdrawn or answered on Airbnb is reconciled from Channex, and one never seen pending is not recorded', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
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
    const recorded = new Map((await requests(db, stay.request_id!)).map(row => [row.event, row.id]))
    assert.deepEqual([...recorded.keys()].sort(), ['alt-answered', 'alt-decline', 'alt-host', 'alt-withdrawn'])
    const hostProposal = recorded.get('alt-host')!
    assert.deepEqual(await alerts(db, hostProposal), [])
    await assert.rejects(answer(db, env, stay.request_id!, hostProposal, 'accept_change'), (error: unknown) => (error as { data?: { code?: string } }).data?.code === 'CHANGE_REQUEST_AWAITS_GUEST')
    recorded.delete('alt-host')

    assert.equal((await answer(db, env, stay.request_id!, recorded.get('alt-decline')!, 'decline_change')).ok, true)
    assert.deepEqual(channex.resolutions, [{ id: 'alt-decline', body: { resolution: { accept: 'decline' } } }])
    assert.deepEqual(await decision(db, recorded.get('alt-decline')!), { event_name: 'booking_change.declined', actor_kind: 'member', actor_user_id: OWNER, body: 'Declined the guest’s change on Airbnb.' })
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-13', adults: 2, total_minor: 45_000, version: 1 })

    // The guest withdrew on Airbnb, which sends no notification: the next feed run reads it.
    // The host's own proposal, accepted by the guest there, reads as the guest's answer.
    channex.requests.get('alt-withdrawn')!.status = 'CANCELED'
    channex.requests.get('alt-host')!.status = 'ACCEPTED'
    assert.deepEqual(await runAlterationRequestFeed(db, env), { recorded: 0, reconciled: 2 })
    assert.deepEqual(await decision(db, recorded.get('alt-withdrawn')!), { event_name: 'booking_change.withdrawn', actor_kind: 'system', actor_user_id: null, body: 'The guest withdrew the change on Airbnb.' })
    assert.deepEqual(await decision(db, hostProposal), { event_name: 'booking_change.accepted', actor_kind: 'system', actor_user_id: null, body: 'The guest accepted the change on Airbnb.' })

    // Declined on Airbnb before the host answered here: the host's accept records Airbnb's outcome and is refused naming it.
    channex.requests.get('alt-answered')!.status = 'DECLINED'
    await assert.rejects(answer(db, env, stay.request_id!, recorded.get('alt-answered')!, 'accept_change'),
      (error: unknown) => (error as { data?: { code?: string; outcome?: string } }).data?.code === 'CHANGE_REQUEST_RESOLVED' && (error as { data: { outcome: string } }).data.outcome === 'declined')
    assert.deepEqual(await decision(db, recorded.get('alt-answered')!), { event_name: 'booking_change.declined', actor_kind: 'system', actor_user_id: null, body: 'The guest’s change was declined on Airbnb.' })
    assert.equal(channex.resolutions.length, 1)

    const views = new Map((await getGuestThreadDetail(db, stay.request_id!, ORG))!.entries.flatMap(entry => entry.bookingChange ? [[entry.id, entry.bookingChange.status]] : []))
    assert.deepEqual([...recorded].map(([event, id]) => [event, views.get(id)]).sort(), [['alt-answered', 'declined'], ['alt-decline', 'declined'], ['alt-withdrawn', 'withdrawn']])
    assert.deepEqual(await stayRow(db, stay.id), { check_in_date: '2027-01-10', check_out_date: '2027-01-13', adults: 2, total_minor: 45_000, version: 1 })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
