import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3, H3Event } from 'h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, type StayAccess } from '../../server/domain/stays.ts'
import { requestInsertQueries } from '../../server/domain/requests.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { firstUnansweredGuestEntryTimes, updateThreadProjectionIfLatestEntry } from '../../server/domain/guest-threads/repository.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { createArticleCategory } from '../../server/utils/content/article-categories.ts'
import { createBlogPost, updateBlogLifecycle, updateBlogPost } from '../../server/utils/content/publishing.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import todayRoute from '../../server/api/dashboard/today.get.ts'
import goalCreateRoute from '../../server/api/organizations/[organizationId]/goals.post.ts'
import goalUpdateRoute from '../../server/api/organizations/[organizationId]/goals/[goalId].patch.ts'
import feedbackRoute from '../../server/api/organizations/[organizationId]/recommendation-feedback.put.ts'
import type { TodayCard, TodayFeedPayload } from '../../shared/dashboard-today.ts'
import { localDateAt } from '../../utils/timezone.ts'
import { cancelScheduledGuestMessage, saveMessageTemplate } from '../../server/domain/guest-messaging.ts'
import { cancelSendLaterMessage, createSendLaterMessage, sendDueSendLaterMessages } from '../../server/domain/send-later.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { sendReviewRequestForBooking } from '../../server/utils/review-request-delivery.ts'
import { claimGuestThreadInvite, createGuestThreadInvite } from '../../server/domain/guest-threads/invites.ts'
import { createTableReservation } from '../../server/domain/table-reservations.ts'
import { upsertLocationReservationConfig } from '../../server/utils/reservations.ts'
import { applyResendEmailEvent, deliverReceiptEmail } from '../../server/domain/guest-threads/deliveries.ts'
import type { GuestThreadDeliveryRow } from '../../server/domain/guest-threads/types.ts'

const ORG = 'org', OWNER = 'owner', ZONE = 'America/Denver'
const DAY = 86_400_000

