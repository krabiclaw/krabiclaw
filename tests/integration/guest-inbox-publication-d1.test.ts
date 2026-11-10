import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { publishDashboardInvalidation, publishGuestInboxThreadEvent } from '../../server/cloudflare/guest-inbox-events.ts'
import { createCanonicalNotification } from '../../server/utils/notification-center.ts'
import { createProductBooking } from '../../server/domain/product-bookings.ts'
import { listSessions } from '../../server/utils/availability.ts'
import { createTables } from './support/table-product.ts'
import { H3Event } from 'h3'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

test('inbox publication failures are visible and table booking receipts reflect current records after delivery', { timeout: 30_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'inbox-publication-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `
      export class FaultHub {
        constructor(ctx, env) { this.ctx = ctx; this.env = env }
        async fetch(request) {
          if (new URL(request.url).pathname === '/observed') return Response.json(await this.ctx.storage.get('observed'))
          if (new URL(request.url).pathname === '/arm') {
            await this.ctx.storage.put('bookingAction', await request.text())
            return new Response(null, { status: 204 })
          }
          const event = await request.json()
          if (request.method !== 'POST' || new URL(request.url).pathname !== '/broadcast'
            || request.headers.get('x-krabiclaw-organization-id') !== event.organizationId) {
            throw new Error('Invalid publisher wire contract')
          }
          await this.ctx.storage.put('observed', event)
          {
            const action = await this.ctx.storage.get('bookingAction')
            if (action && (action === 'cancel' || action === 'delete-created' ? event.type === 'delivery.changed' : event.type === 'thread.created')) {
              await this.ctx.storage.delete('bookingAction')
              if (action === 'cancel') await this.env.DB.prepare("UPDATE bookings SET status='cancelled',updated_at=? WHERE request_id=?").bind(new Date().toISOString(), event.threadId).run()
              // The table's seating an hour later.
              if (action === 'move') await this.env.DB.prepare(\`UPDATE bookings SET product_session_id=(SELECT later.id FROM product_sessions later JOIN product_sessions booked ON booked.id=bookings.product_session_id
                  WHERE later.product_id=bookings.product_id AND later.starts_at=strftime('%Y-%m-%dT%H:%M:%fZ',booked.starts_at,'+1 hour')),updated_at=? WHERE request_id=?\`).bind(new Date().toISOString(), event.threadId).run()
              if (action.startsWith('delete')) await this.env.DB.prepare('DELETE FROM bookings WHERE request_id=?').bind(event.threadId).run()
            }
          }
          if (event.organizationId === 'throws') throw new Error('Injected DO transport failure')
          if (event.organizationId === 'reset') this.ctx.abort('Injected DO storage reset')
          if (event.organizationId === 'unavailable') return new Response('Unavailable', { status: 503 })
          if (event.organizationId === 'forbidden') return new Response('Forbidden', { status: 403 })
          return new Response(null, { status: 204 })
        }
      }
      export default { fetch() { return new Response('proof') } }
    ` } } },
    exports: { FaultHub: { type: 'durable-object', storage: 'sqlite' } },
    env: {
      GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'inbox-publication-proof', exportName: 'FaultHub' },
      DB: { type: 'd1' },
      MEDIA_BUCKET: { type: 'r2' },
      ORGANIZATION_CACHE: { type: 'kv' },
      AI: { type: 'ai' },
    },
  } }] })

  try {
    const env = await runtime.getBindings<{ GUEST_INBOX_HUBS: DurableObjectNamespace }>()
    const namespace = env.GUEST_INBOX_HUBS
    const eventFor = (organizationId: string): Parameters<typeof publishDashboardInvalidation>[1] => ({
      eventId: crypto.randomUUID(), type: 'thread.changed', organizationId,
      locationId: null, threadId: 'proof-thread', occurredAt: new Date().toISOString(),
    })
    const healthy = eventFor('healthy')
    await assert.doesNotReject(() => publishDashboardInvalidation(env, healthy))
    const observed = await namespace.get(namespace.idFromName('healthy')).fetch('https://guest-inbox.internal/observed')
    assert.deepEqual(await observed.json(), healthy)

    // This broadcast is how an open dashboard learns a booking arrived, so a hub
    // that could not deliver it must not read as a delivery. Transport throws, a
    // storage reset and a 503 used to resolve here while only the 403 rejected,
    // which meant the failures that indicate the hub is actually broken were the
    // ones the caller never heard about.
    await assert.rejects(() => publishDashboardInvalidation(env, eventFor('throws')), /Injected DO transport failure/)
    await assert.rejects(() => publishDashboardInvalidation(env, eventFor('reset')), /Injected DO storage reset/)
    await assert.rejects(() => publishDashboardInvalidation(env, eventFor('unavailable')), /HTTP 503/)
    await assert.rejects(() => publishDashboardInvalidation(env, eventFor('forbidden')), /HTTP 403/)
    await assert.rejects(() => publishDashboardInvalidation({}, eventFor('healthy')), /binding is not configured/)
    const db = await runtime.getD1Database('DB')
    await assert.rejects(() => publishGuestInboxThreadEvent(env, db, {
      threadId: 'proof-thread', type: 'thread.changed',
    }), /Failed query/)

    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('healthy','Healthy','healthy', 'USD', 'UTC')").run()
    const notification = {
      scope: 'organization' as const, organizationId: 'healthy', template: 'payments.payout_paid',
      title: 'Payout paid', message: '$1.40 USD paid', idempotencyKey: 'native-invoice-paid',
    }
    await assert.rejects(() => createCanonicalNotification(db, { ...notification, publishEnv: {} }), /binding is not configured/)
    const persisted = await db.prepare("SELECT id,scope_kind,organization_id,event_name,body FROM activity_entries WHERE dedupe_key='notification:native-invoice-paid'").first()
    assert(persisted)
    assert.deepEqual(persisted, { id: 'native-invoice-paid', scope_kind: 'organization', organization_id: 'healthy', event_name: 'payments.payout_paid', body: '$1.40 USD paid' })
    assert.equal((await (await namespace.get(namespace.idFromName('healthy')).fetch('https://guest-inbox.internal/observed')).json()).type, 'thread.changed')

    const replayId = await createCanonicalNotification(db, { ...notification, publishEnv: env })
    assert.equal(replayId, persisted.id)
    const published = await (await namespace.get(namespace.idFromName('healthy')).fetch('https://guest-inbox.internal/observed')).json()
    assert.equal(published.type, 'notification.created')
    assert.equal(published.organizationId, 'healthy')
    assert.equal(published.targetUserId, null)
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE dedupe_key='notification:native-invoice-paid'").first('n'), 1)
    assert.equal(await createCanonicalNotification(db, { ...notification, publishEnv: env }), persisted.id)
    const repeated = await (await namespace.get(namespace.idFromName('healthy')).fetch('https://guest-inbox.internal/observed')).json()
    assert.equal(repeated.type, 'notification.created')
    assert.notEqual(repeated.eventId, published.eventId, 'an idempotent row replay still publishes its invalidation')
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE kind='notification'").first('n'), 1)

    // Creation and retry receipts follow the saved occurrence after delivery.
    await db.batch([
      "INSERT INTO user (id,name,email) VALUES ('reservation-owner','Owner','owner@proof.example')",
      "INSERT INTO organization_locales (id,organization_id,locale,is_source,status) VALUES ('reservation-en','healthy','en',1,'published')",
      "INSERT INTO member (id,organizationId,userId,role) VALUES ('reservation-member','healthy','reservation-owner','owner')",
      "INSERT INTO organization_domains (id,organization_id,domain,type,role,status) VALUES ('reservation-domain','healthy','proof.example','custom','canonical','active')",
      "INSERT INTO business_locations (id,organization_id,slug,title,status,timezone,opening_hours) VALUES ('reservation-location','healthy','dining','Dining','active','Asia/Bangkok','{\"periods\":[{\"open\":{\"day\":1,\"hour\":16,\"minute\":0},\"close\":{\"day\":1,\"hour\":22,\"minute\":0}}]}')",
    ].map(statement => db.prepare(statement)))
    const reservationEnv = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    // The dining room's tables: Monday seatings every half hour from 16:00 to 20:00.
    const tables = await createTables(db, reservationEnv, { organizationId: 'healthy', locationId: 'reservation-location', actorId: 'reservation-owner', memberId: 'reservation-member', name: 'Dining tables',
      durationMinutes: 120, seats: 10, weekdays: [1], open: '16:00', lastSeating: '20:00' })
    const [seating] = await listSessions(db, { env: reservationEnv, organizationId: 'healthy', productId: tables.id, fromInstant: new Date().toISOString(), toInstant: new Date(Date.now() + 8 * 86_400_000).toISOString() })
    assert(seating)
    const create = (key: string) => {
      const request = Object.assign(new Request('https://proof.example/api/mcp'), { runtime: { cloudflare: { env: reservationEnv } } })
      return createProductBooking(new H3Event(request), { organizationId: 'healthy', slug: tables.slug, financialWritesAllowed: false,
        operator: { userId: 'reservation-owner', idempotencyKey: key, source: 'operator', externalReference: null, guestAcknowledgement: false },
        body: { guest_name: 'Guest', guest_email: 'guest@proof.example', guest_phone: '+66812345678', session_id: seating.id, party_size: 1 } })
    }
    const hub = namespace.get(namespace.idFromName('healthy'))
    const arm = (action: string) => hub.fetch('https://guest-inbox.internal/arm', { method: 'POST', body: action })
    await arm('cancel')
    const cancelled = await create('cancel-during-creation')
    const persistedCancelled = await db.prepare('SELECT status FROM bookings WHERE request_id=?').bind(cancelled.body.request_id).first('status')
    assert.equal(cancelled.status, 201)
    assert.equal(persistedCancelled, 'cancelled')
    assert.equal(cancelled.body.status, persistedCancelled)
    assert.equal(cancelled.body.message, 'This booking was cancelled.')

    const movable = await create('move-during-replay')
    assert.equal(movable.status, 201)
    await db.prepare("UPDATE requests SET payload_json=json_set(payload_json,'$.provenance.followups_completed',json('false')) WHERE id=?").bind(movable.body.request_id).run()
    await arm('move')
    const moved = await create('move-during-replay')
    const persistedMoved = await db.prepare('SELECT s.starts_at,s.ends_at,s.timezone,b.status FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id WHERE b.request_id=?').bind(movable.body.request_id).first()
    assert.equal(moved.status, 200)
    assert.equal(moved.body.replayed, true)
    assert.notEqual(moved.body.starts_at, movable.body.starts_at)
    assert.deepEqual({ starts_at: moved.body.starts_at, ends_at: moved.body.ends_at, timezone: moved.body.timezone, status: moved.body.status }, persistedMoved)

    const removable = await create('delete-during-replay')
    assert.equal(removable.status, 201)
    await db.prepare("UPDATE requests SET payload_json=json_set(payload_json,'$.provenance.followups_completed',json('false')) WHERE id=?").bind(removable.body.request_id).run()
    await arm('delete')
    await assert.rejects(create('delete-during-replay'), { statusCode: 404, message: 'The conversation has no matching booking', data: { code: 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND', request_id: removable.body.request_id } })
    assert.equal(await db.prepare('SELECT id FROM bookings WHERE request_id=?').bind(removable.body.request_id).first('id'), null)
    await arm('delete-created')
    let missingCreationRequestId: string | undefined
    await assert.rejects(create('delete-during-creation'), (error: { statusCode?: number; message?: string; data?: { code?: string; request_id?: string } }) => {
      assert.equal(error.statusCode, 404)
      assert.equal(error.message, 'The conversation has no matching booking')
      assert.equal(error.data?.code, 'REQUEST_OPERATIONAL_RECORD_NOT_FOUND')
      missingCreationRequestId = error.data?.request_id
      return true
    })
    const missingCreation = await db.prepare("SELECT id FROM requests WHERE json_extract(payload_json,'$.provenance.idempotency_key')='delete-during-creation'").first<string>('id')
    assert.ok(missingCreation)
    assert.equal(missingCreationRequestId, missingCreation)
    assert.equal(await db.prepare('SELECT id FROM bookings WHERE request_id=?').bind(missingCreation).first('id'), null)
  } finally {
    await runtime.dispose()
  }
})
