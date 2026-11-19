import { PLATFORM_MESSAGE_AUTHOR_KIND } from '../../shared/messages-contract.ts'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { H3 } from 'nitro/h3'
import { Miniflare } from 'miniflare'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { getGuestRequest, requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { nameConversationBooking } from './support/booking-state.ts'
import { getReviewBookingContext, getReviewRequestByToken } from '../../server/utils/review-requests.ts'
import { appendMessage } from '../../server/domain/conversations.ts'
import { sendDueReviewInvitations, sendReviewRequestForBooking } from '../../server/utils/review-request-delivery.ts'
import { readInsightsPage } from '../../server/domain/insights.ts'
import { listOrganizationReviews, setReviewStatus } from '../../server/utils/organization-reviews.ts'
import validateRoute from '../../server/api/public/review-requests/validate.get.ts'
import submitRoute from '../../server/api/public/review-requests/submit.post.ts'
import googleClickRoute from '../../server/api/public/review-requests/google-click.post.ts'
import { localDateAt, localDateTimeToInstant } from '../../utils/timezone.ts'
import { captureEvents } from './support/events.ts'
import { applySchema } from './support/schema.ts'

const HOUR = 3_600_000
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

test('guest reviews: invitations for every kind of visit, no-show, consent and who reads private feedback', { timeout: 240_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'guest-reviews-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `export class Hub {
      constructor(ctx, env) { this.storage = ctx.storage; this.db = env.DB }
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/fail-next-delivery') { await this.storage.put('fail', true); return new Response(null, { status: 204 }) }
        if (path === '/fail-next-success') { await this.storage.put('failSuccess', true); return new Response(null, { status: 204 }) }
        if (path === '/delivery-publications') return Response.json(await this.storage.get('publications') ?? 0)
        if (path === '/success-publications') return Response.json(await this.storage.get('successPublications') ?? [])
        const event = await request.json()
        if (event.type === 'MESSAGE_UPDATE') {
          if (await this.storage.get('fail')) { await this.storage.delete('fail'); return new Response('controlled publication failure', { status: 503 }) }
          await this.storage.put('publications', (await this.storage.get('publications') ?? 0) + 1)
        }
        if (event.type === 'MESSAGE_CREATE') {
          const review = await this.db.prepare("SELECT rr.first_sent_at FROM review_requests rr JOIN conversations c ON c.booking_id = rr.booking_id AND c.kind = 'booking' WHERE c.id = ?").bind(event.conversation_id).first()
          if (review) {
            if (await this.storage.get('failSuccess')) { await this.storage.delete('failSuccess'); return new Response('controlled success publication failure', { status: 503 }) }
            await this.storage.put('successPublications', [...await this.storage.get('successPublications') ?? [], { threadId: event.conversation_id, firstSentAt: review.first_sent_at }])
          }
        }
        return new Response(null, { status: 204 })
      }
    } export default { fetch() { return new Response("ok") } }` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'guest-reviews-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), EVENTS: captureEvents().binding, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await applySchema(db)
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Proof House', 'proof', 'proof', 'USD', 'Asia/Bangkok')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')",
      "INSERT INTO organization_domains (id, organization_id, domain, role, status, type) VALUES ('domain', 'org', 'proof-house.example', 'canonical', 'active', 'custom')",
      "INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('sub', 'growth', 'org', 'active', 4102444800)",
      ...[['owner', 'owner'], ['host', 'member'], ['other', 'member']].flatMap(([id, role]) => [
        `INSERT INTO user (id, name, email, emailVerified) VALUES ('${id}', '${id}', '${id}@proof.example', 1)`,
        `INSERT INTO member (id, organizationId, userId, role) VALUES ('member-${id}', 'org', '${id}', '${role}')`,
      ]),
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('room', 'org', 'room', 'Dining Room', 'Asia/Bangkok')",
      "INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('patio', 'org', 'patio', 'Patio', 'Asia/Bangkok')",
      // Each place's tables: the dining room's are the host's; the patio's are the owner's own.
      ...([['room', 'member-host', 40], ['patio', 'member-owner', 20]] as const).flatMap(([location, member, seats]) => [
        `INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('${location}-tables', 'org', 'table', '${location} tables', '${location}-tables', 'owner', 'owner')`,
        `INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('${location}-tables-v', 'org', '${location}-tables', 'Table', 'owner', 'owner')`,
        `INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('org', '${location}-tables', '${location}', 'owner', 'owner')`,
        `INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, payment_basis, assigned_member_id, created_by, updated_by) VALUES ('${location}-tables', 'org', 'slot', 120, ${seats}, 'business', 'per_booking', '${member}', 'owner', 'owner')`,
      ]),
      "INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('consult', 'org', 'service', 'Initial Consultation', 'consult', 'owner', 'owner')",
      "INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('class', 'org', 'experience', 'Pasta Class', 'class', 'owner', 'owner')",
      "INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('home', 'org', 'stay', 'Garden Cottage', 'home', 'owner', 'owner')",
      ...['consult', 'class', 'home'].map(id => `INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('${id}-v', 'org', '${id}', 'Standard', 'owner', 'owner')`),
      "INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, created_by, updated_by) VALUES ('class', 'org', 'slot', 120, 8, 'business', 'owner', 'owner')",
      "INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, created_by, updated_by) VALUES ('consult', 'org', 'slot', 30, 1, 'business', 'owner', 'owner')",
      "INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('org', 'home', 'room', 'owner', 'owner')",
      "INSERT INTO product_stay_configs (organization_id, product_id, location_id, created_by, updated_by) VALUES ('org', 'home', 'room', 'owner', 'owner')",
      "INSERT INTO product_booking_configs (organization_id, product_id, unit, scheduling_mode, online_payment_required, check_in_time, check_out_time, default_capacity, min_nights, created_by, updated_by) VALUES ('org', 'home', 'nights', 'business', 1, '15:00', '11:00', 4, 1, 'owner', 'owner')",
      ...['g-dinner', 'g-early', 'g-cancelled', 'g-old', 'g-absent', 'g-consult', 'g-class', 'g-stay'].map(id => `INSERT INTO user (id, name, email, isAnonymous) VALUES ('${id}', 'Anonymous', 'anon-${id}@customers.blawby.test', 1)`),
    ]) await db.prepare(statement).run().catch((error: unknown) => { throw new Error(`${statement}: ${String(error)}`) })

    const now = at(0)
    // Conversation ids are UUIDs, as everywhere: a reply address encodes one.
    const T: Record<string, string> = {}
    const name = (requestId: unknown) => Object.keys(T).find(key => T[key] === requestId)
    // Every booking's conversation, a stay's included, carries its guest's contact.
    const thread = async (key: string, userId: string, locationId: string | null, name: string) => {
      const id = T[key] ??= crypto.randomUUID()
      const writes = requestInsertQueries({ id, kind: 'booking', organization_id: 'org', location_id: locationId, user_id: userId, booking_id: null,
        payload: threadPayloadForGuest({ name, email: `${key}@guests.example`, phone: '+66812345678' }),
        created_at: now })
      await db.batch(writes.map(write => db.prepare(write.query).bind(...(write.params ?? []))))
    }
    // A table booked at a place: a seating of that place's tables, and the party's booking of it.
    const reservation = async (id: string, guest: string, locationId: string, endsAt: string, status = 'confirmed') => {
      await thread(id, guest, locationId, `Guest ${id}`)
      const startsAt = at(Date.parse(endsAt) - Date.now() - 2 * HOUR)
      await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, created_by, updated_by)
        VALUES (?, 'org', ?, ?, 'Asia/Bangkok', ?, ?, 40, 'owner', 'owner')`).bind(`${id}-seating`, `${locationId}-tables`, locationId, startsAt, endsAt).run()
      await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone, user_id, party_size, policy_json, status, cancelled_at)
        VALUES (?, 'org', ?, ?, ?, ?, ?, ?, 'Asia/Bangkok', ?, 2, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}', ?, ?)`).bind(`${id}-record`, `${locationId}-tables`, `${id}-seating`, `${locationId}-tables-v`, locationId, startsAt, endsAt, guest, status, status === 'cancelled' ? now : null).run()
      await nameConversationBooking(db, T[id]!, `${id}-record`)
    }
    const booking = async (id: string, guest: string, product: 'consult' | 'class', endsAt: string) => {
      await thread(id, guest, null, `Guest ${id}`)
      // The class meets on the patio; the consultation is held online with the owner.
      const locationId = product === 'class' ? 'patio' : null
      const startsAt = at(Date.parse(endsAt) - Date.now() - HOUR)
      await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, created_by, updated_by)
        VALUES (?, 'org', ?, ?, 'Asia/Bangkok', ?, ?, 8, 'owner', 'owner')`).bind(`${id}-session`, product, locationId, startsAt, endsAt).run()
      await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, location_id, starts_at, ends_at, timezone, user_id, party_size, policy_json, status)
        VALUES (?, 'org', ?, ?, ?, ?, ?, ?, 'Asia/Bangkok', ?, 1, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}', 'confirmed')`).bind(`${id}-record`, product, `${id}-session`, `${product}-v`, locationId, startsAt, endsAt, guest).run()
      await nameConversationBooking(db, T[id]!, `${id}-record`)
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
    await thread('cottage', 'g-stay', 'room', 'Guest cottage')
    // A stay is a booking of the home's nights: its check-in and checkout at the home's times in the home's zone.
    const checkIn = localDateAt(new Date(Date.now() - 5 * 24 * HOUR), 'Asia/Bangkok')
    await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_variant_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants, channel, owner, status, user_id, total_minor, currency, policy_json)
      VALUES ('cottage-record', 'org', 'home', 'home-v', 'room', ?, ?, 'Asia/Bangkok', 2, 2, 0, 0, 'direct', 'app', 'confirmed', 'g-stay', 30000, 'USD', '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}')`)
      .bind(localDateTimeToInstant(checkIn, '15:00', 'Asia/Bangkok').toISOString(), localDateTimeToInstant(checkout, '11:00', 'Asia/Bangkok').toISOString()).run()
    await nameConversationBooking(db, T.cottage!, 'cottage-record')

    // Each visit is reviewed as what it was.
    assert.deepEqual(await Promise.all(['dinner', 'consultation', 'lesson', 'cottage'].map(async id =>
      (await getReviewBookingContext(db, `${id}-record`))?.subject)), ['restaurant', 'legal_consultation', 'experience', 'lodging'])
    const stayContext = await getReviewBookingContext(db, 'cottage-record')
    assert.equal(stayContext?.completed_at, new Date(`${checkout}T04:00:00.000Z`).toISOString(), 'a stay ends at its home\'s checkout time in the home\'s zone')

    // A table no-show from before restaurant reservations joined bookings.
    await appendMessage(db, { conversationId: T.absent!, authorKind: 'member', authorUserId: 'owner',
      eventName: 'reservation.no_show', body: 'Marked as a no-show', occurredAt: at(-HOUR) })
    const sendDue = (bindings = env) => sendDueReviewInvitations(bindings, 'org', Date.now())
    const run = await sendDue()
    assert.equal(run.next, Date.parse((await db.prepare("SELECT ends_at FROM bookings WHERE id = 'early-record'").first<string>('ends_at'))!) + 24 * HOUR, 'the early visit sets the next deadline')
    // Read back through the bookings each invitation names.
    const invited = (await db.prepare(`SELECT CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END AS booking_type, (SELECT c.id FROM conversations c WHERE c.booking_id = b.id AND c.kind = 'booking') AS booking_id, rr.first_sent_at IS NOT NULL AS sent
      FROM review_requests rr JOIN bookings b ON b.id = rr.booking_id`).all<{ booking_type: string; booking_id: string; sent: number }>()).results
      .map(row => ({ ...row, booking_id: name(row.booking_id) })).sort((a, b) => a.booking_id!.localeCompare(b.booking_id!))
    assert.deepEqual(invited, [
      { booking_type: 'booking', booking_id: 'consultation', sent: 1 },
      { booking_type: 'stay', booking_id: 'cottage', sent: 1 },
      { booking_type: 'booking', booking_id: 'dinner', sent: 1 },
      { booking_type: 'booking', booking_id: 'lesson', sent: 1 },
    ], 'every ended, confirmed visit inside the window is invited; the early, cancelled, old and no-show ones are not')
    const reviewHub = env.GUEST_INBOX_HUBS!.get(env.GUEST_INBOX_HUBS!.idFromName('org'))
    const successPublications = await (await reviewHub.fetch('https://hub/success-publications')).json() as Array<{ threadId: string; firstSentAt: string | null }>
    assert.deepEqual(successPublications.map(publication => name(publication.threadId)).sort(), ['consultation', 'cottage', 'dinner', 'lesson'])
    assert.ok(successPublications.every(publication => publication.firstSentAt !== null), 'open apps are invalidated only after invitation success is persisted')
    // Inviting leaves every conversation readable: a stay's strict payload carries no review state.
    for (const key of ['dinner', 'consultation', 'lesson', 'cottage']) assert.ok(await getGuestRequest(db, T[key]!, 'org'), `${key} still reads as a conversation`)

    // The invitation is a fact in the visit's own conversation, and its email is that fact's receipt.
    const delivery = await db.prepare(`SELECT e.event_name, e.body, d.purpose, d.channel, d.status, d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id
      WHERE e.conversation_id = ? AND e.event_name = 'review.requested'`).bind(T.dinner).first<{ event_name: string; body: string; purpose: string; channel: string; status: string; email_json: string }>()
    assert.deepEqual({ ...delivery, email_json: undefined }, { event_name: 'review.requested', body: 'Review invitation sent', purpose: 'status_update', channel: 'email', status: 'sent', email_json: undefined })
    const email = JSON.parse(delivery!.email_json) as { message: { to: string; html: string; replyTo: string | null } }
    assert.equal(email.message.to, 'dinner@guests.example')
    assert.ok(email.message.replyTo, 'a reply to the invitation returns to the same conversation')
    const tokenOf = (html: string) => decodeURIComponent(/https:\/\/proof-house\.example\/review-submit\?token=([^"&]+)/.exec(html)![1]!)
    const dinnerToken = tokenOf(email.message.html)

    // A second run sends nothing more.
    await sendDue()
    assert.equal(await db.prepare('SELECT SUM(send_count) AS sent FROM review_requests').first('sent'), 4)

    const tokenFor = async (key: string) => {
      const row = await db.prepare(`SELECT d.email_json FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id = ? AND e.event_name = 'review.requested'`).bind(T[key]).first<{ email_json: string }>()
      return tokenOf((JSON.parse(row!.email_json) as { message: { html: string } }).message.html)
    }

    // An invitation Resend accepted is sent once, and its emailed link is the stored one.
    await reservation('retry-metadata', 'g-dinner', 'room', at(-25 * HOUR))
    await db.prepare("UPDATE conversations SET payload_json = json_set(payload_json, '$.guest.email', 'guest@provider-proof.com') WHERE id = ?").bind(T['retry-metadata']).run()
    const accepted: Array<{ key: string | null; body: { to: string[]; subject: string; html: string } }> = []
    const transport = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      // Only the send: nothing reads an invitation back from Resend.
      assert.equal(url, 'https://api.resend.com/emails')
      const key = new Headers(init.headers).get('idempotency-key')
      const body = JSON.parse(String(init.body))
      const prior = accepted.find(item => item.key === key)
      if (prior) assert.deepEqual(body, prior.body, 'provider idempotency requires the exact frozen payload')
      else accepted.push({ key, body })
      return Response.json({ id: key })
    })
    try {
      const providerEnv = { ...env, EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 'controlled-provider-only', EMAIL_FROM: 'Proof <hello@blawby.com>' }
      const send = () => sendReviewRequestForBooking(providerEnv, db, 'retry-metadata-record')
      // Resend's answer with the email id sends the invitation; a sent invitation is not due again.
      const first = await send()
      assert.equal(first.sent, true, JSON.stringify(first))
      const emailedToken = tokenOf(accepted[0]!.body.html)
      await assert.rejects(send(), /not due a review invitation/u)
      assert.equal(accepted.length, 1, 'a sent invitation is never sent again')
      assert.ok(await getReviewRequestByToken(db, emailedToken), 'the emailed link validates')
      assert.deepEqual(await db.prepare('SELECT send_count, last_error, first_sent_at IS NOT NULL AS sent FROM review_requests WHERE id = ?').bind(first.requestId).first(), { send_count: 1, last_error: null, sent: 1 })
      assert.equal(await db.prepare('SELECT count(*) n FROM guest_thread_deliveries d JOIN messages e ON e.id = d.message_id WHERE e.conversation_id = ?').bind(T['retry-metadata']).first('n'), 1)
    } finally { transport.mock.restore() }

    // A historic no-show still disqualifies an invitation already on record.
    const lessonToken = await tokenFor('lesson')
    assert.ok(await getReviewRequestByToken(db, lessonToken))
    await appendMessage(db, { conversationId: T.lesson!, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: 'owner',
      eventName: 'booking.no_show', body: 'Marked as a no-show', occurredAt: at(-HOUR) })
    assert.equal(await getReviewRequestByToken(db, lessonToken), null)
    const stayToken = await tokenFor('cottage')
    assert.ok(await getReviewRequestByToken(db, stayToken))
    await appendMessage(db, { conversationId: T.cottage!, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: 'owner',
      eventName: 'stay.no_show', body: 'Marked as a no-show', occurredAt: at(-HOUR) })
    assert.equal(await getReviewRequestByToken(db, stayToken), null)

    const app = new H3()
    app.get('/api/public/review-requests/validate', validateRoute)
    app.post('/api/public/review-requests/submit', submitRoute)
    app.post('/api/public/review-requests/google-click', googleClickRoute)
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
    assert.deepEqual(opened.body.display_names, ['Guest', 'Guest dinner'])

    // Outbound click to Google Maps is recorded on the booking conversation
    const googleClick = await call('POST', '/api/public/review-requests/google-click', { token: dinnerToken })
    assert.equal(googleClick.status, 200)
    assert.equal(googleClick.body.recorded, true)
    const googleEvent = await db.prepare("SELECT event_name, body FROM messages WHERE conversation_id = ? AND event_name = 'review.google_clicked'").bind(T.dinner!).first()
    assert.deepEqual(googleEvent, { event_name: 'review.google_clicked', body: 'Opened Google Maps to review' })
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
    const dinnerReviewId = String(dinner.body.review_id)
    assert.deepEqual((await db.prepare('SELECT category, rating FROM review_category_ratings WHERE review_id = ? ORDER BY category').bind(dinnerReviewId).all()).results,
      [{ category: 'atmosphere', rating: 3 }, { category: 'food', rating: 5 }], 'the skipped question has no score')
    assert.equal((await call('POST', '/api/public/review-requests/submit', { token: dinnerToken, rating: 5, publish: false })).status, 404, 'a link is answered once')

    // A private-only answer: a rating and a note, nothing to publish.
    const consultation = await call('POST', '/api/public/review-requests/submit', { token: await tokenFor('consultation'), rating: 2, categories: { next_steps: 2 }, publish: false, privateFeedback: 'I left unsure what to file next.' })
    assert.equal(consultation.status, 201)
    assert.equal(consultation.body.status, 'private')
    const consultationReviewId = String(consultation.body.review_id)

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
    // Insights → Overall rating is where they are read: a member who reads no analytics reads their own visits' reviews.
    const organization = (await db.prepare("SELECT timezone, default_currency FROM organization WHERE id = 'org'").first<{ timezone: string; default_currency: string }>())!
    const feedbackFor = async (userId: string, analytics: boolean) => {
      const page = await readInsightsPage(db, { organizationId: 'org', slug: 'proof', timezone: organization.timezone, defaultCurrency: organization.default_currency, userId, analytics }, 'quality/overall-rating', {}, env)
      assert.equal(page.list?.kind, 'reviews')
      return page.list?.kind === 'reviews' ? page.list.reviews : []
    }
    const owner = await feedbackFor('owner', true)
    assert.deepEqual(owner.map(review => review.id).sort(), [consultationReviewId, dinnerReviewId].sort())
    assert.equal(owner.filter(review => review.private_feedback !== null).length, 2)
    assert.equal(owner.find(review => review.id === dinnerReviewId)?.categories, 'Atmosphere 3 · Food 5')
    const host = await feedbackFor('host', false)
    assert.deepEqual(host.map(review => [review.id, review.private_feedback]), [[dinnerReviewId, 'The patio heater was broken.']])
    assert.deepEqual(await feedbackFor('other', false), [])
    await assert.rejects(readInsightsPage(db, { organizationId: 'org', slug: 'proof', timezone: organization.timezone, defaultCurrency: organization.default_currency, userId: 'host', analytics: false }, 'rates/cancellation-rate', {}, env),
      (error: { statusCode?: number }) => error.statusCode === 403)

    // The responsible host is told about the review on their visit; the unrelated member is not.
    const alerted = (await db.prepare(`SELECT json_extract(email_json, '$.message.to') AS recipient FROM guest_thread_deliveries WHERE purpose = 'owner_alert' ORDER BY recipient`).all<{ recipient: string }>()).results.map(row => row.recipient)
    assert.ok(alerted.includes('owner@proof.example') && alerted.includes('host@proof.example'))
    assert.equal(alerted.includes('other@proof.example'), false)
  } finally { await runtime.dispose() }
})
