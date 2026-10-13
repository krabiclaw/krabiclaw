import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { requestInsertQueries } from '../../server/domain/requests.ts'
import { appendEntry } from '../../server/domain/guest-threads/entries.ts'
import { sendEmail } from '../../server/utils/email-delivery.ts'
import { applyResendEmailEvent, compareDeliveryStatus, getDeliveryById } from '../../server/domain/guest-threads/deliveries.ts'
import { reconcileProductNewsContacts, reconcileProductNewsFromProvider, syncProductNewsContact } from '../../server/domain/product-news-contacts.ts'
import { disableCategoryEmail, getNotificationPreferences, setNotificationPreference } from '../../server/domain/notification-preferences.ts'
import { runArticleBroadcast } from '../../server/domain/article-broadcast.ts'

const SEGMENT = 'segment-product-news'
const TOPIC = 'topic-product-news'
const PROVIDER_ENV = {
  EMAIL_DELIVERY_MODE: 'provider',
  RESEND_API_KEY: 're_controlled_fake_resend',
  RESEND_PRODUCT_NEWS_SEGMENT_ID: SEGMENT,
  RESEND_PRODUCT_NEWS_TOPIC_ID: TOPIC,
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'proof.example',
}

interface FakeContact { id: string; email: string; unsubscribed: boolean; segments: Set<string>; topics: Map<string, 'opt_in' | 'opt_out'> }
interface FakeCall { method: string; path: string; body: unknown; idempotencyKey: string | null }

/**
 * Resend's HTTP API as the SDK calls it, held in memory. The SDK under test
 * is the real one; only the network below it is replaced.
 */
