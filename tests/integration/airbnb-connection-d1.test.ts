import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { ChannexConnection, AIRBNB_CALLBACK } from '../../server/integrations/channex/channel-connection.ts'
import type { AirbnbSyncMessage } from '../../server/events.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { captureEvents } from './support/events.ts'

// The Airbnb connection's own rules, against a fake Channex: a single-use
// sign-in bound to the person who started it, the channel verified as theirs,
// and organization deletion releasing everything it holds in Channex.

const ORG = 'org'
const OWNER = 'owner-user'
const OTHER = 'other-admin'
const env = { CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'test-key' }

type Seen = { method: string; path: string; body: Record<string, unknown> | null }

class FakeChannex {
  seen: Seen[] = []
  token: string | null = null
  channel = { id: 'chan-1', title: '', active: false, ratePlans: [] as Array<{ id: string; rate_plan_id: string }>, group: 'grp-1', properties: ['setup-1'] }
  // What Channex holds: the group's properties, and whether the channel and group still exist.
  groupProperties: string[] = []
  channelExists = true
  groupExists = true
  failDeactivate = false
  /** Every group and property Channex was asked to create, and to delete, in order. */
  created: string[] = []
  deleted: string[] = []
  groupTitles = new Map<string, string>()

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '')
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    this.seen.push({ method, path, body })
    assert.equal(new Headers(init.headers).get('user-api-key'), 'test-key')
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    if (method === 'GET' && path === '/groups') {
      const rows = [...this.groupTitles].filter(([id, title]) => title === url.searchParams.get('filter[title]') && !this.deleted.includes(id) && (id !== this.channel.group || this.groupExists))
      return json({ data: rows.map(([id, title]) => ({ id, type: 'group', attributes: { title } })), meta: { total: rows.length } })
    }
    if (method === 'POST' && path === '/groups') {
      const id = `grp-${this.created.filter(entry => entry.startsWith('grp-')).length + 1}`
      this.created.push(id)
      this.groupTitles.set(id, String((body!.group as Record<string, unknown>).title))
      return json({ data: { id, type: 'group', attributes: { title: 'x' } } })
    }
    if (method === 'POST' && path === '/properties') {
      const id = `setup-${this.created.filter(entry => entry.startsWith('setup-')).length + 1}`
      this.created.push(id)
      if ((body!.property as Record<string, unknown>).group_id === this.channel.group) this.groupProperties.push(id)
      return json({ data: { id, type: 'property', attributes: { title: 'x' } } })
    }
    // The setup property is the only one created here, so every property in the group carries its title.
    if (method === 'GET' && path === '/properties') {
      const rows = url.searchParams.get('filter[title]') === 'Blawby connection setup' ? this.groupProperties : []
      return json({ data: rows.map(id => ({ id, type: 'property', attributes: { title: 'Blawby connection setup' }, relationships: { groups: { data: [{ type: 'group', id: this.channel.group }] } } })), meta: { total: rows.length } })
    }
    const otherGroup = path.match(/^\/groups\/(grp-[2-9])$/)?.[1]
    if (otherGroup && method === 'DELETE') {
      this.deleted.push(otherGroup)
      return json({ meta: { message: 'Success' } })
    }
    if (method === 'POST' && path === '/meta/airbnb/connection_link') {
      const link = (body!.connection_link as Record<string, string>)
      this.token = link.token!
      this.channel.title = link.title!
      return json({ data: { type: 'connection_link', attributes: { url: 'https://www.airbnb.com/oauth2/auth?client_id=x' } } })
    }
    const removed = () => json({ meta: { message: 'Success' } })
    const property = path.match(/^\/properties\/([^/]+)$/)?.[1]
    if (property && method === 'GET') {
      return this.groupProperties.includes(property) ? json({ data: { id: property, type: 'property', attributes: { title: 'x' } } }) : new Response('not found', { status: 404 })
    }
    if (property && method === 'DELETE') {
      // Channex refuses a property with a channel unless force=true is given.
      if (this.channelExists && this.channel.properties.includes(property) && url.searchParams.get('force') !== 'true') return new Response('{"errors":{}}', { status: 422 })
      this.groupProperties = this.groupProperties.filter(id => id !== property)
      this.deleted.push(property)
      return removed()
    }
    if (path === `/groups/${this.channel.group}` && method === 'GET') {
      return this.groupExists
        ? json({ data: { id: this.channel.group, type: 'group', attributes: { title: 'x' }, relationships: { properties: { data: this.groupProperties.map(id => ({ id, type: 'property', attributes: { title: 'x' } })) } } } })
        : new Response('not found', { status: 404 })
    }
    if (path === `/groups/${this.channel.group}` && method === 'DELETE') {
      if (this.groupProperties.length) return new Response('{"errors":{}}', { status: 400 })
      this.groupExists = false
      return removed()
    }
    if (method === 'POST' && path === `/channels/${this.channel.id}/deactivate`) {
      if (this.failDeactivate) return new Response('{"errors":{"title":"Channel is busy"}}', { status: 500 })
      this.channel.active = false
      return removed()
    }
    if (method === 'DELETE' && path === `/channels/${this.channel.id}`) {
      if (this.channel.active) return new Response('{"errors":{}}', { status: 422 })
      this.channelExists = false
      return removed()
    }
    if (method === 'GET' && path === `/channels/${this.channel.id}` && this.channelExists) {
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
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
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

test('an Airbnb sign-in completes only for its own person and state', async () => {
  const { runtime, db } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const owner = new ChannexConnection(db, env, ORG, OWNER)
    const other = new ChannexConnection(db, env, ORG, OTHER)

    // The Worker ends after Channex created the group and before its id is saved: the next start finds that group.
    await db.prepare("CREATE TRIGGER lose_group_id BEFORE UPDATE OF group_id ON channex_connections BEGIN SELECT RAISE(ABORT, 'Worker ended'); END").run()
    await assert.rejects(owner.start(), (error: Error) => String(error.cause).includes('Worker ended'))
    await db.prepare('DROP TRIGGER lose_group_id').run()
    const started = await owner.start()
    assert.deepEqual([channex.created.filter(id => id.startsWith('grp-')), await db.prepare('SELECT group_id FROM channex_connections').first('group_id')], [['grp-1'], 'grp-1'])
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
    const stored = await db.prepare('SELECT status, channel_id, state_hash, authorization_url FROM channex_connections WHERE organization_id = ?').bind(ORG).first()
    assert.deepEqual(stored, { status: 'connected', channel_id: 'chan-1', state_hash: null, authorization_url: null })
    assert.deepEqual(await owner.status(), { status: 'connected', connected_at: (await db.prepare('SELECT connected_at FROM channex_connections').first<{ connected_at: string }>())!.connected_at, listing_count: 0, channel_active: false, disconnect_error: null })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('two Connect requests at once leave one group and one setup property in Channex and one sign-in', async () => {
  const { runtime, db } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const [first, second] = await Promise.all([new ChannexConnection(db, env, ORG, OWNER).start(), new ChannexConnection(db, env, ORG, OWNER).start()])
    assert.equal(first.authorization_url, second.authorization_url)
    const row = await db.prepare('SELECT status, group_id, setup_property_id FROM channex_connections').first<{ status: string; group_id: string; setup_property_id: string }>()
    // Each request created its own; the one saved second was deleted again.
    const kept = channex.created.filter(id => !channex.deleted.includes(id))
    assert.deepEqual(kept, [row!.group_id, row!.setup_property_id])
    assert.equal(row!.status, 'authorizing')
    assert.deepEqual(channex.groupProperties, [row!.setup_property_id])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a disconnect that fails on the queue shows its reason with the connection, and asking again finishes it', async () => {
  const { runtime, db } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const syncs = captureEvents<AirbnbSyncMessage>()
    const queued = { ...env, DB: db, AIRBNB_SYNC: syncs.binding } as unknown as CloudflareEnv
    const owner = new ChannexConnection(db, queued, ORG, OWNER)
    await owner.start()
    assert.deepEqual(await owner.complete(channex.token!, 'chan-1'), { connected: true })
    channex.channel.active = true
    // A disconnect the queue did not take is visible to both the caller and another client reading status.
    const unqueued = new ChannexConnection(db, { ...queued, AIRBNB_SYNC: { send: async () => { throw new Error('Queue unavailable') } } } as unknown as CloudflareEnv, ORG, OWNER)
    await assert.rejects(unqueued.disconnect(), /Queue unavailable/)
    const rejected = await owner.status()
    assert.deepEqual([rejected.status, rejected.disconnect_error], ['connected', 'Queue unavailable'])
    channex.failDeactivate = true
    const requests = await Promise.all([owner.disconnect(true), owner.disconnect(true)])
    assert.deepEqual(requests, [{ disconnected: false }, { disconnected: false }])
    assert.deepEqual(await owner.disconnect(), { disconnected: false }, 'a repeated POST observes the pending disconnect')
    assert.equal(syncs.pending.length, 1, 'only one request starts the disconnect')
    assert.equal((await owner.status()).status, 'disconnecting')
    await syncs.drain(queued)
    const failed = await owner.status()
    assert.deepEqual([failed.status, failed.disconnect_error], ['connected', 'Channex answered 500 to POST /channels/chan-1/deactivate: {"errors":{"title":"Channel is busy"}}'])
    await assert.rejects(owner.disconnect(), { status: 409, message: failed.disconnect_error! })
    assert.equal(syncs.pending.length, 0, 'a repeated POST does not restart a failed disconnect')
    channex.failDeactivate = false
    assert.deepEqual(await owner.disconnect(true), { disconnected: false })
    assert.equal((await owner.status()).disconnect_error, null)
    await syncs.drain(queued)
    assert.deepEqual(await owner.disconnect(), { disconnected: true })
    assert.deepEqual(await owner.status(), { status: 'not_connected', connected_at: null, listing_count: 0, channel_active: false, disconnect_error: null })
    assert.equal(channex.channelExists, false)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('deleting the organization releases its Airbnb channel, every property in its group and the group', async () => {
  const { runtime, db } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const owner = new ChannexConnection(db, env, ORG, OWNER)
    await owner.start()
    assert.deepEqual(await owner.complete(channex.token!, 'chan-1'), { connected: true })
    channex.channel.active = true
    // A property Channex holds in the organization's group that no mapping names.
    channex.groupProperties.push('prop-2')

    // While Airbnb is connected the deletion is refused, before anything is sent: Disconnect runs on the serial queue.
    const connectedWrites = channex.seen.filter(request => request.method !== 'GET').length
    await assert.rejects(owner.deleteForOrganization(), (error: { statusCode?: number; body?: { code?: string } }) => error.statusCode === 409 && error.body?.code === 'AIRBNB_CONNECTED')
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, connectedWrites)
    const syncs = captureEvents<AirbnbSyncMessage>()
    const queued = { ...env, DB: db, AIRBNB_SYNC: syncs.binding } as unknown as CloudflareEnv
    assert.deepEqual(await new ChannexConnection(db, queued, ORG, OWNER).disconnect(), { disconnected: false })
    await assert.rejects(owner.deleteForOrganization(), (error: { body?: { code?: string } }) => error.body?.code === 'AIRBNB_CONNECTED')
    await syncs.drain(queued)

    await owner.deleteForOrganization()
    assert.deepEqual([channex.channelExists, channex.groupExists, channex.groupProperties], [false, false, []])
    const writes = channex.seen.filter(request => request.method !== 'GET').map(request => `${request.method} ${request.path}`)
    assert.deepEqual(writes.slice(writes.indexOf('POST /channels/chan-1/deactivate')), [
      'POST /channels/chan-1/deactivate', 'DELETE /properties/setup-1', 'DELETE /channels/chan-1', 'DELETE /properties/prop-2', 'DELETE /groups/grp-1',
    ])
    assert.deepEqual(await db.prepare('SELECT status, channel_id, group_id, setup_property_id FROM channex_connections').first(),
      { status: 'not_connected', channel_id: null, group_id: null, setup_property_id: null })
    // Repeating it finds nothing left to release.
    const before = channex.seen.length
    await owner.deleteForOrganization()
    assert.equal(channex.seen.filter((request, index) => index >= before && request.method !== 'GET').length, 0)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

