import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { claimSessionCapacity } from '../../server/utils/availability.ts'
import { storeCalendarSelection, syncCalendarOrganization } from '../../server/utils/google-calendar.ts'
import { ensureCalendarWatch, pullCalendarChanges, readCalendarSync, resolveCalendarChannel, setCalendarReschedules, stopCalendarWatch } from '../../server/utils/google-calendar-inbound.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

/**
 * The business calendar moved, deleted and put back: an event dragged in
 * Google moves its booking through the booking-move operation; a move the
 * booking cannot follow and a deletion leave the booking as it is, raise its
 * conversation and are written back; Google's change list is the feed and a
 * forgotten position is read again from the start.
 */
test('an event moved in Google moves its booking; a refused move or a deletion is written back and raised', { timeout: 120_000 }, async (t) => {
  const mf = new Miniflare({ workers: [{ config: {
    name: 'calendar-inbound-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'calendar-inbound-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await mf.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization(id,name,slug,default_currency,timezone,vertical) VALUES('org','Cedar','org','USD','America/New_York','service')").run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    // Google Calendar sync is Business; the plan is the organization's subscription.
    await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,periodEnd) VALUES('sub-org','business','org','active',4070908800)").run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','p','org','Consultation','consultation','actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('v','org','p','Consultation','actor','actor')").run()
    await db.prepare("INSERT INTO product_publications(product_id,organization_id,published,created_by,updated_by) VALUES('p','org',1,'actor','actor')").run()
    await db.prepare("INSERT OR IGNORE INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.test',1),('owner','Owner','owner@example.test',1)").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('host-org','org','host','member',1),('owner-org','org','owner','owner',1)").run()
    await db.prepare(`INSERT INTO member_scheduling(member_id,organization_id,timezone,weekly_json,time_off_json,windows_json,windows_until,calendar_revision,updated_at,updated_by) VALUES('host-org','org','UTC','[]','[]','[{"start":"2020-01-01T00:00:00.000Z","end":"2100-01-01T00:00:00.000Z"}]','2100-01-01T00:00:00.000Z','rev','2026-01-01T00:00:00.000Z','actor')`).run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,duration_minutes,held_online,scheduling_mode,assigned_member_id,confirmation_mode,created_by,updated_by) VALUES('p','org',30,1,'provider','host-org','review','actor','actor')").run()
    // Two bookable times a month out, half an hour apart; nothing starts at 16:00.
    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    const at = (time: string) => `${day}T${time}:00.000Z`
    for (const [id, start, end] of [['s', at('14:00'), at('14:30')], ['s2', at('15:00'), at('15:30')]]) {
      await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES(?,'org','p','host-org','America/New_York',?,?,1,'actor','actor')").bind(id, start, end).run()
    }
    await db.prepare(`INSERT INTO requests(id,kind,organization_id,conversation_state,payload_json) VALUES('thread','booking','org','resolved','{"guest":{"name":"Jane Doe","email":"jane@example.test","phone":null},"notes":null,"party_size_is_minimum":false,"ip_hash":null,"cancellation":{"token_hash":null,"expires_at":null,"used_at":null}}')`).run()
    const { bookingId } = await claimSessionCapacity(db, { organizationId: 'org', productId: 'p', sessionId: 's', productVariantId: 'v', partySize: 1, requestId: 'thread' })
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'KrabiClaw' })
    const env = { ...await mf.getBindings<CloudflareEnv>(), BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test', EMAIL_REPLY_SECRET: 'reply-secret', EMAIL_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    const provider = { token: async () => 'token' }

    // Google, as the outbound pass and the change list see it.
    const events = new Map<string, Record<string, unknown>>()
    let changes: Array<Record<string, unknown>> = []
    let forgetPosition = false
    const calls: string[] = []
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input))
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token')
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname.includes('/calendarList/')) return Response.json({ accessRole: 'writer' })
      if (url.pathname.endsWith('/events/watch')) return Response.json({ resourceId: 'resource-1', expiration: String(Date.now() + 7 * 86_400_000) })
      if (url.pathname.endsWith('/channels/stop')) return new Response(null, { status: 204 })
      if (init?.method === 'GET' || init?.method === undefined) {
        assert.equal(url.searchParams.get('showDeleted'), 'true')
        if (url.searchParams.get('syncToken') && forgetPosition) { forgetPosition = false; return new Response(null, { status: 410 }) }
        const items = url.searchParams.get('syncToken') ? changes : [...events.entries()].map(([id, event]) => ({ id, status: 'confirmed', ...event }))
        changes = []
        return Response.json({ items, nextSyncToken: `token-${calls.length}` })
      }
      const payload = init?.body ? JSON.parse(String(init.body)) : null
      const id = init?.method === 'POST' ? payload.id : url.pathname.split('/').at(-1)!
      if (init?.method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }) }
      if (init?.method === 'POST' && events.has(id)) return new Response(null, { status: 409 })
      events.set(id, payload)
      return Response.json({ id })
    })

    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    const link = (await db.prepare('SELECT * FROM google_calendar_event_links').first())!
    const eventId = String(link.event_id)
    assert.equal(events.get(eventId)?.status, 'confirmed')

    // Connecting opens the channel and takes the position; the unchanged event changes nothing.
    await ensureCalendarWatch(env, 'org', provider)
    const sync = (await db.prepare('SELECT * FROM google_calendar_sync').first())!
    assert.ok(sync.channel_id && sync.channel_token && sync.sync_token)
    assert.equal(sync.resource_id, 'resource-1')
    assert.equal(await resolveCalendarChannel(db, String(sync.channel_id), String(sync.channel_token)), 'org')
    assert.equal(await resolveCalendarChannel(db, String(sync.channel_id), 'forged'), null)
    assert.equal((await readCalendarSync(db, 'org'))?.reschedules, true)
    assert.equal(await db.prepare('SELECT count(*) n FROM channel_sync_log').first('n'), 0)
    assert.equal(calls.filter(call => call.endsWith('/events/watch')).length, 1)
    await ensureCalendarWatch(env, 'org', provider)
    assert.equal(calls.filter(call => call.endsWith('/events/watch')).length, 1, 'a live channel is not reopened')

    // Dragged to 15:00 in Google: the booking takes the session that starts then, and the guest is told.
    changes = [{ id: eventId, status: 'confirmed', updated: 'u1', start: { dateTime: at('15:00') }, end: { dateTime: at('15:30') } }]
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 1, applied: 1, reviewed: 0 })
    assert.equal((await db.prepare('SELECT product_session_id FROM bookings WHERE id=?').bind(bookingId).first())?.product_session_id, 's2')
    assert.equal((await db.prepare("SELECT assigned_member_id FROM product_sessions WHERE id='s2'").first())?.assigned_member_id, 'host-org')
    const moved = await db.prepare("SELECT actor_kind, body, event_name FROM activity_entries WHERE request_id='thread' AND event_name='booking_change.moved'").first()
    assert.equal(moved?.actor_kind, 'system')
    assert.match(String(moved?.body), /from Google Calendar/)
    assert.equal((await db.prepare("SELECT conversation_state FROM requests WHERE id='thread'").first())?.conversation_state, 'resolved')
    assert.deepEqual(await db.prepare("SELECT provider, kind, external_id, status FROM channel_sync_log ORDER BY rowid").all().then(r => r.results), [{ provider: 'google_calendar', kind: 'calendar_event', external_id: eventId, status: 'applied' }])
    // The same Google change read twice moves nothing twice.
    changes = [{ id: eventId, status: 'confirmed', updated: 'u1', start: { dateTime: at('15:00') }, end: { dateTime: at('15:30') } }]
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 1, applied: 0, reviewed: 0 })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.deepEqual(events.get(eventId)?.start, { dateTime: at('15:00'), timeZone: 'America/New_York' })

    // Dragged to 16:00, where nothing can be booked: the booking stays, the event goes back, the owners decide.
    changes = [{ id: eventId, status: 'confirmed', updated: 'u2', start: { dateTime: at('16:00') }, end: { dateTime: at('16:30') } }]
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 1, applied: 0, reviewed: 1 })
    assert.equal((await db.prepare('SELECT product_session_id FROM bookings WHERE id=?').bind(bookingId).first())?.product_session_id, 's2')
    const refused = await db.prepare("SELECT body, payload_json FROM activity_entries WHERE request_id='thread' AND event_name='calendar_sync.move_refused'").first()
    assert.match(String(refused?.body), /could not follow: Nothing can be booked at/)
    assert.equal((await db.prepare("SELECT conversation_state FROM requests WHERE id='thread'").first())?.conversation_state, 'needs_attention')
    assert.equal((await db.prepare('SELECT state, synced_revision FROM google_calendar_event_links').first())?.state, 'pending')
    events.get(eventId)!.start = { dateTime: at('16:00') }
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.deepEqual(events.get(eventId)?.start, { dateTime: at('15:00'), timeZone: 'America/New_York' }, 'the event is written back from the booking')

    // Deleted in Google: never a cancellation. The event comes back and the owners are told once.
    changes = [{ id: eventId, status: 'cancelled', updated: 'u3' }]
    events.delete(eventId)
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 1, applied: 0, reviewed: 1 })
    assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(bookingId).first())?.status, 'pending')
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='thread' AND event_name='calendar_sync.event_deleted'").first('n'), 1)
    changes = [{ id: eventId, status: 'cancelled', updated: 'u3' }]
    await pullCalendarChanges(env, 'org', provider)
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='thread' AND event_name='calendar_sync.event_deleted'").first('n'), 1, 'one Google change raises one entry')
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.get(eventId)?.status, 'confirmed')
    assert.deepEqual(events.get(eventId)?.start, { dateTime: at('15:00'), timeZone: 'America/New_York' })
    assert.deepEqual((await db.prepare("SELECT status, detail FROM channel_sync_log WHERE status='needs_review' ORDER BY rowid").all()).results.map(row => String(row.detail).split(';')[0]), [`Nothing can be booked at ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at('16:00')))}`, 'deleted in Google Calendar'])
    // The owners were told once each, by the one notification path.
    assert.deepEqual((await db.prepare("SELECT event_name FROM activity_entries WHERE kind='notification' AND organization_id='org' ORDER BY rowid").all()).results.map(row => row.event_name), ['calendar_sync.move_refused', 'calendar_sync.event_deleted'])

    // Reschedules off: Google's move is undone rather than applied.
    await setCalendarReschedules(db, 'org', false)
    changes = [{ id: eventId, status: 'confirmed', updated: 'u4', start: { dateTime: at('14:00') }, end: { dateTime: at('14:30') } }]
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 1, applied: 1, reviewed: 0 })
    assert.equal((await db.prepare('SELECT product_session_id FROM bookings WHERE id=?').bind(bookingId).first())?.product_session_id, 's2')
    assert.equal((await db.prepare("SELECT status FROM channel_sync_log ORDER BY rowid DESC LIMIT 1").first())?.status, 'applied')

    // A forgotten position is read again from the start and kept.
    forgetPosition = true
    const before = (await db.prepare('SELECT sync_token FROM google_calendar_sync').first())?.sync_token
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 1, applied: 0, reviewed: 0 })
    assert.notEqual((await db.prepare('SELECT sync_token FROM google_calendar_sync').first())?.sync_token, before)

    // An event the business put on the calendar itself is never read.
    changes = [{ id: 'theirs', status: 'confirmed', updated: 'u5', start: { dateTime: '2099-11-02T09:00:00.000Z' }, end: { dateTime: '2099-11-02T10:00:00.000Z' } }]
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 1, applied: 0, reviewed: 0 })

    // The plan lapses: the feed is left alone until it is back.
    await db.prepare("UPDATE subscription SET status='canceled' WHERE id='sub-org'").run()
    changes = [{ id: eventId, status: 'cancelled', updated: 'u6' }]
    assert.deepEqual(await pullCalendarChanges(env, 'org', provider), { events: 0, applied: 0, reviewed: 0 })

    await stopCalendarWatch(env, 'org', provider)
    assert.equal(calls.filter(call => call.endsWith('/channels/stop')).length, 1)
    assert.equal(await db.prepare('SELECT count(*) n FROM google_calendar_sync').first('n'), 0)
  } finally { await mf.dispose() }
})