function fakeResend(t: TestContext) {
  const contacts = new Map<string, FakeContact>()
  const broadcasts = new Map<string, { status: 'draft' | 'sent'; body: Record<string, unknown> }>()
  const calls: FakeCall[] = []
  const failures = new Map<string, number>()
  let sequence = 0
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const notFound = () => json({ statusCode: 404, name: 'not_found', message: 'Not found' }, 404)
  const find = (key: string) => contacts.get(key) ?? [...contacts.values()].find(contact => contact.id === key)

  t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://api.resend.com')
    const method = init.method ?? 'GET'
    const path = decodeURIComponent(url.pathname)
    const body = init.body ? JSON.parse(String(init.body)) : null
    const idempotencyKey = new Headers(init.headers).get('Idempotency-Key')
    calls.push({ method, path, body, idempotencyKey })
    const route = `${method} ${path}`
    const remaining = [...failures.keys()].find(prefix => route.startsWith(prefix))
    if (remaining) {
      const count = failures.get(remaining)!
      if (count <= 1) failures.delete(remaining)
      else failures.set(remaining, count - 1)
      return json({ statusCode: 500, name: 'internal_server_error', message: `injected failure for ${route}` }, 500)
    }
    let match: RegExpMatchArray | null
    if (route === 'POST /emails') return json({ id: `email-${++sequence}` })
    if (route === 'POST /contacts') {
      const contact: FakeContact = {
        id: `contact-${++sequence}`, email: body.email, unsubscribed: body.unsubscribed ?? false,
        segments: new Set((body.segments ?? []).map((segment: { id: string }) => segment.id)),
        topics: new Map((body.topics ?? []).map((topic: { id: string; subscription: 'opt_in' | 'opt_out' }) => [topic.id, topic.subscription])),
      }
      contacts.set(contact.email, contact)
      return json({ object: 'contact', id: contact.id })
    }
    if ((match = path.match(/^\/segments\/([^/]+)\/contacts$/)) && method === 'GET') {
      const members = [...contacts.values()].filter(contact => contact.segments.has(match![1]!))
      return json({ object: 'list', has_more: false, data: members.map(({ id, email, unsubscribed }) => ({ id, email, unsubscribed })) })
    }
    if ((match = path.match(/^\/contacts\/([^/]+)\/segments\/([^/]+)$/))) {
      const contact = find(match[1]!)
      if (!contact) return notFound()
      if (method === 'POST') contact.segments.add(match[2]!)
      else contact.segments.delete(match[2]!)
      return json({ id: match[2] })
    }
    if ((match = path.match(/^\/contacts\/([^/]+)\/segments$/))) {
      const contact = find(match[1]!)
      if (!contact) return notFound()
      return json({ object: 'list', has_more: false, data: [...contact.segments].map(id => ({ id, name: id, created_at: '' })) })
    }
    if ((match = path.match(/^\/contacts\/([^/]+)\/topics$/))) {
      const contact = find(match[1]!)
      if (!contact) return notFound()
      if (method === 'PATCH') {
        for (const topic of body) contact.topics.set(topic.id, topic.subscription)
        return json({ id: contact.id })
      }
      return json({ object: 'list', has_more: false, data: [{ id: TOPIC, name: 'Product News', description: null, subscription: contact.topics.get(TOPIC) ?? 'opt_in' }] })
    }
    if ((match = path.match(/^\/contacts\/([^/]+)$/))) {
      const contact = find(match[1]!)
      if (!contact) return notFound()
      if (method === 'PATCH') {
        if (typeof body.unsubscribed === 'boolean') contact.unsubscribed = body.unsubscribed
        return json({ object: 'contact', id: contact.id })
      }
      return json({ object: 'contact', id: contact.id, email: contact.email, unsubscribed: contact.unsubscribed, created_at: '', first_name: null, last_name: null, properties: {} })
    }
    if (route === 'POST /broadcasts') {
      const id = `broadcast-${++sequence}`
      broadcasts.set(id, { status: body.send ? 'sent' : 'draft', body })
      return json({ id })
    }
    if ((match = path.match(/^\/broadcasts\/([^/]+)\/send$/))) {
      const broadcast = broadcasts.get(match[1]!)
      if (!broadcast) return notFound()
      if (broadcast.status !== 'draft') return json({ statusCode: 422, name: 'validation_error', message: 'Broadcast already sent' }, 422)
      broadcast.status = 'sent'
      return json({ id: match[1] })
    }
    if ((match = path.match(/^\/broadcasts\/([^/]+)$/))) {
      const broadcast = broadcasts.get(match[1]!)
      if (!broadcast) return notFound()
      if (method === 'DELETE') { broadcasts.delete(match[1]!); return json({ object: 'broadcast', id: match[1], deleted: true }) }
      return json({ object: 'broadcast', id: match[1], status: broadcast.status })
    }
    throw new Error(`Unhandled fake Resend route ${route}`)
  })

  return {
    contacts, broadcasts, calls,
    failNext(routePrefix: string, times = 1) { failures.set(routePrefix, times) },
    addContact(email: string, state: { unsubscribed?: boolean; segments?: string[]; topic?: 'opt_in' | 'opt_out' }) {
      contacts.set(email, { id: `contact-${++sequence}`, email, unsubscribed: state.unsubscribed ?? false, segments: new Set(state.segments ?? []), topics: new Map(state.topic ? [[TOPIC, state.topic]] : []) })
    },
    writes() { return calls.filter(call => call.method !== 'GET') },
  }
}

