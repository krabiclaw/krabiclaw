import assert from 'node:assert/strict'
import { OPEN_TERMS_JSON } from './support/booking-terms.ts'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import { cancelStay, createStay, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { createTeamThread, getTeamThread, listTeamMessages, sendTeamMessage, teamAccessFor, type TeamAccess } from '../../server/domain/team-messages.ts'
import { closeTask, jobKey, taskViewForUser, taskViewer, updateTask, type TaskRow } from '../../server/domain/tasks.ts'
import { markConversationRead } from '../../server/domain/conversations.ts'
import { runOrganizationJobs } from '../../server/domain/cleaner-jobs.ts'
import { claimSessionCapacity } from '../../server/utils/availability.ts'
import { conversationTaskQueries } from '../../server/domain/guest-threads/repository.ts'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { executeBatch } from '../../server/db/index.ts'
import { localDateTimeToInstant } from '../../utils/timezone.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// A cleaner's job is a team conversation: the job is posted there when it is
// theirs, reminders follow in it, a reassignment or cancellation is told
// there, and Done is their own message in it. Owners and admins read along and
// are warned when a home is not ready two hours before the guests arrive. A
// job an owner keeps for themselves stays a task alert.

const ORG = 'org'
const ZONE = 'America/Denver'
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const at = (date: string, time: string) => localDateTimeToInstant(date, time, ZONE, 'compatible')

test('a cleaning job lives in the stay’s team conversation from assignment to Done', { timeout: 180_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'cleaner-jobs-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `export class Hub {
      constructor(state, env) { this.env = env }
      async fetch(request) {
        const event = await request.json()
        const cache = this.env.ORGANIZATION_CACHE
        await cache.put('publications', JSON.stringify([...JSON.parse(await cache.get('publications') ?? '[]'), event.type]))
        return new Response(null, { status: 204 })
      }
    } export default { fetch() { return new Response("ok") } }` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'cleaner-jobs-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), MEDIA_BASE_URL: 'https://media.example.test', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Saltleaf', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, ZONE).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    for (const [id, name] of [['owner', 'Olive Owner'], ['admin', 'Ada Admin'], ['cleaner', 'Cleo Cleaner'], ['cook', 'Cam Cook']]) {
      await db.prepare('INSERT INTO user (id, name, email, "emailVerified", createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, name, `${id}@example.test`).run()
    }
    for (const [id, userId, role] of [['m-owner', 'owner', 'owner'], ['m-admin', 'admin', 'admin'], ['m-cleaner', 'cleaner', 'member'], ['m-cook', 'cook', 'member']]) {
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(id, ORG, userId, role).run()
    }
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('cabin-site', ?, 'cabin', 'Pine Cabin', 'active', ?, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(ORG, ZONE).run()
    const cabin = await createProduct(db, { env, organizationId: ORG, actor: { actorId: 'owner' }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'cabin-site', check_in_time: '15:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'm-cleaner' },
    } })
    const manager: StayAccess = { organizationId: ORG, actorId: 'owner', manage: true }
    const principal = (userId: string, role: string) => memberAccessPrincipal({ userId, role, organizationId: ORG } as never, { env })
    const team = (userId: string, role: string, memberId: string) => teamAccessFor(principal(userId, role), memberId, 'send')
    const owner = await team('owner', 'owner', 'm-owner')
    const cleaner = await team('cleaner', 'member', 'm-cleaner')
    const cook = await team('cook', 'member', 'm-cook')
    const taskRow = (key: string) => db.prepare('SELECT * FROM tasks WHERE dedupe_key = ?').bind(key).first<TaskRow>()
    const automatic = (threadId: string) => db.prepare("SELECT json_extract(payload_json, '$.key') AS key, body FROM messages WHERE conversation_id = ? AND author_kind = 'krabiclaw' ORDER BY sequence").bind(threadId).all<{ key: string; body: string }>().then(result => result.results)
    // The caller's team conversations, each as its conversation screen reads it.
    const teamThreads = async (access: TeamAccess) => Promise.all((await db.prepare(`SELECT c.id FROM conversations c JOIN conversation_participants seat ON seat.conversation_id = c.id
      WHERE c.organization_id = ? AND c.kind = 'team' AND seat.user_id = ? ORDER BY c.last_message_at DESC, c.id DESC`).bind(ORG, access.userId).all<{ id: string }>()).results.map(row => getTeamThread(env, db, access, row.id)))

    // Dee leaves in three days; Lee arrives the same afternoon. The turnover is the cleaner's.
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(1), check_out_date: day(3), adults: 2, guest_name: 'Dee', total_minor: 30_000 })
    const lee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'lee', check_in_date: day(3), check_out_date: day(5), adults: 1, guest_name: 'Lee', total_minor: 30_000 })
    const turnover = (await taskRow(`turnover:${dee.id}`))!
    assert.equal(turnover.assigned_member_id, 'm-cleaner')
    const checkout = at(day(3), '10:00')

    // Posting the job opens the conversation with the cleaner and every owner and admin, titled by the home, with the job strip.
    const now = new Date(checkout.getTime() - 2 * 86_400_000)
    assert.deepEqual(await runOrganizationJobs(env, db, ORG, now).then(run => [run.next?.toISOString(), run.failures]), [at(day(2), '18:00').toISOString(), []], 'the next wake is the evening-before reminder')
    // Lee's own turnover is the cleaner's too, so they have one conversation per job.
    const threads = await teamThreads(cleaner)
    assert.deepEqual(threads.map(item => item.stay?.id).sort(), [dee.id, lee.id].sort())
    const thread = threads.find(item => item.stay?.id === dee.id)!
    // KrabiClaw's post is a message from someone else: unread until read, for everyone in the conversation.
    assert.deepEqual([thread.name, thread.stay?.id, thread.participants.map(person => person.id).sort(), thread.unread, thread.job?.id, thread.job?.status], ['Cabin', dee.id, ['admin', 'cleaner', 'owner'], true, turnover.id, 'open'])
    const [job] = await automatic(thread.id)
    assert.equal(job!.key, jobKey(turnover))
    assert.match(job!.body, /^Turnover: Cabin\n/)
    assert.match(job!.body, /Checkout 10:00 AM · Dee\nCheck-in 3:00 PM · Lee · 1 guest/)
    const messages = (await listTeamMessages(db, cleaner, thread.id, {})).messages
    assert.deepEqual([messages[0]!.automatic, messages[0]!.senderId], [true, null])
    // The hosts read along, and it is unread for them too until they do.
    assert.equal((await getTeamThread(env, db, owner, thread.id)).unread, true)
    // The cleaner's alert is the message itself, sent to the cleaner alone.
    const alerted = (messageId: string) => db.prepare("SELECT COUNT(*) AS n FROM guest_thread_deliveries WHERE message_id = ? AND purpose = 'owner_alert' AND channel = 'email'").bind(messageId).first<number>('n')
    assert.equal(await alerted(messages[0]!.id), 1)
    // The app's "Message host" lands in the same conversation.
    assert.deepEqual(await createTeamThread(env, db, cleaner, { memberIds: ['owner', 'admin'], bookingId: dee.id }), { id: thread.id, created: false })
    // A second wake posts nothing twice.
    await runOrganizationJobs(env, db, ORG, now)
    assert.equal((await automatic(thread.id)).length, 1)

    // The evening before, the morning of, and the warning to the hosts two hours before Lee arrives; each once.
    for (const [when, key, pattern] of [
      [at(day(2), '18:05'), `reminder:${turnover.id}:evening:${day(3)}`, /^Tomorrow: turnover at Cabin, 10:00 AM – 3:00 PM\.$/],
      [at(day(3), '08:05'), `reminder:${turnover.id}:morning:${day(3)}`, /^Today: turnover at Cabin, 10:00 AM – 3:00 PM\.$/],
      [at(day(3), '13:05'), `warning:${turnover.id}:${turnover.due_at}`, /^Cabin is not marked done and the next guests arrive at 3:00 PM\.$/],
    ] as const) {
      await runOrganizationJobs(env, db, ORG, when)
      await runOrganizationJobs(env, db, ORG, when)
      const posted = await automatic(thread.id)
      assert.equal(posted.filter(message => message.key === key).length, 1, key)
      assert.match(posted.find(message => message.key === key)!.body, pattern)
    }
    const warningId = await db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND json_extract(payload_json, '$.key') = ?").bind(thread.id, `warning:${turnover.id}:${turnover.due_at}`).first<string>('id')
    assert.equal(await alerted(warningId!), 2, 'both hosts are warned')
    assert.deepEqual(await runOrganizationJobs(env, db, ORG, at(day(3), '13:05')).then(run => [run.next?.toISOString(), run.failures]), [at(day(4), '18:00').toISOString(), []], 'only Lee’s turnover is still pending')

    // The home is handed to the cook: the open job follows, the cleaner is told it is no longer theirs, the cook gets it.
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook' })
    assert.equal((await taskRow(`turnover:${dee.id}`))!.assigned_member_id, 'm-cook')
    await runOrganizationJobs(env, db, ORG, at(day(3), '13:10'))
    assert.match((await automatic(thread.id)).find(message => message.key === `released:${turnover.id}`)!.body, /^No longer yours: turnover at Cabin, /)
    const cookThreads = (await teamThreads(cook)).filter(item => item.stay?.id === dee.id)
    assert.equal(cookThreads.length, 1)
    assert.deepEqual([cookThreads[0]!.participants.map(person => person.id).sort(), cookThreads[0]!.job?.id], [['admin', 'cook', 'owner'], turnover.id])
    assert.equal((await automatic(cookThreads[0]!.id)).find(message => message.key === jobKey(turnover))?.body.split('\n')[0], 'Turnover: Cabin')

    // Done: the cook's note is their own message in the conversation, nobody is alerted, and the strip shows it done.
    const closed = await closeTask(db, await taskViewer(db, principal('cook', 'member')), turnover.id, { status: 'done', note: 'All clean, towels restocked', photos: [], env })
    assert.equal(closed.status, 'done')
    const cookMessages = (await listTeamMessages(db, cook, cookThreads[0]!.id, {})).messages
    assert.deepEqual([cookMessages[0]!.senderId, cookMessages[0]!.automatic, cookMessages[0]!.body, cookMessages[0]!.deliveries], ['cook', false, 'All clean, towels restocked', []])
    assert.equal((await getTeamThread(env, db, owner, cookThreads[0]!.id)).job?.status, 'done')
    // The cook's own message reads the conversation through for them and is unread for the hosts; the cleaner, no longer seated with it, never sees it.
    assert.equal((await getTeamThread(env, db, owner, cookThreads[0]!.id)).unread, true)
    assert.equal((await getTeamThread(env, db, cook, cookThreads[0]!.id)).unread, false)
    await assert.rejects(getTeamThread(env, db, cleaner, cookThreads[0]!.id), { status: 404, data: { code: 'TEAM_THREAD_NOT_FOUND', field: 'threadId' } })
    // The cook, given the job at 13:10, was told today's turnover and the warning then; a closed job is told about no more.
    assert.deepEqual((await automatic(cookThreads[0]!.id)).map(message => message.key), [jobKey(turnover), `reminder:${turnover.id}:morning:${day(3)}`, `warning:${turnover.id}:${turnover.due_at}`])
    await runOrganizationJobs(env, db, ORG, at(day(3), '14:00'))
    assert.equal((await automatic(cookThreads[0]!.id)).length, 3, 'a job a person closed is not told about again')

    // A cancelled stay cancels its job in the conversation at once.
    const may = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'may', check_in_date: day(6), check_out_date: day(8), adults: 1, guest_name: 'May', total_minor: 30_000 })
    await runOrganizationJobs(env, db, ORG, at(day(3), '14:00'))
    const mayThread = (await teamThreads(cook)).find(item => item.stay?.id === may.id)!
    assert.equal((await automatic(mayThread.id)).length, 1)
    await cancelStay(db, env, manager, may.id, { expected_version: may.version, reason: 'Guest asked', financial_writes_allowed: false })
    await runOrganizationJobs(env, db, ORG, at(day(3), '14:05'))
    assert.deepEqual((await automatic(mayThread.id)).map(message => message.key), [jobKey({ id: (await taskRow(`turnover:${may.id}`))!.id, product_id: cabin.id }), `cancelled:${(await taskRow(`turnover:${may.id}`))!.id}`])

    // A job the owner takes for themselves has no conversation: the task alert goes out on the morning of, once.
    const leeTurnover = (await taskRow(`turnover:${lee.id}`))!
    const ownerViewer = await taskViewer(db, principal('owner', 'owner'))
    await updateTask(db, ownerViewer, leeTurnover.id, { expectedVersion: leeTurnover.version, assignedMemberId: 'm-owner' })
    await runOrganizationJobs(env, db, ORG, at(day(5), '08:05'))
    await runOrganizationJobs(env, db, ORG, at(day(5), '08:06'))
    // Its sends are the task's, keyed by the day: the owner's email, once.
    const alerts = await db.prepare('SELECT channel FROM guest_thread_deliveries WHERE task_id = ? AND id GLOB ?').bind(leeTurnover.id, `${leeTurnover.id}:owner_alert:*:task_starting:${day(5)}:*`).all<{ channel: string }>()
    assert.deepEqual(alerts.results.map(row => row.channel), ['email'])
    // The cook, who had it, is told; no conversation of hosts alone is opened.
    const leeThreads = (await teamThreads(owner)).filter(item => item.stay?.id === lee.id)
    assert.ok(leeThreads.every(item => item.participants.some(person => person.id === 'cook' || person.id === 'cleaner')))
    assert.ok((await automatic(leeThreads.find(item => item.participants.some(person => person.id === 'cook'))!.id)).some(message => message.key === `released:${leeTurnover.id}`))

    // A person's own message in a job conversation counts as unread for the others, from where they read.
    await markConversationRead(db, { organizationId: ORG, conversationId: thread.id, userId: 'cleaner' })
    assert.equal((await getTeamThread(env, db, cleaner, thread.id)).unread, false)
    await sendTeamMessage(env, db, owner, thread.id, { body: 'Thanks Cleo', photos: [], idempotencyKey: 'thanks', senderName: 'Olive Owner' })
    assert.equal((await getTeamThread(env, db, cleaner, thread.id)).unread, true)
    assert.equal((await getTeamThread(env, db, owner, thread.id)).unread, false)
  } finally {
    await runtime.dispose()
  }
})

test('a consultation gives its attorney jobs that follow the booking and an alert on the day', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'consultation-jobs-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'consultation-jobs-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Cedar Legal', 'cedar', 'cedar', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'service', '2026-10-15T00:00:00.000Z', 'America/New_York')`).bind(ORG).run()
    const NOW = '2026-10-01T00:00:00.000Z'
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','product',?,'Consultation','consultation','host','host')").bind(ORG).run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('variant',?,'product','Hour','host','host')").bind(ORG).run()
    await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.com',1)").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('host-member',?,'host','member',1)").bind(ORG).run()
    await db.prepare(`INSERT INTO member_scheduling(member_id, organization_id, public_name, public_approved, timezone, weekly_json, time_off_json, updated_at, updated_by) VALUES('host-member',?,'Attorney Host',1,'America/New_York','[{"weekday":0,"start":"00:00","end":"23:59"},{"weekday":1,"start":"00:00","end":"23:59"},{"weekday":2,"start":"00:00","end":"23:59"},{"weekday":3,"start":"00:00","end":"23:59"},{"weekday":4,"start":"00:00","end":"23:59"},{"weekday":5,"start":"00:00","end":"23:59"},{"weekday":6,"start":"00:00","end":"23:59"}]','[]',?,'host')`).bind(ORG,NOW).run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,default_capacity,confirmation_mode,held_online,scheduling_mode,assigned_member_id,online_payment_required,created_by,updated_by) VALUES('product',?,'slot',60,1,'review',1,'provider','host-member',1,'host','host')").bind(ORG).run()
    await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by) VALUES('session',?,'product','America/New_York','2099-10-01T13:00:00.000Z','2099-10-01T14:00:00.000Z',1,'scheduled','host','host')").bind(ORG).run()
    const opening = { id: 'consult-request', kind: 'booking' as const, organization_id: ORG, location_id: null, user_id: null, review_id: null, payload: threadPayloadForGuest({ name: 'Client', email: 'client@example.test' }), created_at: NOW, updated_at: NOW }
    await db.batch(requestInsertQueries(opening).map(write => db.prepare(write.query).bind(...write.params)))
    const booking = await claimSessionCapacity(db, { policyJson: OPEN_TERMS_JSON, env, organizationId: ORG, productId: 'product', sessionId: 'session', productVariantId: 'variant', partySize: 1, requestId: opening.id })
    const jobs = async () => (await db.prepare("SELECT kind, subject_type, subject_id, assigned_member_id, starts_at, status FROM tasks WHERE kind IN ('consultation_prep', 'consultation_follow_up') ORDER BY kind").all<{ kind: string; status: string }>()).results
    const recompute = () => executeBatch(db, conversationTaskQueries(opening.id, new Date().toISOString()), { operation: 'Recompute consultation jobs' })
    await db.prepare("UPDATE bookings SET status = 'confirmed', cancelled_at = NULL WHERE id = ?").bind(booking.bookingId).run()
    await recompute()
    assert.deepEqual(await jobs(), [
      { kind: 'consultation_follow_up', subject_type: 'booking', subject_id: booking.bookingId, assigned_member_id: 'host-member', starts_at: '2099-10-02T14:00:00.000Z', status: 'open' },
      { kind: 'consultation_prep', subject_type: 'booking', subject_id: booking.bookingId, assigned_member_id: 'host-member', starts_at: '2099-10-01T13:00:00.000Z', status: 'open' },
    ])
    await recompute()
    assert.equal((await jobs()).length, 2)

    // The attorney's jobs live in a conversation with the owner, tied to the booking and named for the client.
    const prep = await db.prepare('SELECT id FROM tasks WHERE dedupe_key = ?').bind(`consultation_prep:${booking.bookingId}`).first<{ id: string }>()
    const view = await taskViewForUser(db, ORG, prep!.id, 'host')
    assert.deepEqual([view.title, view.sheet.heading], ['Client', 'Prepare for consultation'])
    await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('partner','Pat Partner','partner@example.test',1)").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('partner-member',?,'partner','owner',1)").bind(ORG).run()
    const morning = localDateTimeToInstant('2099-10-01', '08:05', 'America/New_York', 'compatible')
    const run = await runOrganizationJobs(env, db, ORG, morning)
    assert.deepEqual([run.next?.toISOString(), run.failures], [localDateTimeToInstant('2099-10-01', '18:00', 'America/New_York', 'compatible').toISOString(), []])
    await runOrganizationJobs(env, db, ORG, morning)
    const attorney = await teamAccessFor(memberAccessPrincipal({ userId: 'host', role: 'member', organizationId: ORG } as never, { env }), 'host-member', 'send')
    const threads = await Promise.all((await db.prepare("SELECT id FROM conversations WHERE kind = 'team' AND booking_id = ?").bind(booking.bookingId).all<{ id: string }>()).results.map(row => getTeamThread(env, db, attorney, row.id)))
    assert.deepEqual(threads.map(thread => [thread.name, thread.bookingId, thread.job?.id]), [['Client', booking.bookingId, prep!.id]])
    const posts = (await db.prepare("SELECT body FROM messages WHERE conversation_id = ? AND author_kind = 'krabiclaw'").bind(threads[0]!.id).all<{ body: string }>()).results.map(row => row.body)
    assert.equal(posts.filter(body => body === `Today: prepare for consultation with Client${view.when ? `, ${view.when}` : ''}.`).length, 1)
    assert.equal(posts.filter(body => body.includes('arrive')).length, 0)

    // Chatting about it reaches the same conversation; an unknown booking does not.
    const partner = await teamAccessFor(memberAccessPrincipal({ userId: 'partner', role: 'owner', organizationId: ORG } as never, { env }), 'partner-member', 'send')
    assert.deepEqual(await createTeamThread(env, db, partner, { memberIds: ['host'], bookingId: booking.bookingId }), { id: threads[0]!.id, created: false })
    await assert.rejects(createTeamThread(env, db, partner, { memberIds: ['host'], bookingId: 'not-a-booking' }), /booking/iu)

    // Any other assigned task with a start time gets its alert on the morning of.
    await db.prepare("INSERT INTO tasks (id, organization_id, kind, assigned_member_id, title, starts_at, timezone, status, dedupe_key, version, created_at, updated_at) VALUES ('plain', ?, 'custom', 'host-member', 'File the motion', '2099-10-01T15:00:00.000Z', 'America/New_York', 'open', 'plain', 1, ?, ?)").bind(ORG, NOW, NOW).run()
    await runOrganizationJobs(env, db, ORG, morning)
    assert.equal(await db.prepare("SELECT count(*) n FROM guest_thread_deliveries WHERE task_id = 'plain' AND id GLOB 'plain:owner_alert:*:task_starting:2099-10-01:*'").first('n'), 1)

    // Cancelling the consultation closes both jobs; confirming it again reopens them.
    await db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(NOW, booking.bookingId).run()
    await recompute()
    assert.deepEqual((await jobs()).map(job => job.status), ['cancelled', 'cancelled'])
    await db.prepare("UPDATE bookings SET status = 'confirmed', cancelled_at = NULL WHERE id = ?").bind(booking.bookingId).run()
    await recompute()
    assert.deepEqual((await jobs()).map(job => job.status), ['open', 'open'])
  } finally { await runtime.dispose() }
})