/** Only the provider HTTP boundary is controlled; domain writes, receipts, authorization and reads stay real. */
function providerTransport(t: TestContext) {
  const sent = new Map<string, { to: string[]; subject: string }>()
  let reject = false, sendAttempts = 0
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (init.method === 'GET') {
      const id = url.split('/').at(-1)!, message = sent.get(id)
      assert.ok(message, `unexpected provider read: ${url}`)
      return Response.json({ id, message_id: `<${id}@provider.example>`, to: message.to, subject: message.subject })
    }
    assert.equal(url, 'https://api.resend.com/emails')
    sendAttempts++
    if (reject) return Response.json({ name: 'validation_error', message: 'controlled recipient rejection' }, { status: 422 })
    const id = new Headers(init.headers).get('idempotency-key')!
    assert.ok(id)
    sent.set(id, JSON.parse(String(init.body)))
    return Response.json({ id })
  })
  return { sent, get sendAttempts() { return sendAttempts }, reject(value: boolean) { reject = value }, configuration: { EMAIL_DELIVERY_MODE: 'provider', RESEND_API_KEY: 'controlled-today-provider', EMAIL_FROM: 'Proof <hello@krabiclaw.com>' } }
}

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'dashboard-today-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'dashboard-today-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    const now = new Date().toISOString()
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Lakeside Cabins', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, ?)`).bind(ORG, now, ZONE).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('owner-member', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('location', ?, 'cabin', 'Cabin', 'active', ?, ?, ?)`).bind(ORG, ZONE, now, now).run()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), MEDIA_BASE_URL: 'https://media.example.test', BETTER_AUTH_SECRET: 'dashboard-today-proof-secret-long-enough-for-auth',
      BETTER_AUTH_URL: 'https://proof.example', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_no_provider_requests',
      EMAIL_REPLY_SECRET: 'local-reply-proof', PREVIEW_SECRET: 'dashboard-today-preview-secret', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin', variants: [{ name: 'Cabin', prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
      stay: { location_id: 'location', check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: 'owner-member', assigned_team_id: null },
    } })
    const password = 'TodayProofPassword123!'
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('owner-credential', ?, 'credential', ?, ?, 0, 0)").bind(OWNER, OWNER, await hashPassword(password)).run()
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password }, asResponse: true })
    assert.equal(login.status, 200)
    const token = login.headers.get('set-auth-token')
    assert.ok(token)
    const app = new H3()
    app.get('/api/dashboard/today', todayRoute)
    app.post('/api/organizations/:organizationId/goals', goalCreateRoute)
    app.patch('/api/organizations/:organizationId/goals/:goalId', goalUpdateRoute)
    app.put('/api/organizations/:organizationId/recommendation-feedback', feedbackRoute)
    const call = async <T>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
      const response = await app.request(Object.assign(new Request(`https://proof.example${path}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      const text = await response.text()
      assert.equal(response.status, status, text)
      return JSON.parse(text) as T
    }
    return { runtime, db, env, homeId: home.id, call }
  } catch (error) { await runtime.dispose(); throw error }
}

async function contactThread(db: D1Database, id: string, message: string, createdAt: string) {
  await db.batch(requestInsertQueries({ id, kind: 'contact', organization_id: ORG, location_id: null, user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null,
    payload: { guest: { name: id === 'old-inquiry' ? 'Olive' : 'Rhea', email: `${id}@provider-proof.com`, phone: null }, subject: null, message, consent_at: null, ip_hash: null },
    created_at: createdAt, updated_at: createdAt }).map(write => db.prepare(write.query).bind(...write.params)))
}

test('Today and Upcoming select work from obligations, the owner’s priority and their decisions, and stop once the canonical operation completes', async t => {
  const { runtime, db, env, homeId, call } = await boot()
  try {
    const now = Date.now()
    const today = (range: 'today' | 'upcoming' = 'today', window?: { from: string; to: string }) =>
      call<TodayFeedPayload>('GET', `/api/dashboard/today?org=${ORG}&range=${range}${window ? `&from=${window.from}&to=${window.to}` : ''}`)
    const ids = (feed: TodayFeedPayload) => feed.cards.map(card => card.id)
    const find = (feed: TodayFeedPayload, id: string) => feed.cards.find(card => card.id === id)

    // An old question with no booking behind it, and a question asked an hour ago.
    await contactThread(db, 'old-inquiry', 'Is there parking near the kayak launch for the Saturday kayak trip?', new Date(now - 20 * DAY).toISOString())
    await contactThread(db, 'recent-inquiry', 'Is the cabin pet friendly? We would bring a small dog.', new Date(now - 60 * 60_000).toISOString())
    // An equally old unanswered message about a stay that has not happened yet.
    const checkIn = localDateAt(new Date(now + 10 * DAY), ZONE), checkOut = localDateAt(new Date(now + 12 * DAY), ZONE)
    const manager: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
    const stay = await createStay(db, env, manager, { product_id: homeId, idempotency_key: 'upcoming-stay', check_in_date: checkIn, check_out_date: checkOut, adults: 2,
      guest_name: 'Stella', guest_email: 'stella@provider-proof.com', total_minor: 30_000 })
    const stayThread = (await db.prepare("SELECT id FROM requests WHERE kind = 'stay'").first<{ id: string }>())!.id
    // The guest-message pipeline's own writes, dated when the guest wrote.
    const question = await appendEntry(db, { threadId: stayThread, kind: 'message', actorKind: 'guest', channel: 'email', body: 'What time can we check in?', dedupeKey: 'stay-question', occurredAt: new Date(now - 20 * DAY).toISOString() })
    await updateThreadProjectionIfLatestEntry(db, stayThread, question.id, { conversationState: 'needs_attention' })
    const category = await createArticleCategory(db, { organizationId: ORG, collection: 'blog', name: 'Guides', actorId: OWNER })
    const draft = async (key: string, title: string, excerpt: string) => (await createBlogPost(db as unknown as D1Database, OWNER, { idempotency_key: key, title, excerpt, category_id: category.id,
      content_blocks: [{ type: 'markdown', data: { markdown: excerpt, editor_mode: 'rich' } }] }, { organization_id: ORG }, env)).post as { id: string; updated_at: string }
    const kayak = await draft('kayak', 'Kayak trip packing list', 'What to bring on our Saturday kayak trip.')
    const sourdough = await draft('sourdough', 'Sourdough breakfast guide', 'How our sourdough breakfast is baked each morning.')
    const historyBefore = (await getGuestThreadDetail(db, 'recent-inquiry', ORG))!.entries.length

    // Without a priority: obligations only, with the fact that makes each due.
    let feed = await today()
    assert.deepEqual(feed.priorities, [])
    assert.ok(ids(feed).includes('attention:recent-inquiry'))
    assert.match(find(feed, 'attention:recent-inquiry')!.reason!, /^Rhea wrote .* and has no reply yet\.$/)
    assert.equal(find(feed, `attention:${stayThread}`)?.priority, 'attention', 'age alone does not hide a message about a live stay')
    assert.match(find(feed, `attention:${stayThread}`)!.reason!, /unanswered message about their stay/)
    assert.equal(ids(feed).some(id => id.endsWith(':old-inquiry')), false, 'an old inquiry with no commitment is not work because the guest wrote last')
    assert.equal(ids(feed).some(id => id.startsWith('draft:')), false, 'a draft is not work merely because it exists')
    assert.equal(feed.cards.filter(card => card.priority === 'opportunity').length, 0)

    // A priority makes the work it names worth doing, and says why.
    const { goal: kayakGoal } = await call<{ goal: { id: string; revision: string } }>('POST', `/api/organizations/${ORG}/goals`, { idempotencyKey: 'kayak-goal', intent: 'Fill the remaining places on Saturday’s kayak trip' }, 201)
    feed = await today()
    assert.deepEqual(feed.priorities?.map(priority => priority.id), [kayakGoal.id])
    assert.deepEqual(feed.cards.filter(card => card.priority === 'opportunity').map(card => card.id).sort(), [`draft:${kayak.id}`, 'reply:old-inquiry'].sort())
    assert.match(find(feed, 'reply:old-inquiry')!.reason!, /Olive has had no reply since .*It supports your priority “Fill the remaining places on Saturday’s kayak trip”\./)
    assert.deepEqual(find(feed, `draft:${kayak.id}`)!.decision, { operation: 'article.publish', subjectId: kayak.id, evidenceRevision: find(feed, `draft:${kayak.id}`)!.decision!.evidenceRevision,
      goalId: kayakGoal.id, goalRevision: kayakGoal.revision, revision: null, current: null })

    // Changing the priority changes the optional work.
    await call('PATCH', `/api/organizations/${ORG}/goals/${kayakGoal.id}`, { revision: kayakGoal.revision, status: 'archived' })
    await call('POST', `/api/organizations/${ORG}/goals`, { idempotencyKey: 'bread-goal', intent: 'Promote our sourdough breakfast' }, 201)
    feed = await today()
    assert.deepEqual(feed.cards.filter(card => card.priority === 'opportunity').map(card => card.id), [`draft:${sourdough.id}`])

    // A dismissal survives fresh reads and leaves the work's own record untouched.
    const sourdoughCard = find(feed, `draft:${sourdough.id}`)!
    const decide = (card: TodayCard, decision: string, extra: Record<string, unknown> = {}) => call<{ feedback: { id: string; decision: string } }>('PUT', `/api/organizations/${ORG}/recommendation-feedback`, {
      operation: card.decision!.operation, subjectId: card.decision!.subjectId, evidenceRevision: card.decision!.evidenceRevision, revision: card.decision!.revision, decision,
      ...(card.decision!.goalId ? { goalId: card.decision!.goalId, goalRevision: card.decision!.goalRevision } : {}), ...extra,
    })
    await decide(sourdoughCard, 'dismiss')
    assert.equal(ids(await today()).includes(`draft:${sourdough.id}`), false)
    assert.equal(ids(await today()).includes(`draft:${sourdough.id}`), false)
    const stored = await db.prepare('SELECT status, updated_at FROM content_documents WHERE id = ?').bind(sourdough.id).first<{ status: string; updated_at: string }>()
    assert.deepEqual(stored, { status: 'draft', updated_at: sourdough.updated_at })

    // New evidence brings it back with the reason it returned.
    const edited = await updateBlogPost(db as unknown as D1Database, sourdough.id, { excerpt: 'How our sourdough breakfast loaves are baked before sunrise.', expected_updated_at: sourdough.updated_at }, ORG, OWNER, env) as { post: { updated_at: string } }
    feed = await today()
    assert.match(find(feed, `draft:${sourdough.id}`)!.reason!, /^This draft changed since you dismissed it on /)

    // Preparation planned for a later day appears on that day, ahead of the stay it precedes.
    const recentCard = find(feed, 'attention:recent-inquiry')!
    const deferUntil = new Date(now + 3 * DAY).toISOString()
    await decide(recentCard, 'defer', { deferUntil, note: 'Waiting for the owner to confirm the pet policy.' })
    feed = await today()
    assert.equal(ids(feed).includes('attention:recent-inquiry'), false)
    const upcoming = await today('upcoming', { from: localDateAt(new Date(now + DAY), ZONE), to: localDateAt(new Date(now + 20 * DAY), ZONE) })
    const planned = find(upcoming, 'attention:recent-inquiry')!
    assert.equal(planned.actionAt, deferUntil)
    assert.match(planned.eyebrow, /^Planned for /)
    assert.match(planned.reason!, /You set this aside until .* Your note: “Waiting for the owner to confirm the pet policy\.”$/)
    const arrival = `stay:${stay.id}:arrival`
    assert.ok(ids(upcoming).indexOf('attention:recent-inquiry') < ids(upcoming).indexOf(arrival), 'the planned action precedes the stay it prepares for')
    assert.equal((await getGuestThreadDetail(db, 'recent-inquiry', ORG))!.entries.length, historyBefore, 'a decision never edits conversation history')

    // Completing the work through its own operation removes it on the next read.
    await updateBlogLifecycle(db as unknown as D1Database, sourdough.id, { expected_updated_at: edited.post.updated_at }, ORG, OWNER)
    const provider = providerTransport(t)
    const response = await executeGuestThreadOperation(db, { threadId: stayThread, organizationId: ORG, action: 'reply', body: 'Check-in opens at 4pm.', actorUserId: OWNER, idempotencyKey: 'stay-reply', env: { ...env, ...provider.configuration } })
    assert.equal(response.ok, true, JSON.stringify(response))
    feed = await today()
    assert.equal(ids(feed).includes(`draft:${sourdough.id}`), false)
    assert.equal(ids(feed).includes(`attention:${stayThread}`), false)
    assert.equal(feed.cards.filter(card => card.priority === 'opportunity').length, 0, 'with nothing worth doing, no optional work is invented')

    // A physically accepted reply answers the guest, but its own recorded completion error still needs attention.
    const receipt = (await db.prepare(`SELECT d.* FROM guest_thread_deliveries d JOIN activity_entries e ON e.id=d.entry_id
      WHERE e.request_id=? AND e.event_name='thread.member_reply' AND d.purpose='member_reply' AND d.channel='email'`).bind(stayThread).first<GuestThreadDeliveryRow>())!
    assert.ok(receipt)
    assert.equal(receipt.status, 'sent')
    assert.equal(receipt.error, null)
    assert.ok(receipt.provider_message_id)
    assert.match(receipt.email_message_id!, /^<.+@provider\.example>$/)
    await db.prepare(`CREATE TRIGGER reject_direct_reply_completion BEFORE UPDATE OF error ON guest_thread_deliveries
      WHEN OLD.id='${receipt.id.replaceAll("'", "''")}' AND NEW.error IS NULL BEGIN SELECT RAISE(ABORT,'controlled direct reply completion failure'); END`).run()
    const snapshot = JSON.parse(receipt.email_json!) as { message: Parameters<typeof deliverReceiptEmail>[1]['email'] }
    await assert.rejects(deliverReceiptEmail(db, { delivery: receipt, env: { ...env, ...provider.configuration }, threadId: stayThread, email: snapshot.message }), (error: Error) => {
      assert.ok(error.cause instanceof Error)
      assert.match(error.cause.message, /controlled direct reply completion failure/)
      return true
    })
    await db.prepare('DROP TRIGGER reject_direct_reply_completion').run()
    assert.equal((await firstUnansweredGuestEntryTimes(db, ORG, [stayThread])).has(stayThread), false, 'saved metadata failure does not undo the actual customer reply')
    feed = await today()
    const attention = find(feed, `attention:${stayThread}`)!
    assert.equal(attention.priority, 'attention')
    assert.equal(attention.headline, 'Check the message to Stella')
    assert.equal(attention.reason, await db.prepare('SELECT error FROM guest_thread_deliveries WHERE id=?').bind(receipt.id).first('error'))
    assert.equal(provider.sendAttempts, 1)
    const deliveredEvent = { type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: receipt.provider_message_id!,
      created_at: new Date().toISOString(), from: 'hello@krabiclaw.com', to: ['stella@provider-proof.com'], subject: 'Proof', message_id: receipt.email_message_id! } } as Parameters<typeof applyResendEmailEvent>[2]
    assert.equal(await applyResendEmailEvent(db, env, deliveredEvent), 'advanced')
    feed = await today()
    assert.equal(feed.cards.some(card => card.id === `attention:${stayThread}`), false)
    assert.deepEqual(await db.prepare('SELECT status,error FROM guest_thread_deliveries WHERE id=?').bind(receipt.id).first(), { status: 'delivered', error: null })
    assert.equal(provider.sendAttempts, 1, 'the provider callback recovers the saved completion without sending another reply')
  } finally {
    await runtime.dispose()
  }
})