async function runtimeWithSchema() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'resend-native-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `
      export class Hub {
        constructor(ctx) { this.ctx = ctx }
        async fetch(request) {
          if (new URL(request.url).pathname === '/observed') return Response.json((await this.ctx.storage.get('observed')) ?? [])
          const observed = (await this.ctx.storage.get('observed')) ?? []
          observed.push(await request.json())
          await this.ctx.storage.put('observed', observed)
          return new Response(null, { status: 204 })
        }
      }
      export default { fetch() { return new Response('ok') } }
    ` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'resend-native-proof', exportName: 'Hub' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
  const bindings = await runtime.getBindings<{ GUEST_INBOX_HUBS: DurableObjectNamespace }>()
  return { runtime, db, hubs: bindings.GUEST_INBOX_HUBS }
}

const emailEvent = (type: string, emailId: string, extra: Record<string, unknown> = {}) => ({
  type, created_at: '2026-09-27T00:00:00.000Z',
  data: { email_id: emailId, created_at: '2026-09-27T00:00:00.000Z', from: 'hello@krabiclaw.com', to: ['guest@provider-proof.com'], subject: 'Proof', message_id: '<proof>', ...extra },
}) as Parameters<typeof applyResendEmailEvent>[2]

test('transactional email goes through resend.emails.send with the existing result semantics', async (t) => {
  const resend = fakeResend(t)
  const input = {
    to: 'guest@provider-proof.com', subject: 'Proof subject', html: '<p>Proof</p>', text: 'Proof', replyTo: 'reply@proof.example',
    fromName: 'Proof Cafe', idempotencyKey: 'guest-thread-email:proof', unsubscribeOneClickUrl: 'https://proof.example/api/public/notifications/unsubscribe?token=t',
  }

  assert.deepEqual(await sendEmail({ ...PROVIDER_ENV }, input), { status: 'sent', messageId: 'email-1' })
  const [sent] = resend.calls
  assert.equal(sent!.idempotencyKey, 'guest-thread-email:proof')
  assert.deepEqual(sent!.body, {
    from: 'Proof Cafe <hello@krabiclaw.com>', to: ['guest@provider-proof.com'], reply_to: 'reply@proof.example',
    subject: 'Proof subject', html: '<p>Proof</p>', text: 'Proof',
    headers: { 'List-Unsubscribe': '<https://proof.example/api/public/notifications/unsubscribe?token=t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  })

  // log_only and the RFC 2606 domains never reach Resend.
  const logOnly = await sendEmail({ ...PROVIDER_ENV, EMAIL_DELIVERY_MODE: 'log_only' }, input)
  assert.equal(logOnly.status, 'sent')
  assert.match((logOnly as { messageId: string }).messageId, /^log-only:email:/)
  assert.equal((await sendEmail({ ...PROVIDER_ENV }, { ...input, to: 'fixture@example.test' })).status, 'sent')
  assert.equal(resend.calls.length, 1)

  // A rejection Resend answered and a request it never answered both fail, with the reason.
  resend.failNext('POST /emails')
  const rejected = await sendEmail({ ...PROVIDER_ENV }, input)
  assert.equal(rejected.status, 'failed')
  assert.match((rejected as { error: string }).error, /^500 internal_server_error: injected failure/)
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network down') })
  const unanswered = await sendEmail({ ...PROVIDER_ENV }, input)
  assert.equal(unanswered.status, 'failed')
  assert.match((unanswered as { error: string }).error, /^no response /)
})

test('Resend delivery events move a guest-thread delivery forward only and publish when it moves', async (t) => {
  fakeResend(t)
  const { runtime, db, hubs } = await runtimeWithSchema()
  try {
    await db.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org-proof', 'Proof', 'proof', 'proof', 'USD', 'UTC')").run()
    const now = new Date().toISOString()
    const opening = requestInsertQueries({ id: 'thread-proof', kind: 'contact', organization_id: 'org-proof', location_id: null, user_id: null, review_id: null, conversation_state: 'needs_attention', resolved_at: null, payload: { guest: { name: 'Guest', email: 'guest@provider-proof.com', phone: null }, subject: null, message: 'Hello', consent_at: null, ip_hash: null }, created_at: now, updated_at: now })
    await db.batch(opening.map(write => db.prepare(write.query).bind(...write.params)))
    await appendEntry(db, { id: 'entry-proof', threadId: 'thread-proof', kind: 'message', actorKind: 'member', channel: 'email', body: 'Proof reply' })
    await db.prepare("INSERT INTO guest_thread_deliveries (id, entry_id, channel, provider, purpose, status, provider_message_id) VALUES ('delivery-proof', 'entry-proof', 'email', 'resend', 'member_reply', 'sent', 'email-proof')").run()
    const env = { GUEST_INBOX_HUBS: hubs }
    const status = async () => (await getDeliveryById(db, 'delivery-proof'))!.status
    const published = async () => (await (await hubs.get(hubs.idFromName('org-proof')).fetch('https://guest-inbox.internal/observed')).json()) as { type: string; threadId: string }[]

    assert.equal(await applyResendEmailEvent(db, env, emailEvent('email.sent', 'email-proof')), 'unchanged')
    for (const type of ['email.delivery_delayed', 'email.opened', 'email.clicked']) {
      assert.equal(await applyResendEmailEvent(db, env, emailEvent(type, 'email-proof')), 'ignored')
    }
    assert.equal(await status(), 'sent')
    assert.deepEqual(await published(), [])

    assert.equal(await applyResendEmailEvent(db, env, emailEvent('email.delivered', 'email-proof')), 'advanced')
    assert.equal(await status(), 'delivered')
    assert.deepEqual((await published()).map(event => [event.type, event.threadId]), [['delivery.changed', 'thread-proof']])

    // Duplicates, a late `sent`, a complaint and a late failure all leave delivered.
    for (const event of [
      emailEvent('email.delivered', 'email-proof'),
      emailEvent('email.sent', 'email-proof'),
      emailEvent('email.complained', 'email-proof'),
      emailEvent('email.bounced', 'email-proof', { bounce: { type: 'Permanent', subType: 'General', message: 'late' } }),
    ]) assert.equal(await applyResendEmailEvent(db, env, event), 'unchanged')
    assert.equal(await status(), 'delivered')
    assert.equal((await published()).length, 1)

    // Unknown provider ids — every Broadcast recipient's events — change nothing.
    assert.equal(await applyResendEmailEvent(db, env, emailEvent('email.delivered', 'broadcast-recipient-email')), 'no_delivery')

    await db.prepare("UPDATE guest_thread_deliveries SET status = 'sent', error = NULL WHERE id = 'delivery-proof'").run()
    assert.equal(await applyResendEmailEvent(db, env, emailEvent('email.suppressed', 'email-proof', { suppressed: { type: 'OnAccountSuppressionList', message: 'suppressed' } })), 'advanced')
    const failed = (await getDeliveryById(db, 'delivery-proof'))!
    assert.deepEqual([failed.status, failed.error], ['failed', 'Resend suppressed (OnAccountSuppressionList): suppressed'])
    assert.equal(await applyResendEmailEvent(db, env, emailEvent('email.delivered', 'email-proof')), 'unchanged')
    assert.equal(await applyResendEmailEvent(db, env, emailEvent('email.failed', 'email-proof', { failed: { reason: 'again' } })), 'unchanged')
    assert.equal(await status(), 'failed')

    assert.equal(compareDeliveryStatus('sent', 'delivered'), true)
    assert.equal(compareDeliveryStatus('delivered', 'sent'), false)
  } finally {
    await runtime.dispose()
  }
})

async function seedUsers(db: D1Database) {
  for (const statement of [
    "INSERT INTO user (id, name, email, emailVerified) VALUES ('user-on', 'On', 'on@provider-proof.com', 1)",
    "INSERT INTO user (id, name, email, emailVerified) VALUES ('user-off', 'Off', 'off@provider-proof.com', 1)",
    "INSERT INTO user (id, name, email, emailVerified) VALUES ('user-unverified', 'Unverified', 'unverified@provider-proof.com', 0)",
    "INSERT INTO user (id, name, email, emailVerified, banned) VALUES ('user-banned', 'Banned', 'banned@provider-proof.com', 1, 1)",
    "INSERT INTO user (id, name, email, emailVerified, isAnonymous) VALUES ('user-anonymous', 'Anonymous', 'anonymous@provider-proof.com', 1, 1)",
    "INSERT INTO user (id, name, email, emailVerified) VALUES ('user-fixture', 'Fixture', 'fixture@example.test', 1)",
    "INSERT INTO user_notification_preferences (user_id, category, email_enabled, whatsapp_enabled) VALUES ('user-off', 'product_news', 0, 0)",
    "INSERT INTO user_notification_preferences (user_id, category, email_enabled, whatsapp_enabled) VALUES ('user-on', 'guest_messages', 0, 1)",
  ]) await db.prepare(statement).run()
}

test('Product News reconciliation projects eligible users onto the Segment and Topic, and repeats as a no-op', async (t) => {
  const resend = fakeResend(t)
  const { runtime, db } = await runtimeWithSchema()
  try {
    await seedUsers(db)
    // Already in Resend: a banned person still in the Segment, and a Segment
    // member with no local account at all (deleted, or changed address).
    resend.addContact('banned@provider-proof.com', { segments: [SEGMENT], topic: 'opt_in' })
    resend.addContact('gone@provider-proof.com', { segments: [SEGMENT], topic: 'opt_in' })

    const first = await reconcileProductNewsContacts(db, PROVIDER_ENV)
    assert.deepEqual(first.failures, [])
    assert.deepEqual(first.counts, { created: 2, resubscribed: 0, segment_added: 2, segment_removed: 2, topic_subscribed: 1, topic_unsubscribed: 1, local_opted_out: 0 })
    const on = resend.contacts.get('on@provider-proof.com')!
    const off = resend.contacts.get('off@provider-proof.com')!
    assert.deepEqual([on.segments.has(SEGMENT), on.topics.get(TOPIC), on.unsubscribed], [true, 'opt_in', false])
    // A category opt-out is the Topic, never the global unsubscribe.
    assert.deepEqual([off.segments.has(SEGMENT), off.topics.get(TOPIC), off.unsubscribed], [true, 'opt_out', false])
    // Ineligible people leave the Segment but keep their global Contact.
    assert.equal(resend.contacts.get('banned@provider-proof.com')!.segments.has(SEGMENT), false)
    assert.equal(resend.contacts.get('gone@provider-proof.com')!.segments.has(SEGMENT), false)
    for (const email of ['unverified@provider-proof.com', 'anonymous@provider-proof.com', 'fixture@example.test']) {
      assert.equal(resend.contacts.has(email), false, `${email} must not become a Contact`)
    }
    const members = [...resend.contacts.values()].filter(contact => contact.segments.has(SEGMENT)).map(contact => contact.email).sort()
    assert.deepEqual(members, ['off@provider-proof.com', 'on@provider-proof.com'])

    const writesBefore = resend.writes().length
    const second = await reconcileProductNewsContacts(db, PROVIDER_ENV)
    assert.deepEqual(second.counts, { created: 0, resubscribed: 0, segment_added: 0, segment_removed: 0, topic_subscribed: 0, topic_unsubscribed: 0, local_opted_out: 0 })
    assert.equal(resend.writes().length, writesBefore)

    // A failed Resend operation is reported, not skipped over.
    resend.failNext('PATCH /contacts/on@provider-proof.com/topics')
    await db.prepare("INSERT INTO user_notification_preferences (user_id, category, email_enabled, whatsapp_enabled) VALUES ('user-on', 'product_news', 0, 0)").run()
    const failing = await reconcileProductNewsContacts(db, PROVIDER_ENV)
    assert.equal(failing.failures.length, 1)
    assert.match(failing.failures[0]!.error, /contacts\.topics\.update failed \(500 internal_server_error\)/)

    // Nothing reaches the shared Resend account from an environment that does not mail.
    const callsBefore = resend.calls.length
    assert.deepEqual((await reconcileProductNewsContacts(db, { ...PROVIDER_ENV, EMAIL_DELIVERY_MODE: 'log_only' })).mode, 'log_only')
    assert.equal(resend.calls.length, callsBefore)
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE sql LIKE '%resend_contact%'").first<{ n: number }>())!.n, 0)
  } finally {
    await runtime.dispose()
  }
})

test('Product News opt-in, opt-out and provider unsubscribes follow the exact subscription rules', async (t) => {
  const resend = fakeResend(t)
  const { runtime, db } = await runtimeWithSchema()
  try {
    await seedUsers(db)
    await reconcileProductNewsContacts(db, PROVIDER_ENV)
    const on = () => resend.contacts.get('on@provider-proof.com')!

    // Explicit opt-out: Topic off, Segment and global subscription untouched.
    await setNotificationPreference(db, PROVIDER_ENV, 'user-on', 'product_news', { email: false, whatsapp: false })
    assert.deepEqual([on().topics.get(TOPIC), on().segments.has(SEGMENT), on().unsubscribed], ['opt_out', true, false])

    // Resend-side global unsubscribe: background reconciliation never lifts it.
    on().unsubscribed = true
    await setNotificationPreference(db, PROVIDER_ENV, 'user-on', 'product_news', { email: false, whatsapp: false })
    await reconcileProductNewsContacts(db, PROVIDER_ENV)
    assert.equal(on().unsubscribed, true)

    // Explicit opt-in is the one action that re-subscribes globally.
    await setNotificationPreference(db, PROVIDER_ENV, 'user-on', 'product_news', { email: true, whatsapp: false })
    assert.deepEqual([on().unsubscribed, on().topics.get(TOPIC), on().segments.has(SEGMENT)], [false, 'opt_in', true])

    // contact.updated with nothing Product News related changes nothing.
    const writes = resend.writes().length
    assert.equal(await reconcileProductNewsFromProvider(db, PROVIDER_ENV, 'on@provider-proof.com'), 'unchanged')
    assert.equal((await getNotificationPreferences(db, 'user-on')).product_news.email, true)

    // Topic unsubscribed through Resend's page: local off, not echoed back.
    on().topics.set(TOPIC, 'opt_out')
    assert.equal(await reconcileProductNewsFromProvider(db, PROVIDER_ENV, 'on@provider-proof.com'), 'opted_out_topic')
    let preferences = await getNotificationPreferences(db, 'user-on')
    assert.equal(preferences.product_news.email, false)
    // Other categories and WhatsApp are left exactly as they were.
    assert.deepEqual(preferences.guest_messages, { email: false, whatsapp: true })
    assert.equal(resend.writes().length, writes)

    // Global unsubscribe through Resend: local off, not echoed back.
    await setNotificationPreference(db, PROVIDER_ENV, 'user-on', 'product_news', { email: true, whatsapp: false })
    const writesAfterOptIn = resend.writes().length
    on().unsubscribed = true
    assert.equal(await reconcileProductNewsFromProvider(db, PROVIDER_ENV, 'ON@provider-proof.com'), 'opted_out_globally')
    preferences = await getNotificationPreferences(db, 'user-on')
    assert.equal(preferences.product_news.email, false)
    assert.equal(resend.writes().length, writesAfterOptIn)
    assert.equal(await reconcileProductNewsFromProvider(db, PROVIDER_ENV, 'on@provider-proof.com'), 'already_off')
    assert.equal(await reconcileProductNewsFromProvider(db, PROVIDER_ENV, 'nobody@provider-proof.com'), 'no_user')

    // A reconciliation that finds a Resend Topic opt-out keeps it.
    await setNotificationPreference(db, PROVIDER_ENV, 'user-on', 'product_news', { email: true, whatsapp: false })
    on().topics.set(TOPIC, 'opt_out')
    const drift = await reconcileProductNewsContacts(db, PROVIDER_ENV)
    assert.equal(drift.counts.local_opted_out, 1)
    assert.equal(on().topics.get(TOPIC), 'opt_out')
    assert.equal((await getNotificationPreferences(db, 'user-on')).product_news.email, false)

    // The signed footer unsubscribe is the person's own opt-out.
    await syncProductNewsContact(db, PROVIDER_ENV, 'user-on', 'user_opt_in')
    await db.prepare("UPDATE user_notification_preferences SET email_enabled = 1 WHERE user_id = 'user-on' AND category = 'product_news'").run()
    await disableCategoryEmail(db, 'user-on', 'product_news', { origin: 'user', env: PROVIDER_ENV })
    assert.equal(on().topics.get(TOPIC), 'opt_out')
    assert.equal(on().unsubscribed, false)
  } finally {
    await runtime.dispose()
  }
})

test('an article is announced once as a native Broadcast whose id is stored before it is sent', async (t) => {
  const resend = fakeResend(t)
  const { runtime, db } = await runtimeWithSchema()
  try {
    await seedUsers(db)
    const published = new Date(Date.now() - 60_000).toISOString()
    for (const statement of [
      "INSERT INTO organization (id, name, slug, subdomain, theme_id, status, default_currency, timezone) VALUES ('org-platform', 'KrabiClaw', 'krabiclaw', 'krabiclaw', 'krabiclaw-theme-v1', 'active', 'USD', 'UTC')",
      "INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('locale-platform-en', 'org-platform', 'en', 1, 'published')",
      `INSERT INTO content_documents (id, organization_id, kind, row_role, locale, title, slug, summary, status, visibility, published_at, first_published_at, metadata_json)
       VALUES ('article-proof', 'org-platform', 'article', 'root', 'en', 'Proof article', 'proof-article', 'Why proof matters', 'published', 'listed', '${published}', '${published}', '{"collection":"blog"}')`,
      // The body as authors write it: a title line repeated from the document,
      // a heading, and prose with a link relative to the site.
      `INSERT INTO content_blocks (id, document_id, type, position, level, data_json) VALUES
       ('block-proof-intro', 'article-proof', 'markdown', 0, NULL, '{"markdown":"# Proof article\\n\\nShow the receipts before the pitch.","editor_mode":"rich"}'),
       ('block-proof-heading', 'article-proof', 'heading', 1, 2, '{"text":"Where to start"}'),
       ('block-proof-body', 'article-proof', 'markdown', 2, NULL, '{"markdown":"Compare the [plans](/pricing) first.","editor_mode":"rich"}')`,
    ]) await db.prepare(statement).run()

    // The send fails once: the tick throws, and the draft id is already stored.
    resend.failNext('POST /broadcasts/broadcast-')
    await assert.rejects(() => runArticleBroadcast(db, PROVIDER_ENV), /broadcasts\.send failed/)
    const row = await db.prepare("SELECT id, provider_broadcast_id FROM broadcasts WHERE content_document_id = 'article-proof'").first<{ id: string; provider_broadcast_id: string }>()
    assert.ok(row?.provider_broadcast_id)
    const creates = resend.calls.filter(call => call.method === 'POST' && call.path === '/broadcasts')
    assert.equal(creates.length, 1)
    const draft = creates[0]!.body as Record<string, string>
    assert.deepEqual([draft.segment_id, draft.topic_id, draft.subject, draft.from, draft.send], [SEGMENT, TOPIC, 'Proof article', 'Krabiclaw <hello@krabiclaw.com>', undefined])
    assert.ok(draft.html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'))
    // The article's own text is the email, read in the order it was written,
    // with the repeated title dropped and the site link made absolute.
    const body = ['Show the receipts before the pitch.', 'Where to start', 'href="https://proof.example/pricing"'].map(fragment => draft.html.indexOf(fragment))
    assert.ok(body.every((index, i) => index > 0 && (i === 0 || index > body[i - 1]!)), `article body missing or out of order: ${body.join(', ')}`)
    assert.equal(draft.html.split('Proof article').length - 1, 1)
    assert.ok(draft.text.includes('Show the receipts before the pitch.'))
    assert.ok(!draft.html.includes('/api/public/notifications/unsubscribe'))
    // The reconciliation ran before the draft was created.
    const firstCreate = resend.calls.findIndex(call => call.path === '/broadcasts')
    assert.ok(resend.calls.slice(0, firstCreate).some(call => call.method === 'POST' && call.path === '/contacts'))

    // The retry sends that same Broadcast; nothing is created or rendered again.
    const retried = await runArticleBroadcast(db, PROVIDER_ENV)
    assert.equal(retried.provider_broadcast_id, row.provider_broadcast_id)
    assert.equal(resend.broadcasts.get(row.provider_broadcast_id)!.status, 'sent')
    assert.equal(resend.calls.filter(call => call.path === '/broadcasts').length, 1)
    assert.deepEqual(resend.calls.filter(call => call.path.endsWith('/send')).map(call => call.path), [`/broadcasts/${row.provider_broadcast_id}/send`, `/broadcasts/${row.provider_broadcast_id}/send`])

    // Sent once: the next tick has nothing to announce, and no recipient was
    // mailed one at a time.
    assert.equal((await runArticleBroadcast(db, PROVIDER_ENV)).skipped, 'no article to announce')
    assert.equal(resend.calls.filter(call => call.path === '/emails').length, 0)
    assert.equal((await db.prepare("SELECT count(*) AS n FROM broadcasts").first<{ n: number }>())!.n, 1)
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'broadcast_deliveries'").first<{ n: number }>())!.n, 0)
  } finally {
    await runtime.dispose()
  }
})
