import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { createStay, type StayAccess } from '../../server/domain/stays.ts'
import { requestInsertQueries } from '../../server/domain/requests.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { updateThreadProjectionIfLatestEntry } from '../../server/domain/guest-threads/repository.ts'
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

const ORG = 'org', OWNER = 'owner', ZONE = 'America/Denver'
const DAY = 86_400_000

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
    payload: { guest: { name: id === 'old-inquiry' ? 'Olive' : 'Rhea', email: `${id}@guest.example`, phone: null }, subject: null, message, consent_at: null, ip_hash: null },
    created_at: createdAt, updated_at: createdAt }).map(write => db.prepare(write.query).bind(...write.params)))
}

test('Today and Upcoming select work from obligations, the owner’s priority and their decisions, and stop once the canonical operation completes', async () => {
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
      guest_name: 'Stella', guest_email: 'stella@guest.example', total_minor: 30_000 })
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
    await executeGuestThreadOperation(db, { threadId: stayThread, organizationId: ORG, action: 'reply', body: 'Check-in opens at 4pm.', actorUserId: OWNER, idempotencyKey: 'stay-reply', env })
    feed = await today()
    assert.equal(ids(feed).includes(`draft:${sourdough.id}`), false)
    assert.equal(ids(feed).includes(`attention:${stayThread}`), false)
    assert.equal(feed.cards.filter(card => card.priority === 'opportunity').length, 0, 'with nothing worth doing, no optional work is invented')
  } finally {
    await runtime.dispose()
  }
})
