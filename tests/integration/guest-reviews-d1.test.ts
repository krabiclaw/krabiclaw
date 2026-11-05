import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { H3 } from 'nitro/h3'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { getGuestRequest, requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { getReviewBookingContext, getReviewRequestByToken } from '../../server/utils/review-requests.ts'
import { sendReviewRequestForBooking } from '../../server/utils/review-request-delivery.ts'
import { loadReviewFeedback } from '../../server/utils/review-feedback.ts'
import { listOrganizationReviews, setReviewStatus } from '../../server/utils/organization-reviews.ts'
import reviewTask from '../../server/tasks/review-request-automation.ts'
import validateRoute from '../../server/api/public/review-requests/validate.get.ts'
import submitRoute from '../../server/api/public/review-requests/submit.post.ts'
import { localDateAt } from '../../utils/timezone.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { listBusinessOutcomes } from '../../server/utils/business-outcomes.ts'

const HOUR = 3_600_000
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

test('guest reviews: invitations for every kind of visit, no-show, consent and who reads private feedback', { timeout: 240_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'guest-reviews-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `export class Hub {
      constructor(ctx) { this.storage = ctx.storage }
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/fail-next-delivery') { await this.storage.put('fail', true); return new Response(null, { status: 204 }) }
        if (path === '/delivery-publications') return Response.json(await this.storage.get('publications') ?? 0)
        const event = await request.json()
        if (event.type === 'delivery.changed') {
          if (await this.storage.get('fail')) { await this.storage.delete('fail'); return new Response('controlled publication failure', { status: 503 }) }
          await this.storage.put('publications', (await this.storage.get('publications') ?? 0) + 1)
        }
        return new Response(null, { status: 204 })
      }
    } export default { fetch() { return new Response("ok") } }` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'guest-reviews-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Proof House', 'proof', 'proof', 'USD', 'Asia/Bangkok')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')",
      "INSERT INTO organization_domains (id, organization_id, domain, role, status, type) VALUES ('domain', 'org', 'proof-house.example', 'canonical', 'active', 'custom')",
      "INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('sub', 'growth', 'org', 'active', 4102444800)",
      ...[['owner', 'owner'], ['host', 'member'], ['other', 'member']].flatMap(([id, role]) => [
        `INSERT INTO user (id, name, email, emailVerified) VALUES ('${id}', '${id}', '${id}@proof.example', 1)`,
        `INSERT INTO member (id, organizationId, userId, role) VALUES ('member-${id}', 'org', '${id}', '${role}')`,
      ]),
      // The dining room is the host's; the patio belongs to no one in particular.
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone, max_capacity, assigned_member_id) VALUES ('room', 'org', 'room', 'Dining Room', 'Asia/Bangkok', 40, 'member-host')",
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone, max_capacity) VALUES ('patio', 'org', 'patio', 'Patio', 'Asia/Bangkok', 20)",
      "INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('consult', 'org', 'service', 'Initial Consultation', 'consult', 'owner', 'owner')",
      "INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('class', 'org', 'experience', 'Pasta Class', 'class', 'owner', 'owner')",
      "INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('home', 'org', 'stay', 'Garden Cottage', 'home', 'owner', 'owner')",
      ...['consult', 'class'].map(id => `INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('${id}-v', 'org', '${id}', 'Standard', 'owner', 'owner')`),
      "INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, created_by, updated_by) VALUES ('class', 'org', 120, 8, 'owner', 'owner')",
      "INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, created_by, updated_by) VALUES ('consult', 'org', 30, 1, 'owner', 'owner')",
      "INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('org', 'home', 'room', 'owner', 'owner')",
      "INSERT INTO product_stay_configs (organization_id, product_id, location_id, check_in_time, check_out_time, max_guests, min_nights, created_by, updated_by) VALUES ('org', 'home', 'room', '15:00', '11:00', 4, 1, 'owner', 'owner')",
      ...['g-dinner', 'g-early', 'g-cancelled', 'g-old', 'g-absent', 'g-consult', 'g-class', 'g-stay'].map(id => `INSERT INTO user (id, name, email, isAnonymous) VALUES ('${id}', 'Anonymous', 'anon-${id}@customers.krabiclaw.local', 1)`),
    ]) await db.prepare(statement).run().catch((error: unknown) => { throw new Error(`${statement}: ${String(error)}`) })

    const now = at(0)
    // Conversation ids are UUIDs, as everywhere: a reply address encodes one.
    const T: Record<string, string> = {}
    const name = (requestId: unknown) => Object.keys(T).find(key => T[key] === requestId)
    const thread = async (key: string, kind: 'reservation' | 'booking' | 'stay', userId: string, locationId: string | null, name: string) => {
      const id = T[key] ??= crypto.randomUUID()
      const writes = requestInsertQueries({ id, kind, organization_id: 'org', location_id: locationId, user_id: userId, review_id: null, conversation_state: 'resolved', resolved_at: now,
        // A stay's conversation carries only its guest; a booking's or reservation's carries the thread's own facts too.
        payload: kind === 'stay' ? { guest: { name, email: `${key}@guests.example`, phone: '+66812345678' } } : threadPayloadForGuest({ name, email: `${key}@guests.example`, phone: '+66812345678' }),
        created_at: now, updated_at: now } as Parameters<typeof requestInsertQueries>[0])
      await db.batch(writes.map(write => db.prepare(write.query).bind(...(write.params ?? []))))
    }
    const reservation = async (id: string, guest: string, locationId: string, endsAt: string, status = 'confirmed') => {
      await thread(id, 'reservation', guest, locationId, `Guest ${id}`)
      await db.prepare(`INSERT INTO reservations (id, organization_id, location_id, user_id, request_id, timezone, starts_at, ends_at, party_size, status, cancelled_at)
        VALUES (?, 'org', ?, ?, ?, 'Asia/Bangkok', ?, ?, 2, ?, ?)`).bind(`${id}-record`, locationId, guest, T[id], at(Date.parse(endsAt) - Date.now() - 2 * HOUR), endsAt, status, status === 'cancelled' ? now : null).run()
    }
    const booking = async (id: string, guest: string, product: 'consult' | 'class', endsAt: string) => {
      await thread(id, 'booking', guest, null, `Guest ${id}`)
      // The class meets on the patio; the consultation is held online with the owner.
      const [locationId, provider] = product === 'class' ? ['patio', null] : [null, 'member-owner']
      await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, assigned_member_id, timezone, starts_at, ends_at, capacity, created_by, updated_by)
        VALUES (?, 'org', ?, ?, ?, 'Asia/Bangkok', ?, ?, 8, 'owner', 'owner')`).bind(`${id}-session`, product, locationId, provider, at(Date.parse(endsAt) - Date.now() - HOUR), endsAt).run()
      await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, assigned_member_id, user_id, request_id, party_size, status)
        VALUES (?, 'org', ?, ?, ?, ?, ?, ?, 1, 'confirmed')`).bind(`${id}-record`, product, `${id}-session`, `${product}-v`, provider, guest, T[id]).run()
    }

    await reservation('dinner', 'g-dinner', 'room', at(-25 * HOUR))
    await reservation('early', 'g-early', 'room', at(-2 * HOUR))
    await reservation('cancelled', 'g-cancelled', 'room', at(-25 * HOUR), 'cancelled')
    await reservation('old', 'g-old', 'patio', at(-40 * 24 * HOUR))
    await reservation('absent', 'g-absent', 'patio', at(-25 * HOUR))
    await booking('consultation', 'g-consult', 'consult', at(-25 * HOUR))
    await booking('lesson', 'g-class', 'class', at(-26 * HOUR))
    // The cottage's checkout was two days ago at 11:00 in Bangkok.
    const checkout = localDateAt(new Date(Date.now() - 2 * 24 * HOUR), 'Asia/Bangkok')
    await thread('cottage', 'stay', 'g-stay', 'room', 'Guest cottage')
    await db.prepare(`INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, adults, guest_name, guest_email, user_id, request_id, total_minor, currency)
      VALUES ('cottage-record', 'org', 'home', 'direct', 'app', 'confirmed', date(?, '-3 days'), ?, 2, 'Guest', 'cottage@guests.example', 'g-stay', ?, 30000, 'USD')`).bind(checkout, checkout, T.cottage).run()

    // Each visit is reviewed as what it was.
    assert.deepEqual(await Promise.all([['reservation', 'dinner'], ['booking', 'consultation'], ['booking', 'lesson'], ['stay', 'cottage']].map(async ([kind, id]) =>
      (await getReviewBookingContext(db, kind as 'reservation', T[id!]!))?.subject)), ['restaurant', 'legal_consultation', 'experience', 'lodging'])
    const stayContext = await getReviewBookingContext(db, 'stay', T.cottage!)
    assert.equal(stayContext?.completed_at, new Date(`${checkout}T04:00:00.000Z`).toISOString(), 'a stay ends at its home\'s checkout time in the home\'s zone')

    // No-show on a visit whose invitation has not gone out yet: it is never sent.
    const absent = await executeGuestThreadOperation(db, { threadId: T.absent!, organizationId: 'org', action: 'no_show', actorUserId: 'owner', idempotencyKey: 'absent-no-show', env: env as never })
    assert.equal(absent.ok, true)
    assert.ok(await db.prepare("SELECT no_show_at FROM reservations WHERE id = 'absent-record'").first('no_show_at'))
    assert.equal((await db.prepare("SELECT status FROM reservations WHERE id = 'absent-record'").first('status')), 'confirmed', 'a no-show leaves the visit as it was')
    // The visit that has not begun cannot be a no-show yet... and a cancelled one is not confirmed.
    for (const id of ['cancelled']) {
      const refused = await executeGuestThreadOperation(db, { threadId: T[id]!, organizationId: 'org', action: 'no_show', actorUserId: 'owner', idempotencyKey: `${id}-no-show`, env: env as never })
      assert.equal(refused.ok, false)
    }

    const run = await reviewTask.run!({ context: { cloudflare: { env } }, payload: {}, name: 'review-request-automation' } as never) as { result: { sent: number } }
    const invited = (await db.prepare('SELECT booking_type, booking_id, first_sent_at IS NOT NULL AS sent FROM review_requests').all<{ booking_type: string; booking_id: string; sent: number }>()).results
      .map(row => ({ ...row, booking_id: name(row.booking_id) })).sort((a, b) => a.booking_id!.localeCompare(b.booking_id!))
    assert.deepEqual(invited, [
      { booking_type: 'booking', booking_id: 'consultation', sent: 1 },
      { booking_type: 'stay', booking_id: 'cottage', sent: 1 },
      { booking_type: 'reservation', booking_id: 'dinner', sent: 1 },
      { booking_type: 'booking', booking_id: 'lesson', sent: 1 },
    ], 'every ended, confirmed visit inside the window is invited; the early, cancelled, old and no-show ones are not')
    assert.equal(run.result.sent, 4)
    // Inviting leaves every conversation readable: a stay's strict payload carries no review state.
    for (const key of ['dinner', 'consultation', 'lesson', 'cottage']) assert.ok(await getGuestRequest(db, T[key]!, 'org'), `${key} still reads as a conversation`)

    // The invitation is a fact in the visit's own conversation, and its email is that fact's receipt.
    const delivery = await db.prepare(`SELECT e.event_name, e.body, d.purpose, d.channel, d.status, d.email_json FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id
      WHERE e.request_id = ? AND e.event_name = 'review.requested'`).bind(T.dinner).first<{ event_name: string; body: string; purpose: string; channel: string; status: string; email_json: string }>()
    assert.deepEqual({ ...delivery, email_json: undefined }, { event_name: 'review.requested', body: 'Review invitation sent', purpose: 'status_update', channel: 'email', status: 'sent', email_json: undefined })
    const email = JSON.parse(delivery!.email_json) as { message: { to: string; html: string; replyTo: string | null } }
    assert.equal(email.message.to, 'dinner@guests.example')
    assert.ok(email.message.replyTo, 'a reply to the invitation returns to the same conversation')
    const tokenOf = (html: string) => decodeURIComponent(/https:\/\/proof-house\.example\/review-submit\?token=([^"&]+)/.exec(html)![1]!)
    const dinnerToken = tokenOf(email.message.html)

    // A second run sends nothing more.
    assert.equal((await reviewTask.run!({ context: { cloudflare: { env } }, payload: {}, name: 'review-request-automation' } as never) as { result: { sent: number } }).result.sent, 0)

    const tokenFor = async (key: string) => {
      const row = await db.prepare(`SELECT d.email_json FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id WHERE e.request_id = ? AND e.event_name = 'review.requested'`).bind(T[key]).first<{ email_json: string }>()
      return tokenOf((JSON.parse(row!.email_json) as { message: { html: string } }).message.html)
    }

    // Provider acceptance is not completion: metadata failure must resume the
    // same invitation and leave the emailed link usable.
    await reservation('retry-metadata', 'g-dinner', 'room', at(-25 * HOUR))
    await db.prepare("UPDATE requests SET payload_json = json_set(payload_json, '$.guest.email', 'guest@provider-proof.com') WHERE id = ?").bind(T['retry-metadata']).run()
    const accepted: Array<{ key: string | null; body: { to: string[]; subject: string; html: string } }> = []
    let failReadback = true
    let rejectSend = false
    let sendAttempts = 0
    const transport = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      if (init.method === 'GET') {
        if (failReadback) return Response.json({ name: 'application_error', message: 'controlled metadata failure' }, { status: 503 })
        const sent = accepted.find(item => url.endsWith(`/${item.key}`))!
        assert(sent)
        return Response.json({ id: sent.key, message_id: `<${sent.key}@provider-proof.com>`, to: sent.body.to, subject: sent.body.subject })
      }
      assert.equal(url, 'https://api.resend.com/emails')
      sendAttempts += 1
      if (rejectSend) return Response.json({ name: 'application_error', message: 'controlled unsent failure' }, { status: 503 })
      const key = new Headers(init.headers).get('idempotency-key')
      const body = JSON.parse(String(init.body))
      const prior = accepted.find(item => item.key === key)
      if (prior) assert.deepEqual(body, prior.body, 'provider idempotency requires the exact frozen payload')
      else accepted.push({ key, body })
      return Response.json({ id: key })
    })
    try {
      const providerEnv = { ...env, EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 'controlled-provider-only', EMAIL_FROM: 'Proof <hello@krabiclaw.com>' }
      const send = () => sendReviewRequestForBooking(providerEnv, db, 'reservation', T['retry-metadata']!)
      const failed = await send()
      assert.equal(failed.sent, false)
      assert.match(failed.error!, /controlled metadata failure/)
      assert.equal(accepted.length, 1)
      const emailedToken = tokenOf(accepted[0]!.body.html)
      // A pre-migration row recovers only the exact token that was emailed.
      // Once acceptance is persisted, recovery also works past provider key expiry.
      await db.prepare("UPDATE guest_thread_deliveries SET email_json = json_set(email_json, '$.preparedAt', ?) WHERE entry_id IN (SELECT id FROM activity_entries WHERE request_id = ?)").bind(at(-25 * HOUR), T['retry-metadata']).run()
      await db.prepare('UPDATE review_requests SET token = NULL WHERE id = ?').bind(failed.requestId).run()
      await db.prepare("UPDATE guest_thread_deliveries SET id = 'historical-review-receipt' WHERE entry_id IN (SELECT id FROM activity_entries WHERE request_id = ?)").bind(T['retry-metadata']).run()
      await db.prepare("UPDATE requests SET payload_json = json_set(payload_json, '$.guest.email', 'edited@provider-proof.com') WHERE id = ?").bind(T['retry-metadata']).run()
      failReadback = false
      const retries = await Promise.all([send(), send(), send()])
      assert.ok(retries.every(result => result.sent), JSON.stringify(retries))
      assert.equal(accepted.length, 1, 'an accepted invitation resumes readback rather than sending another email')
      assert.ok(await getReviewRequestByToken(db, emailedToken), 'the original emailed link still validates')
      assert.deepEqual(await db.prepare('SELECT send_count, last_error, first_sent_at IS NOT NULL AS sent FROM review_requests WHERE id = ?').bind(failed.requestId).first(), { send_count: 1, last_error: null, sent: 1 })
      assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id WHERE e.request_id = ?').bind(T['retry-metadata']).first('n'), 1)

      const hub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName('org'))
      const publicationCount = async () => await (await hub.fetch('https://hub/delivery-publications')).json() as number
      for (const boundary of ['preparation', 'acceptance-write', 'publication', 'persistence', 'unsent', 'concurrent']) {
        const key = `retry-${boundary}`
        await reservation(key, 'g-dinner', 'room', at(-25 * HOUR))
        await db.prepare("UPDATE requests SET payload_json = json_set(payload_json, '$.guest.email', 'guest@provider-proof.com') WHERE id = ?").bind(T[key]).run()
        const invitation = () => sendReviewRequestForBooking(providerEnv, db, 'reservation', T[key]!)
        const before = accepted.length
        const attemptsBefore = sendAttempts
        if (boundary === 'preparation') await db.prepare(`CREATE TRIGGER fail_review_preparation BEFORE INSERT ON guest_thread_deliveries
          WHEN NEW.entry_id IN (SELECT id FROM activity_entries WHERE request_id = '${T[key]}') BEGIN SELECT RAISE(FAIL, 'controlled preparation failure'); END`).run()
        if (boundary === 'acceptance-write') await db.prepare(`CREATE TRIGGER fail_review_acceptance BEFORE UPDATE OF provider_message_id ON guest_thread_deliveries
          WHEN NEW.provider_message_id IS NOT NULL AND NEW.entry_id IN (SELECT id FROM activity_entries WHERE request_id = '${T[key]}') BEGIN SELECT RAISE(FAIL, 'controlled acceptance persistence failure'); END`).run()
        if (boundary === 'publication') await hub.fetch('https://hub/fail-next-delivery')
        if (boundary === 'persistence') await db.prepare(`CREATE TRIGGER fail_review_completion BEFORE UPDATE OF first_sent_at ON review_requests
          WHEN NEW.booking_id = '${T[key]}' BEGIN SELECT RAISE(FAIL, 'controlled completion failure'); END`).run()
        rejectSend = boundary === 'unsent'
        if (boundary === 'concurrent') {
          const concurrent = await Promise.all([invitation(), invitation(), invitation()])
          assert.ok(concurrent.every(result => result.sent), JSON.stringify(concurrent))
        } else {
          const incomplete = await invitation()
          assert.equal(incomplete.sent, false, boundary)
          // Drizzle reports the failed completion query as the outer error.
          assert.match(incomplete.error!, boundary === 'unsent' ? /controlled unsent failure/ : boundary === 'persistence' ? /Failed query:[\s\S]*SET first_sent_at/ : boundary === 'preparation' ? /Failed query:[\s\S]*INSERT INTO guest_thread_deliveries/ : boundary === 'acceptance-write' ? /Failed query:[\s\S]*provider_message_id/ : /publication|503|invalidation/i)
          assert.deepEqual(await db.prepare('SELECT first_sent_at, send_count, last_error IS NOT NULL AS failed FROM review_requests WHERE id = ?').bind(incomplete.requestId).first(), { first_sent_at: null, send_count: 0, failed: 1 })
          const retainedRequest = await db.prepare('SELECT token, token_hash, expires_at FROM review_requests WHERE id = ?').bind(incomplete.requestId).first()
          if (boundary === 'preparation') await db.prepare('DROP TRIGGER fail_review_preparation').run()
          if (boundary === 'acceptance-write') await db.prepare('DROP TRIGGER fail_review_acceptance').run()
          if (boundary === 'persistence') await db.prepare('DROP TRIGGER fail_review_completion').run()
          rejectSend = false
          const publicationsBefore = await publicationCount()
          const resumed = await reviewTask.run!({ context: { cloudflare: { env: providerEnv } }, payload: {}, name: 'review-request-automation' } as never) as { result: { sent: number; failed: number } }
          assert.deepEqual(resumed.result, { sent: 1, failed: 0 }, 'automation resumes the incomplete invitation')
          assert.deepEqual(await db.prepare('SELECT token, token_hash, expires_at FROM review_requests WHERE id = ?').bind(incomplete.requestId).first(), retainedRequest, 'retry preserves the original link and expiry')
          assert.equal(await publicationCount(), publicationsBefore + 1, 'retry completes required visibility work')
        }
        assert.equal(accepted.length, before + 1, `${boundary}: exactly one provider-accepted invitation`)
        if (boundary !== 'concurrent') assert.equal(sendAttempts, attemptsBefore + (['unsent', 'acceptance-write'].includes(boundary) ? 2 : 1), `${boundary}: only an unsent or unknown outcome repeats the idempotent provider request`)
        const invitationToken = tokenOf(accepted.at(-1)!.body.html)
        assert.ok(await getReviewRequestByToken(db, invitationToken), `${boundary}: emailed link validates`)
        assert.deepEqual(await db.prepare('SELECT send_count, last_error, first_sent_at IS NOT NULL AS sent FROM review_requests WHERE booking_id = ?').bind(T[key]).first(), { send_count: 1, last_error: null, sent: 1 })
        assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id WHERE e.request_id = ?').bind(T[key]).first('n'), 1)
      }

    } finally { transport.mock.restore() }

    // A no-show after the invitation went out: the unused link stops working.
    const lessonToken = await tokenFor('lesson')
    assert.ok(await getReviewRequestByToken(db, lessonToken))
    assert.equal((await executeGuestThreadOperation(db, { threadId: T.lesson!, organizationId: 'org', action: 'no_show', actorUserId: 'host', idempotencyKey: 'lesson-no-show', env: env as never })).ok, true)
    assert.equal(await getReviewRequestByToken(db, lessonToken), null)

    const app = new H3()
    app.get('/api/public/review-requests/validate', validateRoute)
    app.post('/api/public/review-requests/submit', submitRoute)
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const response = await app.request(Object.assign(new Request(`https://proof-house.example${path}`, {
        method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: body === undefined ? undefined : JSON.stringify(body),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }

    // The guest is asked the dining questions, and may be named by first name or in full.
    const opened = await call('GET', `/api/public/review-requests/validate?token=${encodeURIComponent(dinnerToken)}`)
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    assert.deepEqual((opened.body.questions as Array<{ key: string }>).map(question => question.key), ['food', 'service', 'atmosphere'])
    assert.deepEqual(opened.body.displayNames, ['Guest', 'Guest dinner'])
    assert.equal((await call('GET', `/api/public/review-requests/validate?token=${encodeURIComponent(lessonToken)}`)).status, 404, 'a revoked link is not available')

    // Refusals: a question this visit was not asked, public text without consent, consent without text.
    for (const [body, error] of [
      [{ rating: 4, publish: false, categories: { cleanliness: 5 } }, /not a question about this visit/],
      [{ rating: 4, publish: false, content: 'Lovely evening out.' }, /no public text/],
      [{ rating: 4, publish: true, displayName: 'Guest', content: 'short' }, /at least 10 characters/],
      [{ rating: 4, publish: true, displayName: 'Someone Else', content: 'A lovely long evening.' }, /how your name appears/],
      [{ rating: 0, publish: false }, /between 1 and 5/],
    ] as const) {
      const refused = await call('POST', '/api/public/review-requests/submit', { token: dinnerToken, ...body })
      assert.equal(refused.status, 400)
      assert.match(String(refused.body.error), error)
    }

    // A public review with a skipped question and a private note.
    const dinner = await call('POST', '/api/public/review-requests/submit', { token: dinnerToken, rating: 4, categories: { food: 5, atmosphere: 3 },
      publish: true, displayName: 'Guest', title: 'Great pasta', content: 'The pasta was the best we had all trip.', privateFeedback: 'The patio heater was broken.' })
    assert.equal(dinner.status, 201)
    assert.equal(dinner.body.status, 'pending')
    const dinnerReviewId = String(dinner.body.reviewId)
    assert.deepEqual((await db.prepare('SELECT category, rating FROM review_category_ratings WHERE review_id = ? ORDER BY category').bind(dinnerReviewId).all()).results,
      [{ category: 'atmosphere', rating: 3 }, { category: 'food', rating: 5 }], 'the skipped question has no score')
    assert.equal((await call('POST', '/api/public/review-requests/submit', { token: dinnerToken, rating: 5, publish: false })).status, 404, 'a link is answered once')

    // A private-only answer: a rating and a note, nothing to publish.
    const consultation = await call('POST', '/api/public/review-requests/submit', { token: await tokenFor('consultation'), rating: 2, categories: { next_steps: 2 }, publish: false, privateFeedback: 'I left unsure what to file next.' })
    assert.equal(consultation.status, 201)
    assert.equal(consultation.body.status, 'private')
    const consultationReviewId = String(consultation.body.reviewId)
    const progressMembership = await resolveMembership(env, { organizationId: 'org', userId: 'owner' })
    assert(progressMembership)
    const reviewProgress = await listBusinessOutcomes(db, memberAccessPrincipal(progressMembership, { env }), { limit: 100 })
    for (const [reviewId, threadId] of [[dinnerReviewId, T.dinner], [consultationReviewId, T.consultation]]) {
      const fact = reviewProgress.outcomes.find(item => item.source.table === 'reviews' && item.source.id === reviewId)
      assert(fact)
      assert.deepEqual(fact.subject, { kind: 'review', id: reviewId })
      assert.deepEqual(fact.references, [{ kind: 'guest_thread', id: threadId }], 'the review writer records the actual request id; the progress reference must not use the operational booking id')
    }

    await assert.rejects(setReviewStatus(db, 'org', consultationReviewId, 'approved'), /shared their review privately/)

    // Read back through the public projection: before moderation nothing; after, only the consented text.
    assert.deepEqual(await listOrganizationReviews(db, 'org', { publishedOnly: true, locationId: 'room' }), [])
    await setReviewStatus(db, 'org', dinnerReviewId, 'approved')
    const published = await listOrganizationReviews(db, 'org', { publishedOnly: true, locationId: 'room' })
    assert.equal(published.length, 1)
    assert.equal(published[0]!.author_name, 'Guest')
    assert.equal(published[0]!.content, 'The pasta was the best we had all trip.')
    assert.equal('private_feedback' in published[0]!, false, 'private feedback never reaches a public read')
    const editorRows = await listOrganizationReviews(db, 'org', { locationId: 'room' })
    assert.equal(editorRows.find(row => row.id === dinnerReviewId)?.private_feedback, 'The patio heater was broken.')

    // Who reads the feedback: owners everything; the dining room's host its visit only; an unrelated member nothing.
    const feedbackFor = (userId: string, organizationWide: boolean) => loadReviewFeedback(db, { organizationId: 'org', userId, organizationWide, days: 30 })
    const owner = await feedbackFor('owner', true)
    assert.deepEqual(owner.recent.map(review => review.id).sort(), [consultationReviewId, dinnerReviewId].sort())
    assert.equal(owner.privateFeedbackCount, 2)
    assert.deepEqual(owner.subjects.find(subject => subject.subject === 'restaurant')?.categories,
      [{ key: 'food', label: 'Food', average: 5, count: 1 }, { key: 'service', label: 'Service', average: null, count: 0 }, { key: 'atmosphere', label: 'Atmosphere', average: 3, count: 1 }])
    const host = await feedbackFor('host', false)
    assert.deepEqual(host.recent.map(review => [review.id, review.privateFeedback]), [[dinnerReviewId, 'The patio heater was broken.']])
    assert.equal((await feedbackFor('other', false)).responses, 0)

    // The responsible host is told about the review on their visit; the unrelated member is not.
    const alerted = (await db.prepare(`SELECT json_extract(email_json, '$.message.to') AS recipient FROM guest_thread_deliveries WHERE purpose = 'owner_alert' ORDER BY recipient`).all<{ recipient: string }>()).results.map(row => row.recipient)
    assert.ok(alerted.includes('owner@proof.example') && alerted.includes('host@proof.example'))
    assert.equal(alerted.includes('other@proof.example'), false)
  } finally { await runtime.dispose() }
})
