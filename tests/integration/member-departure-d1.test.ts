import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { hashPassword } from 'better-auth/crypto'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createProduct } from '../../server/utils/product-management.ts'
import { getLocation, updateLocation } from '../../server/utils/location-management.ts'
import { listStayHomes, updateStayHome, type StayAccess } from '../../server/domain/stays.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'

// Whoever leaves a business — removed by an owner, leaving on their own, or
// deleting their account — stops being responsible for its homes, locations
// and Teams, and open apps are told access changed. Each path runs through
// Better Auth's own HTTP handler, the way the dashboard and the app call it.

const BASE = 'https://departure-proof.example'
const PASSWORD = 'DepartureProof123!'
const ORG = 'org'
const PEOPLE = ['owner', 'removed', 'leaver', 'deleter'] as const

test('every way a member leaves clears their homes, locations and Teams and publishes access.changed', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'departure-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: `export class Hub {
      constructor(state, env) { this.env = env }
      async fetch(request) {
        const event = await request.json()
        if (event.type === 'access.changed') {
          const cache = this.env.ORGANIZATION_CACHE
          await cache.put('access-changed:count', String(Number(await cache.get('access-changed:count') ?? '0') + 1))
        }
        return new Response(null, { status: 204 })
      }
    } export default { fetch() { return new Response("ok") } }` } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'departure-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const cache = await runtime.getKVNamespace('ORGANIZATION_CACHE')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), MEDIA_BASE_URL: 'https://media.example.test', BETTER_AUTH_SECRET: 'departure-proof-secret-long-enough', BETTER_AUTH_URL: BASE,
      NUXT_PUBLIC_PLATFORM_DOMAIN: BASE, STRIPE_SECRET_KEY: 'sk_test_departure_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Departures', 'departures', 'departures', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    for (const person of PEOPLE) {
      await db.prepare('INSERT INTO user (id, name, email, "emailVerified", createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(person, person, `${person}@departure-proof.example`).run()
      await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)")
        .bind(`account-${person}`, person, person, await hashPassword(PASSWORD)).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${person}`, ORG, person, person === 'owner' ? 'owner' : 'member').run()
    }

    const auth = createAuth(env)
    const post = (path: string, token: string | null, body: unknown) => auth.handler(new Request(`${BASE}/api/auth${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...token ? { authorization: `Bearer ${token}` } : {} }, body: JSON.stringify(body),
    }))
    const tokens: Record<string, string> = {}
    for (const person of PEOPLE) {
      const signedIn = await post('/sign-in/email', null, { email: `${person}@departure-proof.example`, password: PASSWORD })
      assert.equal(signedIn.status, 200, await signedIn.clone().text())
      tokens[person] = signedIn.headers.get('set-auth-token')!
      assert.ok(tokens[person])
    }

    const changedRole = await post('/organization/update-member-role', tokens.owner!, { organizationId: ORG, memberId: 'm-removed', role: 'admin' })
    assert.equal(changedRole.status, 200, await changedRole.clone().text())
    assert.equal(await db.prepare("SELECT role FROM member WHERE id = 'm-removed'").first('role'), 'admin')
    const roleChanges = () => db.prepare("SELECT actor_user_id, payload_json FROM activity_entries WHERE organization_id = ? AND event_name = 'member.role_changed' ORDER BY occurred_at, id").bind(ORG).all<{ actor_user_id: string; payload_json: string }>()
    const firstRoleChange = (await roleChanges()).results
    assert.equal(firstRoleChange.length, 1)
    assert.equal(firstRoleChange[0]!.actor_user_id, 'owner')
    assert.deepEqual(JSON.parse(firstRoleChange[0]!.payload_json), {
      entityType: 'member', entityId: 'm-removed', actorType: 'member',
      beforeState: { role: 'member' }, afterState: { role: 'admin' },
      metadata: { userId: 'removed', previousRole: 'member', role: 'admin' },
    })
    const unchangedRole = await post('/organization/update-member-role', tokens.owner!, { organizationId: ORG, memberId: 'm-removed', role: 'admin' })
    assert.equal(unchangedRole.status, 200, await unchangedRole.clone().text())
    assert.deepEqual((await roleChanges()).results, firstRoleChange)
    const restoredRole = await post('/organization/update-member-role', tokens.owner!, { organizationId: ORG, memberId: 'm-removed', role: 'member' })
    assert.equal(restoredRole.status, 200, await restoredRole.clone().text())

    // Each departing member looks after one home at its own location, through
    // the same writes the dashboard makes, and belongs to one Team.
    const manager: StayAccess = { organizationId: ORG, actorId: 'owner', manage: true }
    const homes: Record<string, string> = {}
    for (const person of PEOPLE.slice(1)) {
      await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 'America/Denver', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`).bind(`site-${person}`, ORG, `site-${person}`, `Site ${person}`).run()
      const home = await createProduct(db, { env, organizationId: ORG, actor: { actorId: 'owner' }, product: {
        kind: 'stay', name: `Home ${person}`, variants: [{ name: `Home ${person}`, prices: [{ unit_amount: 15_000, currency: 'USD' }] }],
        stay: { location_id: `site-${person}`, check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 1, assigned_member_id: null, assigned_team_id: null },
      } })
      homes[person] = home.id
      await updateStayHome(env, db, manager, home.id, { assigned_member_id: `m-${person}`, assigned_team_id: null })
      const located = await updateLocation(db, ORG, `site-${person}`, { assigned_member_id: `m-${person}`, assigned_team_id: null }, 'owner', env)
      assert.equal(located.status, 200, JSON.stringify(located.data))
    }
    const activated = await post('/organization/set-active', tokens.owner!, { organizationId: ORG })
    assert.equal(activated.status, 200, await activated.clone().text())
    const createdTeam = await post('/organization/create-team', tokens.owner!, { organizationId: ORG, name: 'Housekeeping' })
    assert.equal(createdTeam.status, 200, await createdTeam.clone().text())
    const teamId = (await createdTeam.json() as { id: string }).id
    for (const person of PEOPLE) {
      const added = await post('/organization/add-team-member', tokens.owner!, { teamId, userId: person })
      assert.equal(added.status, 200, await added.clone().text())
    }

    const homeAssignee = async (person: string) => (await listStayHomes(db, manager)).find(home => home.product_id === homes[person])?.assigned_member_id
    const locationAssignee = async (person: string) => (await getLocation(db, ORG, `site-${person}`))?.assigned_member_id
    const teamSeats = async (person: string) => db.prepare('SELECT COUNT(*) AS n FROM teamMember WHERE teamId = ? AND userId = ?').bind(teamId, person).first('n')
    const removals = async (person: string) => db.prepare("SELECT COUNT(*) AS n FROM activity_entries WHERE organization_id = ? AND event_name = 'member.removed' AND json_extract(payload_json, '$.metadata.userId') = ?").bind(ORG, person).first('n')
    const accessChanges = async () => Number(await cache.get('access-changed:count') ?? '0')
    for (const person of PEOPLE.slice(1)) {
      assert.equal(await homeAssignee(person), `m-${person}`)
      assert.equal(await locationAssignee(person), `m-${person}`)
      assert.equal(await teamSeats(person), 1)
    }

    const departures: Array<[string, () => Promise<Response>]> = [
      ['removed', () => post('/organization/remove-member', tokens.owner!, { organizationId: ORG, memberIdOrEmail: 'm-removed' })],
      ['leaver', () => post('/organization/leave', tokens.leaver!, { organizationId: ORG })],
      ['deleter', () => post('/delete-user', tokens.deleter!, { password: PASSWORD })],
    ]
    for (const [person, depart] of departures) {
      const before = await accessChanges()
      const response = await depart()
      assert.equal(response.status, 200, `${person}: ${await response.clone().text()}`)
      assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM member WHERE organizationId = ? AND userId = ?').bind(ORG, person).first('n'), 0)
      assert.equal(await homeAssignee(person), null, `${person}'s home is unassigned`)
      assert.equal(await locationAssignee(person), null, `${person}'s location is unassigned`)
      assert.equal(await teamSeats(person), 0, `${person} has no Team seat`)
      assert.equal(await removals(person), 1, `${person}'s departure is recorded once`)
      const departure = await db.prepare("SELECT actor_kind, actor_user_id, payload_json FROM activity_entries WHERE organization_id = ? AND event_name = 'member.removed' AND json_extract(payload_json, '$.metadata.userId') = ?")
        .bind(ORG, person).first<{ actor_kind: string; actor_user_id: string | null; payload_json: string }>()
      assert.ok(departure)
      assert.equal(departure.actor_user_id, person === 'removed' ? 'owner' : person === 'leaver' ? 'leaver' : null)
      assert.equal(departure.actor_kind, person === 'deleter' ? 'system' : 'member')
      assert.deepEqual(JSON.parse(departure.payload_json).metadata, {
        userId: person, operation: person === 'removed' ? 'removed' : person === 'leaver' ? 'left' : 'account_deleted',
      })
      assert.ok(await accessChanges() > before, `${person}'s departure publishes access.changed`)
    }
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM user WHERE id = 'deleter'").first('n'), 0)

    // The owner who stayed keeps their Team seat; the Team itself remains.
    assert.equal(await teamSeats('owner'), 1)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM activity_entries WHERE organization_id = ? AND event_name = 'member.access_scope_revoked'").bind(ORG).first('n'), 6)
  } finally {
    await runtime.dispose()
  }
})
