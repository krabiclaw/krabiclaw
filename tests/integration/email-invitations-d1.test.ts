import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { hashPassword } from 'better-auth/crypto'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { describeEmailInvitation } from '../../server/utils/email-invitations.ts'

// Someone invited by email signs in with a code sent to that address, so the
// account that answers is the one the invitation names, and an address Apple
// relays for them cannot. Until they answer, they cannot start a business of
// their own. Each step runs through Better Auth's own HTTP handler.

const BASE = 'https://invitation-proof.example'
const PASSWORD = 'InvitationProof123!'
const ORG = 'org'
const INVITEE = 'cleaner@invitation-proof.example'

test('an invitee signs in with an emailed code, cannot create a business until they answer, and joins', { timeout: 120_000 }, async () => {
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
    for (const [id, email] of [['owner', 'owner@invitation-proof.example'], ['relay', 'np9gfypzgf@privaterelay.appleid.com']]) {
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

    // The owner invites the cleaner's address.
    const invited = await post('/organization/invite-member', await signIn('owner@invitation-proof.example'), { organizationId: ORG, email: INVITEE, role: 'member' })
    assert.equal(invited.status, 200)
    const invitationId = String(invited.body.id)
    const invitation = await describeEmailInvitation(db, invitationId)
    assert.deepEqual({ ...invitation, expiresAt: undefined }, { email: INVITEE, organization: { name: 'Strut Stays' }, role: 'member', expiresAt: undefined })
    assert.ok(Date.parse(invitation.expiresAt) > Date.now())

    // The relay address is not the invited one, so Better Auth refuses it.
    const relay = await post('/organization/accept-invitation', await signIn('np9gfypzgf@privaterelay.appleid.com'), { invitationId })
    assert.deepEqual([relay.status, relay.body.code], [403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'])

    // A code goes to the invited address; it signs in a new account for it.
    assert.equal((await post('/email-otp/send-verification-otp', null, { email: INVITEE, type: 'sign-in' })).status, 200)
    const stored = await db.prepare('SELECT value FROM verification WHERE identifier = ?').bind(`sign-in-otp-${INVITEE}`).first<string>('value')
    const code = stored?.split(':')[0]
    assert.match(code ?? '', /^\d{6}$/u)
    assert.equal((await post('/sign-in/email-otp', null, { email: INVITEE, otp: String((Number(code) + 1) % 1_000_000).padStart(6, '0') })).status, 400)
    const signedIn = await post('/sign-in/email-otp', null, { email: INVITEE, otp: code })
    assert.equal(signedIn.status, 200)
    const invitee = await db.prepare('SELECT id, "emailVerified" AS verified FROM user WHERE email = ?').bind(INVITEE).first<{ id: string; verified: number }>()
    assert.equal(invitee?.verified, 1)
    const token = signedIn.token!
    // The code is the only way in by email here: no reset or verification codes are offered.
    const reset = await auth.handler(new Request(`${BASE}/api/auth/email-otp/request-password-reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: INVITEE }) }))
    assert.equal(reset.status, 404)

    // While the invitation is open, the invitee cannot start a business of their own.
    const refused = await createBusiness(token, 'cleaner-co')
    assert.deepEqual([refused.status, refused.body.code], [403, 'PENDING_INVITATION'])
    assert.match(String(refused.body.message), /Strut Stays/u)
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM organization WHERE slug = 'cleaner-co'").first('n'), 0)

    // Accepting makes them a member of the inviting business, read back from the member table.
    const accepted = await post('/organization/accept-invitation', token, { invitationId })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await db.prepare('SELECT role FROM member WHERE "organizationId" = ? AND "userId" = ?').bind(ORG, invitee!.id).first(), { role: 'member' })
    await assert.rejects(describeEmailInvitation(db, invitationId), { status: 410, data: { code: 'INVITATION_ACCEPTED', field: 'invitationId' } })

    // Once answered, a business of their own is theirs to start.
    const created = await createBusiness(token, 'cleaner-co')
    assert.equal(created.status, 200)
    assert.deepEqual(await db.prepare('SELECT m.role FROM member m JOIN organization o ON o.id = m."organizationId" WHERE o.slug = \'cleaner-co\' AND m."userId" = ?').bind(invitee!.id).first(), { role: 'owner' })
  } finally {
    await runtime.dispose()
  }
})
