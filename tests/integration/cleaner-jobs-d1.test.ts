import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import sharp from 'sharp'
import type { DbClient } from '../../server/db/index.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { type MemberAccessPrincipal, memberAccessPrincipal } from '../../server/utils/member-access.ts'
import { cancelStay, createStay, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { conversationPageFor } from './support/conversation-page.ts'
import { sendConversationMessage } from '../../server/domain/send-conversation-message.ts'
import { createTeamThread } from '../../server/domain/team-messages.ts'
import { closeTask, getTask, jobKey, reopenTask, taskViewer, updateTask, type TaskRow, type TaskView } from '../../server/domain/tasks.ts'
import { listConversations } from '../../server/domain/guest-threads/repository.ts'
import { markConversationRead, resolveConversationAccess } from '../../server/domain/conversations.ts'
import { captureEvents } from './support/events.ts'
import { sendDueOutbox } from '../../server/domain/scheduled-guest-messages.ts'
import { bindDatabaseEvents } from '../../server/db/index.ts'
import { localDateTimeToInstant } from '../../utils/timezone.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import completeTaskRoute from '../../server/api/organizations/[organization_id]/tasks/[task_id]/complete.post.ts'
import readTaskRoute from '../../server/api/organizations/[organization_id]/tasks/[task_id]/read.post.ts'
import { applySchema } from './support/schema.ts'

// A cleaner's job is a team conversation: the job is posted there when it is
// theirs, reminders follow in it, a reassignment or cancellation is told
// there, and Done is their own message in it. Owners and admins read along and
// are warned when a home is not ready two hours before the guests arrive. A
// job an owner keeps for themselves stays a task alert.

const ORG = 'org'
const ZONE = 'America/Denver'
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const at = (date: string, time: string) => localDateTimeToInstant(date, time, ZONE, 'compatible')
/** A job write and the outbox's sender at one moment: what the write posts now, and what was stored and has come due. `next` is the earliest send still waiting. */
const runOrganizationJobs = async (queue: ReturnType<typeof captureEvents>, env: CloudflareEnv, db: DbClient, organizationId: string, when = new Date()) => {
  await queue.drain(env, 'stay.changed')
  await queue.drain(env, 'jobs.changed')
  return (await sendDueOutbox(db, env, organizationId, when.toISOString())).next
}
const readTeamThread = async (db: DbClient, viewer: MemberAccessPrincipal, id: string) => {
  const { conversation } = await conversationPageFor(db, viewer, id)
  assert.equal(conversation.kind, 'team')
  return conversation
}

const isUnread = async (db: DbClient, viewer: MemberAccessPrincipal, id: string) =>
  (await listConversations(db, viewer.organizationId, { userId: viewer.userId, kind: 'team' })).find(row => row.id === id)?.unread

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
    const queue = captureEvents()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), EVENTS: queue.binding, MEDIA_BASE_URL: 'https://media.example.test', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-proof-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    bindDatabaseEvents(db, env)
    await applySchema(db)
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
    const principal = (userId: string, role: string, memberId = 'm-' + userId) => memberAccessPrincipal({ userId, role, memberId, organizationId: ORG } as never, { env })
    const owner = principal('owner', 'owner', 'm-owner')
    const cleaner = principal('cleaner', 'member', 'm-cleaner')
    const cook = principal('cook', 'member', 'm-cook')
    const taskRow = (key: string) => db.prepare('SELECT * FROM tasks WHERE dedupe_key = ?').bind(key).first<TaskRow>()
    const automatic = (threadId: string) => db.prepare("SELECT json_extract(payload_json, '$.key') AS key, body FROM messages WHERE conversation_id = ? AND author_kind = 'krabiclaw' ORDER BY sequence").bind(threadId).all<{ key: string; body: string }>().then(result => result.results)
    // The caller's team conversations, each as its conversation screen reads it.
    const teamThreads = async (access: MemberAccessPrincipal) => Promise.all((await db.prepare(`SELECT c.id FROM conversations c JOIN conversation_participants seat ON seat.conversation_id = c.id
      WHERE c.organization_id = ? AND c.kind = 'team' AND seat.user_id = ? ORDER BY c.last_message_at DESC, c.id DESC`).bind(ORG, access.userId).all<{ id: string }>()).results.map(row => readTeamThread(db, access, row.id)))

    // Dee leaves in three days; Lee arrives the same afternoon. The turnover is the cleaner's.
    const dee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'dee', check_in_date: day(1), check_out_date: day(3), adults: 2, guest_name: 'Dee', guest_email: 'dee@example.test', total_minor: 30_000 })
    const lee = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'lee', check_in_date: day(3), check_out_date: day(5), adults: 1, guest_name: 'Lee', guest_email: 'lee@example.test', total_minor: 30_000 })
    const turnover = (await taskRow(`turnover:${dee.id}`))!
    assert.equal(turnover.assigned_member_id, 'm-cleaner')
    const checkout = at(day(3), '10:00')

    // Posting the job opens the conversation with the cleaner and every owner and admin.
    const now = new Date(checkout.getTime() - 2 * 86_400_000)
    assert.equal(await runOrganizationJobs(queue, env, db, ORG, now), at(day(2), '18:00').toISOString(), 'the next wake is the evening-before reminder')
    // Lee's own turnover is the cleaner's too, so they have one conversation per job.
    const threads = await teamThreads(cleaner)
    assert.deepEqual(threads.map(item => item.booking_id).sort(), [dee.id, lee.id].sort())
    const thread = threads.find(item => item.booking_id === dee.id)!
    // Blawby's post is a message from someone else: unread until read, for everyone in the conversation.
    assert.deepEqual([thread.name, thread.booking_id, thread.participants.map(person => person.id).sort(), await isUnread(db, cleaner, thread.id)], [null, dee.id, ['admin', 'cleaner', 'owner'], true])
    const [job] = await automatic(thread.id)
    assert.equal(job!.key, jobKey(turnover))
    const messages = (await conversationPageFor(db, cleaner, thread.id)).entries.filter(entry => entry.type === 'message').reverse()
    assert.deepEqual([messages[0]!.automatic, messages[0]!.author_user_id], [true, null])
    // The hosts read along, and it is unread for them too until they do.
    assert.equal(await isUnread(db, owner, thread.id), true)
    // The cleaner's alert is the message itself, sent to the cleaner alone.
    const alerted = (messageId: string) => db.prepare("SELECT COUNT(*) AS n FROM guest_thread_deliveries WHERE message_id = ? AND purpose = 'owner_alert' AND channel = 'email'").bind(messageId).first<number>('n')
    assert.equal(await alerted(messages[0]!.id), 1)
    // The app's "Message host" lands in the same conversation.
    assert.deepEqual(await createTeamThread(env, db, cleaner, { member_user_ids: ['owner', 'admin'], booking_id: dee.id }), { id: thread.id, created: false })
    // A second wake posts nothing twice.
    await runOrganizationJobs(queue, env, db, ORG, now)
    assert.equal((await automatic(thread.id)).length, 1)

    // Ending and reopening this future job restores its unsent reminders under the same keys.
    const cleanerViewer = await taskViewer(cleaner)
    const reminderState = async () => (await db.prepare('SELECT id, status FROM scheduled_guest_messages WHERE task_id = ? ORDER BY due_at')
      .bind(turnover.id).all<{ id: string; status: string }>()).results
    const planned = await reminderState()
    assert.equal(planned.length, 3)
    const skipped = await closeTask(db, cleanerViewer, turnover.id, { status: 'skipped', env })
    await runOrganizationJobs(queue, env, db, ORG, now)
    assert.deepEqual(await reminderState(), planned.map(row => ({ ...row, status: 'cancelled' })))
    await reopenTask(db, cleanerViewer, turnover.id, { version: skipped.version })
    await runOrganizationJobs(queue, env, db, ORG, now)
    assert.deepEqual(await reminderState(), planned)

    // The evening before, the morning of, and the warning to the hosts two hours before Lee arrives; each once.
    for (const [when, key] of [
      [at(day(2), '18:05'), `reminder:${turnover.id}:evening:${day(3)}`],
      [at(day(3), '08:05'), `reminder:${turnover.id}:morning:${day(3)}`],
      [at(day(3), '13:05'), `warning:${turnover.id}:${turnover.due_at}`],
    ] as const) {
      await runOrganizationJobs(queue, env, db, ORG, when)
      await runOrganizationJobs(queue, env, db, ORG, when)
      assert.equal((await automatic(thread.id)).filter(message => message.key === key).length, 1, key)
    }
    const warningId = await db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND json_extract(payload_json, '$.key') = ?").bind(thread.id, `warning:${turnover.id}:${turnover.due_at}`).first<string>('id')
    assert.equal(await alerted(warningId!), 2, 'both hosts are warned')
    assert.equal(await runOrganizationJobs(queue, env, db, ORG, at(day(3), '13:05')), at(day(4), '18:00').toISOString(), 'only Lee’s turnover is still pending')

    // The home is handed to the cook: the open job follows, the cleaner is told it is no longer theirs, the cook gets it.
    await updateStayHome(env, db, manager, cabin.id, { assigned_member_id: 'm-cook' })
    assert.equal((await taskRow(`turnover:${dee.id}`))!.assigned_member_id, 'm-cook')
    await runOrganizationJobs(queue, env, db, ORG, at(day(3), '13:10'))
    assert.ok((await automatic(thread.id)).some(message => message.key === `released:${turnover.id}`), 'the cleaner is told the job is no longer theirs')
    const cookThreads = (await teamThreads(cook)).filter(item => item.booking_id === dee.id)
    assert.equal(cookThreads.length, 1)
    assert.deepEqual(cookThreads[0]!.participants.map(person => person.id).sort(), ['admin', 'cook', 'owner'])
    assert.ok((await automatic(cookThreads[0]!.id)).some(message => message.key === jobKey(turnover)), 'the job is posted to the cook')

    // The installed iPhone reads the sheet and closes it using its bearer session.
    const password = 'cook-task-fixture-password'
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('cook-account', 'cook', 'credential', 'cook', ?, 0, 0)").bind(await hashPassword(password)).run()
    const signed = await createAuth(env).api.signInEmail({ body: { email: 'cook@example.test', password }, asResponse: true })
    const token = signed.headers.get('set-auth-token')
    assert.ok(token)
    const app = new H3()
    const taskRoute = '/api/organizations/:organization_id/tasks/:task_id'
    app.post(`${taskRoute}/read`, readTaskRoute)
    app.post(`${taskRoute}/complete`, completeTaskRoute)
    const native = async (action: string, body: Record<string, unknown> | FormData): Promise<TaskView> => {
      const headers = new Headers({ authorization: `Bearer ${token}` })
      if (!(body instanceof FormData)) headers.set('content-type', 'application/json')
      const response = await app.request(Object.assign(new Request(`https://proof.example/api/organizations/${ORG}/tasks/${turnover.id}/${action}`, {
        method: 'POST', headers, body: body instanceof FormData ? body : JSON.stringify(body),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      assert.equal(response.status, 200, await response.clone().text())
      return (await response.json() as { task: TaskView }).task
    }
    const open = await native('read', {})
    assert.deepEqual([open.face, open.tag, open.avatar, open.note, open.outcome], ['photo', 'Turnover', null, null, null])
    assert.deepEqual([open.sheet.checkout, open.sheet.checkin], [
      { label: 'Checkout', time: '10:00 AM', guest: 'Dee' },
      { label: 'Check-in', time: '3:00 PM', guest: 'Lee · 1 guest' },
    ])
    // Done without a note is the cook's own message in the conversation, without alerts.
    const closed = await native('complete', { note: null })
    assert.equal(closed.status, 'done')
    assert.deepEqual(closed.outcome, { note: null, photos: [], closed_at: (await taskRow(`turnover:${dee.id}`))!.closed_at, closed_by: 'You' })
    const cookMessages = (await conversationPageFor(db, cook, cookThreads[0]!.id)).entries.filter(entry => entry.type === 'message').reverse()
    assert.deepEqual([cookMessages[0]!.author_user_id, cookMessages[0]!.automatic, cookMessages[0]!.body, cookMessages[0]!.deliveries], ['cook', false, 'Done', []])
    assert.equal((await taskRow(`turnover:${dee.id}`))!.status, 'done')
    // The cook's own message reads the conversation through for them and is unread for the hosts; the cleaner, no longer seated with it, never sees it.
    assert.equal(await isUnread(db, owner, cookThreads[0]!.id), true)
    assert.equal(await isUnread(db, cook, cookThreads[0]!.id), false)
    await assert.rejects(readTeamThread(db, cleaner, cookThreads[0]!.id), { status: 404, data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })
    // A reminder is sent once for a job: the cook, given it at 13:10 after today's reminders went, was told the job itself; a closed job is told about no more.
    assert.deepEqual((await automatic(cookThreads[0]!.id)).map(message => message.key), [jobKey(turnover)])
    await runOrganizationJobs(queue, env, db, ORG, at(day(3), '14:00'))
    assert.equal((await automatic(cookThreads[0]!.id)).length, 1, 'a job a person closed is not told about again')

    const cookViewer = await taskViewer(cook)
    await reopenTask(db, cookViewer, turnover.id, { version: closed.version })
    const outcome = new FormData()
    outcome.set('note', 'Fresh towels are by the door.')
    const pixels = Uint8Array.from(await sharp({ create: { width: 4, height: 3, channels: 3, background: '#16a34a' } }).avif().toBuffer())
    outcome.append('photos', new File([pixels], 'towels.avif', { type: 'image/avif' }))
    const reported = await native('complete', outcome)
    assert.equal(reported.note, '“Fresh towels are by the door.”')
    assert.equal(reported.outcome?.photos.length, 1)
    assert.deepEqual((await getTask(db, cookViewer, turnover.id)).outcome, reported.outcome)
    const report = (await conversationPageFor(db, cook, cookThreads[0]!.id)).entries.find(entry => entry.type === 'message' && entry.body === reported.outcome?.note)
    assert(report?.type === 'message')
    assert.equal(report.photos[0]?.id, reported.outcome?.photos[0]?.id)

    // A cancelled stay cancels its job in the conversation at once.
    const may = await createStay(db, env, manager, { product_id: cabin.id, idempotency_key: 'may', check_in_date: day(6), check_out_date: day(8), adults: 1, guest_name: 'May', guest_email: 'may@example.test', total_minor: 30_000 })
    await runOrganizationJobs(queue, env, db, ORG, at(day(3), '14:00'))
    const mayThread = (await teamThreads(cook)).find(item => item.booking_id === may.id)!
    assert.equal((await automatic(mayThread.id)).length, 1)
    await cancelStay(db, env, manager, may.id, { version: may.version, reason: 'Guest asked', financial_writes_allowed: false })
    await runOrganizationJobs(queue, env, db, ORG, at(day(3), '14:05'))
    assert.deepEqual((await automatic(mayThread.id)).map(message => message.key), [jobKey({ id: (await taskRow(`turnover:${may.id}`))!.id, product_id: cabin.id }), `cancelled:${(await taskRow(`turnover:${may.id}`))!.id}`])

    // A job the owner takes for themselves has its conversation too, with the hosts alone: the job is posted there and its morning reminder follows, once.
    const leeTurnover = (await taskRow(`turnover:${lee.id}`))!
    const ownerViewer = await taskViewer(principal('owner', 'owner'))
    await updateTask(db, ownerViewer, leeTurnover.id, { version: leeTurnover.version, assigned_member_id: 'm-owner' })
    await runOrganizationJobs(queue, env, db, ORG, at(day(5), '08:05'))
    await runOrganizationJobs(queue, env, db, ORG, at(day(5), '08:06'))
    const leeThreads = (await teamThreads(owner)).filter(item => item.booking_id === lee.id)
    const ownThread = leeThreads.find(item => item.participants.every(person => person.id === 'owner' || person.id === 'admin'))!
    assert.deepEqual((await automatic(ownThread.id)).map(message => message.key).filter(key => !key.startsWith('reminder:') || key.includes(':morning:')), [jobKey(leeTurnover), `reminder:${leeTurnover.id}:morning:${day(5)}`])
    // The cook, who had it, is told.
    assert.ok((await automatic(leeThreads.find(item => item.participants.some(person => person.id === 'cook'))!.id)).some(message => message.key === `released:${leeTurnover.id}`))

    // A person's own message in a job conversation counts as unread for the others, from where they read.
    await markConversationRead(db, { organizationId: ORG, conversationId: thread.id, userId: 'cleaner' })
    assert.equal(await isUnread(db, cleaner, thread.id), false)
    await sendConversationMessage(env, { ...await resolveConversationAccess(db, owner.userId, thread.id), userId: owner.userId, body: 'Thanks Cleo', photos: [], idempotencyKey: 'thanks-cleo', senderName: 'Olive Owner' })
    assert.equal(await isUnread(db, cleaner, thread.id), true)
    assert.equal(await isUnread(db, owner, thread.id), false)
  } finally {
    await runtime.dispose()
  }
})
