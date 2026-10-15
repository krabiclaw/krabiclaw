import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { AirbnbConnection, AIRBNB_CALLBACK } from '../../server/integrations/channex/airbnb-connection.ts'

// The Airbnb connection's own rules, against a fake Channex: a single-use
// sign-in bound to the person who started it, the channel verified as theirs,
// and a provider write that may have applied held for review instead of being
// sent again.

const ORG = 'org'
const OWNER = 'owner-user'
const OTHER = 'other-admin'
const env = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'test-key' }

type Seen = { method: string; path: string; body: Record<string, unknown> | null }

class FakeChannex {
  seen: Seen[] = []
  failNext: { path: string; status: number } | null = null
  token: string | null = null
  channel = { id: 'chan-1', title: '', active: false, ratePlans: [] as Array<{ id: string; rate_plan_id: string }>, group: 'grp-1', properties: ['setup-1'] }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '')
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    this.seen.push({ method, path, body })
    assert.equal(new Headers(init.headers).get('user-api-key'), 'test-key')
    if (this.failNext?.path === path) {
      const { status } = this.failNext
      this.failNext = null
      return new Response('{"errors":{}}', { status })
    }
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    if (method === 'POST' && path === '/groups') return json({ data: { id: 'grp-1', type: 'group', attributes: { title: 'x' } } })
    if (method === 'POST' && path === '/properties') return json({ data: { id: 'setup-1', type: 'property', attributes: { title: 'x' } } })
    if (method === 'POST' && path === '/meta/airbnb/connection_link') {
      const link = (body!.connection_link as Record<string, string>)
      this.token = link.token!
      this.channel.title = link.title!
      return json({ data: { type: 'connection_link', attributes: { url: 'https://www.airbnb.com/oauth2/auth?client_id=x' } } })
    }
    if (method === 'GET' && path === `/channels/${this.channel.id}`) {
      return json({ data: { id: this.channel.id, type: 'channel', attributes: { channel: 'AirBNB', title: this.channel.title, is_active: this.channel.active, properties: this.channel.properties, rate_plans: this.channel.ratePlans }, relationships: { group: { data: { id: this.channel.group } } } } })
    }
    return new Response('not found', { status: 404 })
  }
}

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'airbnb-connection-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    for (const id of [OWNER, OTHER]) await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)").bind(id, id, `${id}@example.test`).run()
    return { runtime, db }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

function code(expected: string) {
  return (error: unknown) => (error as { data?: { code?: string } }).data?.code === expected
}

test('an Airbnb sign-in completes only for its own person and state, and an uncertain write is held for review', async () => {
  const { runtime, db } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const owner = new AirbnbConnection(db, env, ORG, OWNER)
    const other = new AirbnbConnection(db, env, ORG, OTHER)

    const started = await owner.start()
    assert.equal(started.authorization_url, 'https://www.airbnb.com/oauth2/auth?client_id=x')
    const link = channex.seen.find(request => request.path === '/meta/airbnb/connection_link')!.body!.connection_link as Record<string, unknown>
    assert.deepEqual([link.redirect_uri, link.group_id, link.properties], [AIRBNB_CALLBACK, 'grp-1', ['setup-1']])
    // A repeat start returns the same link and creates nothing new.
    const writes = channex.seen.filter(request => request.method === 'POST').length
    assert.equal((await owner.start()).authorization_url, started.authorization_url)
    assert.equal(channex.seen.filter(request => request.method === 'POST').length, writes)
    await assert.rejects(other.start(), code('SIGN_IN_OWNED_ELSEWHERE'))

    // Only the person who started it, with its own state, completes it.
    await assert.rejects(other.complete(channex.token!, 'chan-1'), code('SIGN_IN_INVALID'))
    await assert.rejects(owner.complete('forged-state', 'chan-1'), code('SIGN_IN_INVALID'))
    channex.channel.group = 'someone-elses-group'
    await assert.rejects(owner.complete(channex.token!, 'chan-1'), code('CHANNEL_NOT_OWNED'))
    channex.channel.group = 'grp-1'
    assert.deepEqual(await owner.complete(channex.token!, 'chan-1'), { connected: true })
    const stored = await db.prepare('SELECT status, channel_id, state_hash, authorization_url, operation_id FROM channex_connections WHERE organization_id = ?').bind(ORG).first()
    assert.deepEqual(stored, { status: 'connected', channel_id: 'chan-1', state_hash: null, authorization_url: null, operation_id: null })
    assert.deepEqual(await owner.status(), { status: 'connected', connected_at: (await db.prepare('SELECT connected_at FROM channex_connections').first<{ connected_at: string }>())!.connected_at, listing_count: 0 })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a refused provider write releases the lock; one that may have applied keeps it for review', async () => {
  const { runtime, db } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const owner = new AirbnbConnection(db, env, ORG, OWNER)
    channex.failNext = { path: '/groups', status: 422 }
    await assert.rejects(owner.start(), (error: unknown) => (error as { status?: number }).status === 422)
    assert.deepEqual(await db.prepare('SELECT status, operation_id, pending_step, group_id FROM channex_connections').first(), { status: 'not_connected', operation_id: null, pending_step: null, group_id: null })

    channex.failNext = { path: '/groups', status: 500 }
    await assert.rejects(owner.start(), (error: unknown) => (error as { uncertain?: boolean }).uncertain === true)
    assert.deepEqual(await db.prepare('SELECT status, pending_step FROM channex_connections').first(), { status: 'needs_review', pending_step: 'create_group' })
    const groupsBefore = channex.seen.filter(request => request.path === '/groups').length
    await assert.rejects(owner.start(), code('CONNECTION_BUSY'))
    assert.equal(channex.seen.filter(request => request.path === '/groups').length, groupsBefore)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
