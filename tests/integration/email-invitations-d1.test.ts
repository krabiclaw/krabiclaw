import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { hashPassword } from 'better-auth/crypto'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'

const BASE = 'https://invitation-proof.example'
const PASSWORD = 'InvitationProof123!'
const ORG = 'org'
const INVITEE = 'cleaner@invitation-proof.example'

test('an email invitation is private, uses normal sign-in, and creates a membership only when accepted', { timeout: 120_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'invitation-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'invitation-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'invitation-proof-secret-long-enough', BETTER_AUTH_URL: BASE,
      NUXT_PUBLIC_PLATFORM_DOMAIN: BASE, STRIPE_SECRET_KEY: 'sk_test_invitation_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Strut Stays', 'strut', 'strut', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    // The owner, and the same invitee already signed in with Apple under a relay address.
    for (const [id, email] of [['owner', 'owner@invitation-proof.example'], ['relay', 'np9gfypzgf@privaterelay.appleid.com'], ['invitee', INVITEE]]) {
      await db.prepare('INSERT INTO user (id, name, email, "emailVerified", createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, email).run()
      await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)")
        .bind(`account-${id}`, id, id, await hashPassword(PASSWORD)).run()
    }
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, 'owner', 'owner', 0)").bind(ORG).run()

    const auth = createAuth(env)
    const post = async (path: string, token: string | null, body: unknown) => {
      const response = await auth.handler(new Request(`${BASE}/api/auth${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...token ? { authorization: `Bearer ${token}` } : {} }, body: JSON.stringify(body),
      }))
      return { status: response.status, token: response.headers.get('set-auth-token'), body: await response.json() as Record<string, unknown> }
    }
    const signIn = async (email: string) => {
      const response = await post('/sign-in/email', null, { email, password: PASSWORD })
      assert.equal(response.status, 200)
      return response.token!
    }
    const createBusiness = (token: string, slug: string) => post('/organization/create', token, { name: 'Cleaner Co', slug, default_currency: 'USD', timezone: 'America/Denver' })

    // Better Auth leaves expired invitations in the table. The owner can invite the same address again.
    const ownerToken = await signIn('owner@invitation-proof.example')
    const invite = (email: string) => post('/organization/invite-member', ownerToken, { organizationId: ORG, email, role: 'member' })
    const original = await invite(INVITEE)
    assert.equal(original.status, 200)
    await db.prepare('UPDATE invitation SET expiresAt = 0 WHERE id = ?').bind(original.body.id).run()
    const invited = await invite(INVITEE)
    assert.equal(invited.status, 200)
    const invitationId = String(invited.body.id)
    assert.notEqual(invitationId, original.body.id)
    const deliveryReceipts = () => db.prepare(`
      SELECT d.provider_message_id FROM guest_thread_deliveries d JOIN activity_entries a ON a.id = d.activity_entry_id
      WHERE a.dedupe_key = ? AND a.organization_id = ? AND d.provider = 'log_only' AND d.status = 'sent'
    `).bind(`organization-invitation:${invitationId}`, ORG).all<{ provider_message_id: string }>()
    const beforeResend = await deliveryReceipts()
    assert.equal(beforeResend.results.length, 1)
    const resent = await post('/organization/invite-member', ownerToken, { organizationId: ORG, email: INVITEE, role: 'member', resend: true })
    assert.deepEqual([resent.status, resent.body.id], [200, invitationId])
    const afterResend = await deliveryReceipts()
    assert.equal(afterResend.results.length, 2)
    assert.equal(new Set(afterResend.results.map(receipt => receipt.provider_message_id)).size, 2)
    const getInvitation = async (token?: string) => {
      const url = new URL('/api/auth/organization/get-invitation', BASE)
      url.searchParams.set('id', invitationId)
      const response = await auth.handler(new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    assert.equal((await getInvitation()).status, 401)
    const wrongAccount = await signIn('np9gfypzgf@privaterelay.appleid.com')
    const wrongSession = await auth.handler(new Request(new URL('/api/auth/get-session', BASE), { headers: { authorization: 'Bearer ' + wrongAccount } }))
    assert.equal((await wrongSession.json() as { user?: { id: string } } | null)?.user?.id, 'relay')
    const wrongAnswer = await post('/organization/accept-invitation', wrongAccount, { invitationId })
    assert.deepEqual([wrongAnswer.status, wrongAnswer.body.code], [403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'])
    const wrongRead = await getInvitation(wrongAccount)
    assert.deepEqual([wrongRead.status, wrongRead.body.code], [403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'], JSON.stringify(wrongRead.body))
    const token = await signIn(INVITEE)
    const invitation = await getInvitation(token)
    assert.equal(invitation.status, 200)
    assert.equal(invitation.body.email, INVITEE)
    assert.equal(invitation.body.organizationName, 'Strut Stays')
    assert.equal(invitation.body.role, 'member')
    assert.equal(await db.prepare('SELECT role FROM member WHERE "organizationId" = ? AND "userId" = ?').bind(ORG, 'invitee').first(), null)

    // While the invitation is open, the invitee cannot start a business of their own.
    const refused = await createBusiness(token, 'cleaner-co')
    assert.deepEqual([refused.status, refused.body.code], [403, 'PENDING_INVITATION'])
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM organization WHERE slug = 'cleaner-co'").first('n'), 0)

    // Accepting makes them a member of the inviting business, read back from the member table.
    const accepted = await post('/organization/accept-invitation', token, { invitationId })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await db.prepare('SELECT role FROM member WHERE "organizationId" = ? AND "userId" = ?').bind(ORG, 'invitee').first(), { role: 'member' })
    assert.equal((await getInvitation(token)).status, 400)
    const replay = await post('/organization/accept-invitation', token, { invitationId })
    assert.deepEqual([replay.status, replay.body.code], [400, 'INVITATION_NOT_FOUND'])

    // Once answered, a business of their own is theirs to start.
    const created = await createBusiness(token, 'cleaner-co')
    assert.equal(created.status, 200)
    assert.deepEqual(await db.prepare('SELECT m.role FROM member m JOIN organization o ON o.id = m."organizationId" WHERE o.slug = \'cleaner-co\' AND m."userId" = ?').bind('invitee').first(), { role: 'owner' })
  } finally {
    await runtime.dispose()
  }
})