test('Today reads actual scheduled work and review outcomes: cancellation and success clear work, and failed or unconfirmed delivery stays actionable', async t => {
  const reference = new Date()
  reference.setUTCHours(18, 0, 0, 0)
  t.mock.timers.enable({ apis: ['Date'], now: reference })
  const { runtime, db, env, homeId, call } = await boot()
  try {
    const now = Date.now(), access: StayAccess = { organizationId: ORG, actorId: OWNER, manage: true }
    const principal = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: OWNER }))!, { env })
    const read = (range = 'today') => call<TodayFeedPayload>('GET', `/api/dashboard/today?org=${ORG}&range=${range}${range === 'upcoming' ? `&from=${localDateAt(new Date(now + DAY), ZONE)}&to=${localDateAt(new Date(now + 7 * DAY), ZONE)}` : ''}`)
    const stay = await createStay(db, env, access, { product_id: homeId, idempotency_key: 'scheduled-stay', check_in_date: localDateAt(new Date(now + 3 * DAY), ZONE),
      check_out_date: localDateAt(new Date(now + 5 * DAY), ZONE), adults: 2, guest_name: 'Stella', guest_email: 'stella@provider-proof.com', total_minor: 30_000 })
    const template = await saveMessageTemplate(db, env, access, null, { title: 'Arrival reminder', body: 'Your cabin will be ready after 4pm.',
      schedule: { trigger: 'check_in', offsetDays: -1, localTime: '09:00', productIds: [homeId] } })
    const planned = await db.prepare('SELECT id,status,due_at FROM scheduled_guest_messages WHERE template_id=? AND stay_id=?').bind(template.id, stay.id).first<{ id: string; status: string; due_at: string }>()
    assert.ok(planned)
    let feed = await read('upcoming')
    const automatic = feed.cards.find(card => card.id === `automatic-message:${planned.id}`)
    assert.ok(automatic)
    assert.equal(automatic.actionAt, planned.due_at)
    assert.match(automatic.reason!, /^Automatic · /)
    await cancelScheduledGuestMessage(db, env, access, planned.id)
    assert.equal(await db.prepare('SELECT status FROM scheduled_guest_messages WHERE id=?').bind(planned.id).first('status'), 'cancelled')
    assert.equal((await read('upcoming')).cards.some(card => card.id === automatic.id), false)

    const abandoned = await createSendLaterMessage(db, principal, stay.request_id!, { body: 'An unnecessary follow-up.', sendAt: new Date(now + DAY).toISOString() })
    assert.equal((await read('upcoming')).cards.filter(card => card.id === `send-later:${abandoned.id}`).length, 1)
    await cancelSendLaterMessage(db, principal, abandoned.id)
    assert.equal((await read('upcoming')).cards.some(card => card.id === `send-later:${abandoned.id}`), false)

    const provider = providerTransport(t), providerEnv = { ...env, ...provider.configuration }
    const later = await createSendLaterMessage(db, principal, stay.request_id!, { body: 'Your cabin is ready.', sendAt: new Date(now + 60_000).toISOString() })
    assert.equal((await read()).cards.find(card => card.id === `send-later:${later.id}`)?.priority, 'schedule')
    t.mock.timers.tick(120_000)
    const sentResult = await sendDueSendLaterMessages(db, providerEnv)
    assert.deepEqual(sentResult, { sent: 1, failed: 0, needs_review: 0 }, JSON.stringify(await db.prepare('SELECT status,reason,error_code FROM send_later_messages WHERE id=?').bind(later.id).first()))
    const sent = await db.prepare('SELECT status,sent_at,entry_id FROM send_later_messages WHERE id=?').bind(later.id).first<{ status: string; sent_at: string; entry_id: string }>()
    assert.equal(sent?.status, 'sent')
    feed = await read()
    assert.ok(sent?.sent_at)
    assert.equal(feed.cards.some(card => card.id === `send-later:${later.id}`), false)
    const receipt = (await db.prepare('SELECT * FROM guest_thread_deliveries WHERE entry_id=? AND purpose=?').bind(sent!.entry_id, 'member_reply').first<GuestThreadDeliveryRow>())!
    assert.equal(receipt.status, 'sent')
    assert.equal(receipt.error, null)
    assert.ok(receipt.provider_message_id)
    assert.match(receipt.email_message_id!, /^<.+@provider\.example>$/)
    // A later completion/metadata error is visible even though dispatch itself already succeeded.
    await db.prepare(`CREATE TRIGGER reject_delivery_completion BEFORE UPDATE OF error ON guest_thread_deliveries
      WHEN OLD.id='${receipt.id.replaceAll("'", "''")}' AND NEW.error IS NULL BEGIN SELECT RAISE(ABORT,'controlled completion failure'); END`).run()
    const snapshot = JSON.parse(receipt.email_json!) as { message: Parameters<typeof deliverReceiptEmail>[1]['email'] }
    await assert.rejects(deliverReceiptEmail(db, { delivery: receipt, env: providerEnv, threadId: stay.request_id!, email: snapshot.message }), (error: Error) => {
      assert.ok(error.cause instanceof Error)
      assert.match(error.cause.message, /controlled completion failure/)
      return true
    })
    await db.prepare('DROP TRIGGER reject_delivery_completion').run()
    let attention = (await read()).cards.find(card => card.id === `send-later:${later.id}`)
    assert.equal(attention?.priority, 'attention')
    assert.equal(attention!.reason, await db.prepare('SELECT error FROM guest_thread_deliveries WHERE id=?').bind(receipt.id).first('error'))
    const deliveredEvent = { type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: receipt.provider_message_id!,
      created_at: new Date().toISOString(), from: 'hello@krabiclaw.com', to: ['stella@provider-proof.com'], subject: 'Proof', message_id: receipt.email_message_id! } } as Parameters<typeof applyResendEmailEvent>[2]
    assert.equal(await applyResendEmailEvent(db, env, deliveredEvent), 'advanced')
    attention = (await read()).cards.find(card => card.id === `send-later:${later.id}`)
    assert.equal(attention, undefined)
    assert.deepEqual(await db.prepare('SELECT status,error FROM guest_thread_deliveries WHERE id=?').bind(receipt.id).first(), { status: 'delivered', error: null })
    assert.equal(provider.sent.size, 1, 'receipt recovery never sends another email')

    const failure = await createSendLaterMessage(db, principal, stay.request_id!, { body: 'Please call about arrival.', sendAt: new Date(Date.now() + 60_000).toISOString() })
    provider.reject(true)
    t.mock.timers.tick(120_000)
    assert.deepEqual(await sendDueSendLaterMessages(db, providerEnv), { sent: 0, failed: 1, needs_review: 0 })
    const failedCard = (await read()).cards.find(card => card.id === `send-later:${failure.id}`)
    assert.equal(failedCard?.priority, 'attention')
    assert.match(failedCard!.reason!, /controlled recipient rejection/)
    provider.reject(false)
    const willBounce = await createSendLaterMessage(db, principal, stay.request_id!, { body: 'Please review your arrival details.', sendAt: new Date(Date.now() + 60_000).toISOString() })
    t.mock.timers.tick(120_000)
    assert.deepEqual(await sendDueSendLaterMessages(db, providerEnv), { sent: 1, failed: 0, needs_review: 0 })
    const bounceReceipt = (await db.prepare('SELECT d.* FROM guest_thread_deliveries d JOIN send_later_messages m ON m.entry_id=d.entry_id WHERE m.id=? AND d.purpose=?').bind(willBounce.id, 'member_reply').first<GuestThreadDeliveryRow>())!
    assert.equal(await applyResendEmailEvent(db, env, { ...deliveredEvent, type: 'email.bounced', data: { ...deliveredEvent.data, email_id: bounceReceipt.provider_message_id!, message_id: bounceReceipt.email_message_id!,
      bounce: { type: 'Permanent', subType: 'General', message: 'mailbox unavailable' } } } as Parameters<typeof applyResendEmailEvent>[2]), 'advanced')
    const bounced = (await read()).cards.find(card => card.id === `send-later:${willBounce.id}`)
    assert.equal(bounced?.priority, 'attention')
    assert.match(bounced!.reason!, /mailbox unavailable/)
    assert.equal((await read('upcoming')).cards.some(card => card.id === bounced!.id), false)

    // The existing review dispatch owns the automatic work and marks its real success.
    await db.prepare("INSERT INTO organization_domains (id,organization_id,domain,role,status,type) VALUES ('review-domain',?,'cabin.example','canonical','active','custom')").bind(ORG).run()
    await db.prepare("INSERT INTO subscription (id,plan,referenceId,status,periodEnd) VALUES ('review-plan','growth',?,'active',4102444800)").bind(ORG).run()
    await db.prepare('UPDATE business_locations SET max_capacity=8,opening_hours=? WHERE id=?').bind(JSON.stringify({ periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 9, minute: 0 }, close: { day, hour: 21, minute: 0 } })) }), 'location').run()
    await upsertLocationReservationConfig(db, { organizationId: ORG, locationId: 'location', patch: { duration_minutes: 60, slot_capacity: 8 }, actorId: OWNER })
    const reservationRequest = Object.assign(new Request('https://proof.example/api/mcp'), { runtime: { cloudflare: { env } } })
    const reservation = await createTableReservation(new H3Event(reservationRequest), { organizationId: ORG, financialWritesAllowed: false,
      operator: { userId: OWNER, idempotencyKey: 'today-confirmed-reservation', source: 'operator', externalReference: null, guestAcknowledgement: false },
      body: { name: 'Ravi', email: 'ravi@provider-proof.com', phone: '+66812345678', date: localDateAt(new Date(Date.now() + DAY), ZONE), time: '12:00', guests: '2', location_id: 'location' } })
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body))
    const reservationId = String(reservation.body.request_id)
    assert.equal(await db.prepare('SELECT status FROM reservations WHERE request_id=?').bind(reservationId).first('status'), 'confirmed')
    assert.equal((await read()).cards.some(card => card.id.endsWith(`:${reservationId}`)), false, 'a confirmed future reservation is not work due today')
    assert.equal((await read('upcoming')).cards.find(card => card.id === `reservation:${reservationId}`)?.priority, 'schedule')
    const ended = await createStay(db, env, access, { product_id: homeId, idempotency_key: 'ended-stay', check_in_date: localDateAt(new Date(now - 5 * DAY), ZONE),
      check_out_date: localDateAt(new Date(now - 2 * DAY), ZONE), adults: 1, guest_name: 'Rhea', guest_email: 'rhea@provider-proof.com', total_minor: 45_000 })
    const guest = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
    const invite = await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: ended.request_id!, actorUserId: OWNER })
    await claimGuestThreadInvite(db, { token: new URL(invite.url).pathname.split('/').at(-1)!, userId: guest.response!.user.id })
    const justEnded = await createStay(db, env, access, { product_id: homeId, idempotency_key: 'just-ended-stay', check_in_date: localDateAt(new Date(now - DAY), ZONE),
      check_out_date: localDateAt(new Date(now), ZONE), adults: 1, guest_name: 'Rhea', guest_email: 'rhea@provider-proof.com', total_minor: 15_000 })
    const freshInvite = await createGuestThreadInvite(db, env, { organizationId: ORG, threadId: justEnded.request_id!, actorUserId: OWNER })
    await claimGuestThreadInvite(db, { token: new URL(freshInvite.url).pathname.split('/').at(-1)!, userId: guest.response!.user.id })
    const futureReview = (await read('upcoming')).cards.find(card => card.id === `review-invitation:${justEnded.request_id}`)
    assert.ok(futureReview)
    assert.equal(futureReview.priority, 'schedule')
    assert.equal(localDateAt(new Date(futureReview.actionAt!), ZONE), localDateAt(new Date(now + DAY), ZONE))
    assert.equal((await read()).cards.some(card => card.id === futureReview.id), false)
    const dueReview = (await read()).cards.find(card => card.id === `review-invitation:${ended.request_id}`)
    assert.ok(dueReview)
    assert.equal(dueReview.priority, 'schedule', 'automatic work with no failure is not an invented owner action')
    const ordered = (await read()).cards
    const firstScheduled = ordered.findIndex(card => card.priority === 'schedule')
    assert.ok(firstScheduled > 0)
    assert.equal(ordered.slice(firstScheduled).some(card => card.priority === 'attention'), false, 'attention cannot be pushed behind scheduled work by pagination')

    const delivered = await sendReviewRequestForBooking(providerEnv, db, 'stay', ended.request_id!)
    assert.equal(delivered.sent, true)
    const visit = await db.prepare('SELECT first_sent_at,send_count FROM review_requests WHERE booking_id=?').bind(ended.request_id).first<{ first_sent_at: string; send_count: number }>()
    assert.equal(visit?.send_count, 1)
    feed = await read()
    assert.equal(feed.cards.some(card => card.id === dueReview.id), false)
    assert.ok(visit?.first_sent_at)
    await assert.rejects(sendReviewRequestForBooking(providerEnv, db, 'stay', ended.request_id!), /not due a review invitation/)
    assert.equal((await read()).cards.some(card => card.id === dueReview.id), false)
    assert.equal(provider.sent.size, 3, 'two scheduled sends and one invitation reached the controlled provider')

    const reviewReceipt = (await db.prepare(`SELECT d.* FROM guest_thread_deliveries d JOIN activity_entries e ON e.id=d.entry_id
      WHERE e.dedupe_key=? AND d.channel='email' AND d.purpose='status_update'`).bind(`review-request:${delivered.requestId}`).first<GuestThreadDeliveryRow>())!
    assert.ok(reviewReceipt)
    const attemptsBeforeReviewRecovery = provider.sendAttempts
    await db.prepare(`CREATE TRIGGER reject_review_completion BEFORE UPDATE OF error ON guest_thread_deliveries
      WHEN OLD.id='${reviewReceipt.id.replaceAll("'", "''")}' AND NEW.error IS NULL BEGIN SELECT RAISE(ABORT,'controlled review completion failure'); END`).run()
    const reviewSnapshot = JSON.parse(reviewReceipt.email_json!) as { message: Parameters<typeof deliverReceiptEmail>[1]['email'] }
    await assert.rejects(deliverReceiptEmail(db, { delivery: reviewReceipt, env: providerEnv, threadId: ended.request_id!, email: reviewSnapshot.message }), (error: Error) => {
      assert.ok(error.cause instanceof Error)
      assert.match(error.cause.message, /controlled review completion failure/)
      return true
    })
    await db.prepare('DROP TRIGGER reject_review_completion').run()
    feed = await read()
    assert.equal(feed.cards.find(card => card.id === `review-invitation:${ended.request_id}`)?.priority, 'attention')
    assert.equal(await applyResendEmailEvent(db, env, { ...deliveredEvent, data: { ...deliveredEvent.data, email_id: reviewReceipt.provider_message_id!,
      message_id: reviewReceipt.email_message_id!, to: ['rhea@provider-proof.com'] } } as Parameters<typeof applyResendEmailEvent>[2]), 'advanced')
    feed = await read()
    assert.equal(feed.cards.some(card => card.id === `review-invitation:${ended.request_id}`), false)
    assert.deepEqual(await db.prepare('SELECT status,error FROM guest_thread_deliveries WHERE id=?').bind(reviewReceipt.id).first(), { status: 'delivered', error: null })
    assert.deepEqual(await db.prepare('SELECT first_sent_at,send_count FROM review_requests WHERE booking_id=?').bind(ended.request_id).first(), visit)
    assert.equal(provider.sendAttempts, attemptsBeforeReviewRecovery, 'the recovered invitation keeps its original completion and sends no repeat email')
    assert.equal(feed.cards.some(card => /paid sale|gems|coins|recipe points/i.test(card.headline)), false)
    const other = await createAuth(env).api.signInAnonymous({ headers: new Headers(), returnHeaders: true })
    await createAuth(env).api.addMember({ body: { organizationId: ORG, userId: other.response!.user.id, role: 'admin' } })
    const teammate = memberAccessPrincipal((await resolveMembership(env, { organizationId: ORG, userId: other.response!.user.id }))!, { env })
    const teamReply = await createSendLaterMessage(db, teammate, stay.request_id!, { body: 'The office can help with directions.', sendAt: new Date(Date.now() + 60_000).toISOString() })
    assert.equal((await read()).cards.some(card => card.id === `send-later:${teamReply.id}`), false, 'another member’s unsent reply remains private')
    t.mock.timers.tick(120_000)
    assert.deepEqual(await sendDueSendLaterMessages(db, providerEnv), { sent: 1, failed: 0, needs_review: 0 })
    const teamSent = (await db.prepare('SELECT status,entry_id FROM send_later_messages WHERE id=?').bind(teamReply.id).first<{ status: string; entry_id: string }>())!
    assert.equal(teamSent.status, 'sent')
    assert.equal((await read()).cards.some(card => card.id === `send-later:${teamReply.id}`), false)
    const teamReceipt = (await db.prepare('SELECT * FROM guest_thread_deliveries WHERE entry_id=? AND purpose=?').bind(teamSent.entry_id, 'member_reply').first<GuestThreadDeliveryRow>())!
    assert.equal(teamReceipt.status, 'sent')
    assert.equal(teamReceipt.error, null)
    assert.equal(await applyResendEmailEvent(db, env, { ...deliveredEvent, type: 'email.bounced', data: { ...deliveredEvent.data, email_id: teamReceipt.provider_message_id!, message_id: teamReceipt.email_message_id!,
      bounce: { type: 'Permanent', subType: 'General', message: 'teammate delivery failed' } } } as Parameters<typeof applyResendEmailEvent>[2]), 'advanced')
    const teamFailure = (await read()).cards.find(card => card.id === `send-later:${teamReply.id}`)
    assert.equal(teamFailure?.priority, 'attention', 'a teammate’s already-sent message is shared work when its delivery later fails')
    assert.match(teamFailure!.reason!, /teammate delivery failed/)

    const teamPrivate = await createSendLaterMessage(db, teammate, stay.request_id!, { body: 'Private draft for tomorrow.', sendAt: new Date(Date.now() + DAY).toISOString() })
    assert.equal((await read('upcoming')).cards.some(card => card.id === `send-later:${teamPrivate.id}`), false)

    // A log-only run records its simulated send, but supplies no real delivery proof.
    const preview = await createSendLaterMessage(db, principal, stay.request_id!, { body: 'Transport preview only.', sendAt: new Date(Date.now() + 60_000).toISOString() })
    t.mock.timers.tick(120_000)
    assert.deepEqual(await sendDueSendLaterMessages(db, env), { sent: 1, failed: 0, needs_review: 0 })
    assert.deepEqual(await db.prepare('SELECT m.status,d.provider FROM send_later_messages m JOIN guest_thread_deliveries d ON d.entry_id=m.entry_id WHERE m.id=?').bind(preview.id).first(), { status: 'sent', provider: 'log_only' })
    const unconfirmed = (await read()).cards.find(card => card.id === `send-later:${preview.id}`)
    assert.equal(unconfirmed?.priority, 'attention')
    assert.equal(unconfirmed?.reason, 'No successful delivery is recorded for this message.')
    assert.equal(provider.sent.size, 4)
    t.mock.timers.tick(DAY)
    const tomorrow = await read()
    assert.equal(tomorrow.cards.find(card => card.id === `send-later:${failure.id}`)?.priority, 'attention', 'an unresolved send failure survives midnight')
    assert.equal(tomorrow.cards.some(card => card.id === dueReview.id), false, 'a sent invitation does not become pending work again on the next day')
  } finally {
    await runtime.dispose()
    t.mock.timers.reset()
  }
})
