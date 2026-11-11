import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3Event } from 'h3'
import * as schema from '../../server/db/schema.ts'
import { guestThreadMessagingContext, saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import { sendDueScheduledGuestMessages } from '../../server/domain/scheduled-guest-messages.ts'
import { createProductBooking } from '../../server/domain/product-bookings.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { moveBooking } from '../../server/domain/guest-threads/booking-changes.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { getGuestRequest } from '../../server/domain/requests.ts'
import { listSessions } from '../../server/utils/availability.ts'
import { createTables } from './support/table-product.ts'
import type { GuestThreadRow } from '../../server/domain/guest-threads/types.ts'
import type { StayAccess } from '../../server/domain/stays.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { addLocalDays, localDateAt, localDateTimeToInstant } from '../../utils/timezone.ts'

// A law firm's consultations, a studio's classes and a restaurant's tables are
// sent their automatic messages by the same scheduler as stays: planned when
// the booking is made, cancelled with it, moved with it, and sent into the
// client's or guest's own conversation.

const OWNER = 'owner-user'
const NOW = new Date().toISOString()
const hourOn = (days: number, hour: number) => { const at = new Date(Date.now() + days * 86_400_000); at.setUTCHours(hour, 0, 0, 0); return at.toISOString() }
const plus = (instant: string, minutes: number) => new Date(Date.parse(instant) + minutes * 60_000).toISOString()

test('consultations, classes and table bookings are sent their automatic messages, cancelled and moved with them', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'automatic-messages-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'automatic-messages-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', EMAIL_REPLY_SECRET: 'local-reply-proof', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@proof.example', 1, 0, 0)").bind(OWNER).run()
    // Always open, so every requested time is inside opening hours.
    const open = JSON.stringify({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })
    const business = async (id: string, vertical: string, timezone: string) => {
      await db.batch([
        db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
          VALUES (?, ?, ?, ?, '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', ?, ?, ?)`).bind(id, id, id, id, vertical, NOW, timezone),
        db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')").bind(`${id}-en`, id),
        db.prepare("INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES (?, ?, ?, 'custom', 'canonical', 'active')").bind(`${id}-domain`, id, `${id}.proof.example`),
        db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 0)").bind(`${id}-owner`, id, OWNER),
        db.prepare('INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, opening_hours, created_at, updated_at) VALUES (?, ?, ?, ?, \'active\', ?, ?, ?, ?)').bind(`${id}-place`, id, 'main', `${id} main`, timezone, open, NOW, NOW),
      ])
      return { organizationId: id, actorId: OWNER, manage: true } satisfies StayAccess
    }
    // A bookable product: its one price, its publication, its location and its
    // sessions, and the one member who handles its bookings. A consultation is held online by its
    // attorney, in the attorney's hours and clock; a class is held at the studio by its owner.
    const offering = async (organizationId: string, kind: 'service' | 'experience', name: string, sessions: Array<[string, string]>, timezone: string) => {
      const id = `${organizationId}-${kind}`
      const attorney = kind === 'service' ? `${organizationId}-owner` : null
      await db.batch([
        db.prepare("INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(kind, id, organizationId, name, kind, OWNER, OWNER),
        db.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES (?, ?, ?, 'Standard', ?, ?)").bind(`${id}-variant`, organizationId, id, OWNER, OWNER),
        db.prepare("INSERT INTO prices (id, organization_id, product_variant_id, currency, unit_amount, created_by, updated_by) VALUES (?, ?, ?, 'USD', 5000, ?, ?)").bind(`${id}-price`, organizationId, `${id}-variant`, OWNER, OWNER),
        db.prepare('INSERT INTO product_publications (organization_id, product_id, published, created_by, updated_by) VALUES (?, ?, 1, ?, ?)').bind(organizationId, id, OWNER, OWNER),
        db.prepare('INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES (?, ?, ?, 1, 1, ?, ?)').bind(organizationId, id, `${organizationId}-place`, OWNER, OWNER),
        db.prepare("INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, assigned_member_id, held_online, created_by, updated_by) VALUES (?, ?, 'slot', 60, 4, ?, ?, ?, ?, ?)")
          .bind(id, organizationId, attorney ? 'provider' : 'business', `${organizationId}-owner`, attorney ? 1 : 0, OWNER, OWNER),
        ...(attorney ? [db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, public_name, public_approved, timezone, weekly_json, time_off_json, updated_at, updated_by) VALUES (?, ?, 'Attorney Owner', 1, ?, ?, '[]', ?, ?)`)
          .bind(attorney, organizationId, timezone, JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: '00:00', end: '23:59' }))), NOW, OWNER)] : []),
        ...sessions.map(([sessionId, startsAt]) => db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, 4, 'scheduled', ?, ?)`).bind(sessionId, organizationId, id, attorney ? null : `${organizationId}-place`, timezone, startsAt, plus(startsAt, 60), OWNER, OWNER)),
      ])
      return id
    }
    const runAs = (organizationId: string) => Object.assign(new Request(`https://${organizationId}.proof.example/api/mcp`), { runtime: { cloudflare: { env } } })
    const operator = (key: string) => ({ userId: OWNER, idempotencyKey: key, source: 'operator', externalReference: null, guestAcknowledgement: false })

    const law = await business('harbor-legal', 'service', 'America/New_York')
    const studio = await business('clayhouse', 'experience', 'America/Denver')
    const bistro = await business('bistro', 'restaurant', 'Asia/Bangkok')
    const consultation = await offering(law.organizationId, 'service', 'Initial consultation', [['law-1', hourOn(3, 15)], ['law-2', hourOn(4, 15)]], 'America/New_York')
    const wheel = await offering(studio.organizationId, 'experience', 'Wheel class', [['clay-1', hourOn(5, 16)], ['clay-2', hourOn(6, 16)]], 'America/Denver')
    // The bistro's tables: a seating every half hour from 17:00 to 21:00, two hours each.
    const tables = await createTables(db, env, { organizationId: bistro.organizationId, locationId: 'bistro-place', actorId: OWNER, memberId: `${bistro.organizationId}-owner`, name: 'Bistro tables',
      durationMinutes: 120, seats: 10, open: '17:00', lastSeating: '21:00' })

    // Saved before anything is booked: what each business sends, in its own words.
    const received = await saveMessageTemplate(db, env, law, null, { title: 'Request received', body: 'We have your consultation request.',
      schedule: { trigger: 'booking_received', delay_minutes: 5, product_ids: [consultation] } })
    const prepare = await saveMessageTemplate(db, env, law, null, { title: 'Before we meet', body: 'Please bring your lease and any notices.',
      schedule: { trigger: 'check_in', offset_hours: -2, product_ids: [consultation] } })
    const reminder = await saveMessageTemplate(db, env, studio, null, { title: 'Class tomorrow', body: 'Wear clothes you can get clay on.',
      schedule: { trigger: 'check_in', offset_days: -1, local_time: '09:00', product_ids: [wheel] } })
    const thanks = await saveMessageTemplate(db, env, bistro, null, { title: 'Thank you', body: 'Thank you for dining with us.',
      schedule: { trigger: 'check_out', offset_hours: 2, product_ids: [tables.id] } })
    // A restaurant's tables are named by their product; nothing outside the workspace is accepted.
    await assert.rejects(saveMessageTemplate(db, env, law, null, { title: 'Wrong', body: 'x', schedule: { trigger: 'booking_received', delay_minutes: 5, product_ids: [wheel] } }),
      { statusCode: 404, data: { code: 'MESSAGE_OFFERING_NOT_FOUND', field: 'schedule.product_ids' } })

    const book = async (organizationId: string, slug: string, sessionId: string, guest: string) => {
      const result = await createProductBooking(new H3Event(runAs(organizationId)), { organizationId, slug, operator: operator(`${guest}-key`),
        body: { guest_name: guest, guest_email: `${guest.toLowerCase()}@proof.example`, product_session_id: sessionId, party_size: 1 } })
      assert.equal(result.status, 201, JSON.stringify(result.body))
      return { requestId: String(result.body.conversation_id), bookingId: String(result.body.booking_id) }
    }
    const ana = await book(law.organizationId, 'service', 'law-1', 'Ana')
    const ben = await book(law.organizationId, 'service', 'law-2', 'Ben')
    const cy = await book(studio.organizationId, 'experience', 'clay-1', 'Cy')
    const dinner = { date: localDateAt(new Date(Date.now() + 7 * 86_400_000), 'Asia/Bangkok'), time: '19:00' }
    const seatingAt = async (time: string) => {
      const at = localDateTimeToInstant(dinner.date, time, 'Asia/Bangkok', 'reject').toISOString()
      const [seating] = await listSessions(db, { env, organizationId: bistro.organizationId, productId: tables.id, fromInstant: at, toInstant: plus(at, 1) })
      assert.equal(seating?.starts_at, at)
      return seating!.id
    }
    const reserved = await createProductBooking(new H3Event(runAs(bistro.organizationId)), { organizationId: bistro.organizationId, slug: tables.slug, financialWritesAllowed: false, operator: operator('dee-key'),
      body: { guest_name: 'Dee', guest_email: 'dee@proof.example', guest_phone: '+66812345678', product_session_id: await seatingAt(dinner.time), party_size: 2 } })
    assert.equal(reserved.status, 201, JSON.stringify(reserved.body))
    const dee = { requestId: String(reserved.body.conversation_id), reservationId: String(reserved.body.booking_id) }

    // A conversation names what it is about for whoever replies (suggested replies, MCP): the table, for how many, at its own local time.
    const context = await guestThreadMessagingContext(db, memberAccessPrincipal({ userId: OWNER, organizationId: bistro.organizationId, role: 'owner' }, { env }), dee.requestId)
    assert.deepEqual(context.record, { unit: 'slot', status: 'confirmed', name: 'Bistro tables', location: `${bistro.organizationId} main`, address: null, phone: null, party_size: 2,
      timezone: 'Asia/Bangkok', starts: `${dinner.date} ${dinner.time}`, ends: `${dinner.date} 21:00`, no_show_at: null })

    // Each booking's plan, read from the table rather than from the planner that wrote it.
    const planned = (id: string, templateId: string) => db.prepare('SELECT * FROM scheduled_guest_messages WHERE booking_id = ? AND template_id = ?').bind(id, templateId).first<Record<string, string | null>>()
    const anaCreated = await db.prepare('SELECT created_at FROM bookings WHERE id = ?').bind(ana.bookingId).first<string>('created_at')
    assert.deepEqual(Object.fromEntries(Object.entries((await planned(ana.bookingId, received.id))!).filter(([key]) => ['status', 'due_at', 'product_id', 'booking_id', 'timezone'].includes(key))),
      { product_id: consultation, booking_id: ana.bookingId, due_at: plus(anaCreated!, 5), timezone: 'America/New_York', status: 'pending' })
    assert.deepEqual([(await planned(ana.bookingId, prepare.id))?.status, (await planned(ana.bookingId, prepare.id))?.due_at], ['pending', plus(hourOn(3, 15), -120)])
    const classDay = localDateAt(new Date(hourOn(5, 16)), 'America/Denver')
    assert.deepEqual([(await planned(cy.bookingId, reminder.id))?.status, (await planned(cy.bookingId, reminder.id))?.due_at],
      ['pending', localDateTimeToInstant(addLocalDays(classDay, -1), '09:00', 'America/Denver', 'reject').toISOString()])
    const table = await db.prepare('SELECT s.starts_at, s.ends_at FROM bookings b JOIN product_sessions s ON s.id = b.product_session_id WHERE b.id = ?').bind(dee.reservationId).first<{ starts_at: string; ends_at: string }>()
    assert.equal(table?.starts_at, localDateTimeToInstant(dinner.date, dinner.time, 'Asia/Bangkok', 'reject').toISOString())
    const deeThanks = (await planned(dee.reservationId, thanks.id))!
    assert.deepEqual([deeThanks.status, deeThanks.due_at, deeThanks.product_id, deeThanks.booking_id], ['pending', plus(table!.ends_at, 120), tables.id, dee.reservationId])
    // The studio's message never reaches the law firm's clients, nor the reverse.
    assert.equal(await db.prepare('SELECT count(*) AS n FROM scheduled_guest_messages WHERE booking_id = ? AND template_id = ?').bind(ana.bookingId, reminder.id).first('n'), 0)

    // Every visit is held by its offering's one member: theirs to prepare and follow up, whatever was booked.
    const jobs = (kind: 'booking', id: string) => db.prepare("SELECT kind, starts_at, status, assigned_member_id FROM tasks WHERE subject_type = ? AND subject_id = ? AND kind IN ('consultation_prep', 'consultation_follow_up') ORDER BY kind").bind(kind, id).all().then(result => result.results)
    const heldJobs = async (bookingId: string, member: string) => {
      const held = await db.prepare('SELECT ps.starts_at, ps.ends_at FROM bookings b JOIN product_sessions ps ON ps.id = b.product_session_id WHERE b.id = ?').bind(bookingId).first<{ starts_at: string; ends_at: string }>()
      return [
        { kind: 'consultation_follow_up', starts_at: new Date(Date.parse(held!.ends_at) + 86_400_000).toISOString(), status: 'open', assigned_member_id: member },
        { kind: 'consultation_prep', starts_at: held!.starts_at, status: 'open', assigned_member_id: member },
      ]
    }
    assert.deepEqual(await jobs('booking', ana.bookingId), await heldJobs(ana.bookingId, `${law.organizationId}-owner`))
    assert.deepEqual(await jobs('booking', cy.bookingId), await heldJobs(cy.bookingId, `${studio.organizationId}-owner`))
    assert.deepEqual(await jobs('booking', dee.reservationId), await heldJobs(dee.reservationId, `${bistro.organizationId}-owner`))

    // The firm cancels Ben's consultation: nothing of it is sent.
    const thread = async (organizationId: string, requestId: string) => (await getGuestRequest(db, requestId, organizationId)) as unknown as GuestThreadRow
    const cancelled = await executeGuestThreadOperation(db, { threadId: ben.requestId, organizationId: law.organizationId, action: 'cancel', actorUserId: OWNER, idempotencyKey: 'cancel-ben', env, financialWritesAllowed: false })
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
    for (const template of [received, prepare]) {
      assert.deepEqual([(await planned(ben.bookingId, template.id))?.status, (await planned(ben.bookingId, template.id))?.reason], ['cancelled', 'The booking was cancelled.'])
    }
    assert.deepEqual((await jobs('booking', ben.bookingId)).map(job => job.status), ['cancelled', 'cancelled'])

    // The studio moves Cy to the next day's class and the table to 20:30: their messages move with them.
    await moveBooking(db, env, await thread(studio.organizationId, cy.requestId), { userId: OWNER }, { kind: 'booking', product_session_id: 'clay-2', party_size: 1 }, 'move-cy')
    assert.equal(await db.prepare('SELECT product_session_id FROM bookings WHERE id = ?').bind(cy.bookingId).first('product_session_id'), 'clay-2')
    const nextClassDay = localDateAt(new Date(hourOn(6, 16)), 'America/Denver')
    assert.equal((await planned(cy.bookingId, reminder.id))?.due_at, localDateTimeToInstant(addLocalDays(nextClassDay, -1), '09:00', 'America/Denver', 'reject').toISOString())
    await moveBooking(db, env, await thread(bistro.organizationId, dee.requestId), { userId: OWNER }, { kind: 'booking', product_session_id: await seatingAt('20:30'), party_size: 2 }, 'move-dee')
    const movedTable = await db.prepare('SELECT s.ends_at FROM bookings b JOIN product_sessions s ON s.id = b.product_session_id WHERE b.id = ?').bind(dee.reservationId).first<string>('ends_at')
    assert.equal(movedTable, plus(localDateTimeToInstant(dinner.date, '20:30', 'Asia/Bangkok', 'reject').toISOString(), 120))
    assert.deepEqual([(await planned(dee.reservationId, thanks.id))?.status, (await planned(dee.reservationId, thanks.id))?.due_at], ['pending', plus(movedTable!, 120)])

    // Ten days on, every due message has gone out, once, into its own conversation.
    const later = hourOn(10, 0)
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, later), { sent: 4, failed: 0, needs_review: 0 })
    assert.deepEqual(await sendDueScheduledGuestMessages(db, env, later), { sent: 0, failed: 0, needs_review: 0 })
    const conversation = async (organizationId: string, requestId: string) => (await getGuestThreadDetail(db, requestId, organizationId))!.entries
      .filter(entry => entry.eventName === 'thread.scheduled_message').map(entry => entry.body)
    assert.deepEqual((await conversation(law.organizationId, ana.requestId)).sort(), ['Please bring your lease and any notices.', 'We have your consultation request.'])
    assert.deepEqual(await conversation(law.organizationId, ben.requestId), [])
    assert.deepEqual(await conversation(studio.organizationId, cy.requestId), ['Wear clothes you can get clay on.'])
    assert.deepEqual(await conversation(bistro.organizationId, dee.requestId), ['Thank you for dining with us.'])
    // Each send is the conversation's own email delivery, linked from its plan.
    for (const [id, templateId, requestId] of [[ana.bookingId, prepare.id, ana.requestId], [cy.bookingId, reminder.id, cy.requestId], [dee.reservationId, thanks.id, dee.requestId]] as const) {
      const sent = (await planned(id, templateId))!
      assert.equal(sent.status, 'sent')
      assert.deepEqual(await db.prepare('SELECT e.conversation_id, e.author_kind, d.channel, d.purpose, d.status FROM messages e JOIN guest_thread_deliveries d ON d.message_id = e.id WHERE e.id = ?').bind(sent.message_id).first(),
        { conversation_id: requestId, author_kind: 'krabiclaw', channel: 'email', purpose: 'scheduled_message', status: 'sent' })
    }
  } finally {
    await runtime.dispose()
  }
})
