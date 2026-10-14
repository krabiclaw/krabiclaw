import { expect, request as playwrightRequest, test } from '@playwright/test'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { devLoginHeaders } from './test-env'

// The native app and the lodging Worker authenticate with a Better Auth bearer
// session and nothing else: no cookies, no Origin. These run in a request
// context with no cookie jar so a cookie can never stand in for the bearer.
// docs/shared-auth-contract.md §3–§4.

const fixture = findE2eAuthFixture('user-e2e-lodging-native')
const lodgingSecret = process.env.LODGING_SERVICE_SECRET ?? ''

test.describe('lodging identity boundary', () => {
  test('a bearer session resolves its principal, keeps its only organization, and stops at sign-out', async ({ baseURL }) => {
    const password = process.env.CANARY_LOGIN_PASSWORD
    if (!password) throw new Error('CANARY_LOGIN_PASSWORD is not configured.')
    const api = await playwrightRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    try {
      const signIn = await api.post('/api/auth/sign-in/email', {
        headers: devLoginHeaders(),
        data: { email: fixture.email, password, rememberMe: false },
      })
      expect(signIn.status(), await signIn.text()).toBe(200)
      const token = signIn.headers()['set-auth-token']
      expect(token, 'Better Auth issues the bearer in set-auth-token').toBeTruthy()
      await api.storageState().then(state => expect(state.cookies).toEqual([]))
      const bearer = { authorization: `Bearer ${token}` }

      const slug = `lodging-native-${crypto.randomUUID().slice(0, 8)}`
      const created = await api.post('/api/auth/organization/create', {
        headers: bearer,
        data: { name: `Lodging Native ${slug}`, slug, default_currency: 'THB', timezone: 'Asia/Bangkok' },
      })
      expect(created.status(), await created.text()).toBe(200)
      const organization = await created.json() as { id: string; name: string }

      try {
        const principal = await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`, { headers: bearer })
        expect(principal.status(), await principal.text()).toBe(200)
        const body = await principal.json() as {
          user: { id: string; email: string }
          session: { id: string; expiresAt: string; impersonatedBy: string | null }
          organization: { id: string; slug: string; name: string; default_currency: string; timezone: string }
          member: { id: string; role: string }
        }
        expect(body.user).toMatchObject({ id: fixture.id, email: fixture.email })
        expect(body.organization).toEqual({ id: organization.id, slug, name: organization.name, default_currency: 'THB', timezone: 'Asia/Bangkok' })
        expect(body.member.role).toBe('owner')
        expect(body.session.impersonatedBy).toBeNull()
        expect(Date.parse(body.session.expiresAt)).toBeGreaterThan(Date.now())

        // The member id and role, read back through Better Auth's own route.
        const members = await api.get(`/api/auth/organization/list-members?organizationId=${encodeURIComponent(organization.id)}`, { headers: bearer })
        expect(members.status(), await members.text()).toBe(200)
        expect((await members.json() as { members: Array<{ id: string; userId: string; role: string }> }).members)
          .toEqual([expect.objectContaining({ id: body.member.id, userId: fixture.id, role: 'owner' })])

        expect((await api.get('/api/lodging/principal', { headers: bearer })).status()).toBe(400)
        expect((await api.get(`/api/lodging/principal?organizationId=org-demo`, { headers: bearer })).status()).toBe(403)
        expect((await api.get(`/api/lodging/principal?organizationId=org-missing-${crypto.randomUUID()}`, { headers: bearer })).status()).toBe(404)
        expect((await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`)).status()).toBe(401)

        if (!lodgingSecret) throw new Error('LODGING_SERVICE_SECRET is not configured for the local Worker.')
        const service = { 'x-krabiclaw-lodging-secret': lodgingSecret }
        const facts = await api.post('/api/internal/lodging/members', { headers: service, data: { organizationId: organization.id } })
        expect(facts.status(), await facts.text()).toBe(200)
        expect(await facts.json()).toEqual([{ userId: fixture.id, memberId: body.member.id, role: 'owner', name: fixture.name, email: fixture.email, image: null, sessionIds: expect.arrayContaining([body.session.id]) }])
        expect((await api.post('/api/internal/lodging/members', { headers: { ...bearer }, data: { organizationId: organization.id } })).status()).toBe(401)

        // Deleting the only owner would orphan the organization.
        const refused = await api.post('/api/auth/delete-user', { headers: bearer, data: {} })
        expect(refused.status(), await refused.text()).toBe(400)
        expect(await refused.json()).toMatchObject({ code: 'SOLE_ORGANIZATION_OWNER', message: expect.stringContaining(organization.name) })
        const stillThere = await api.get('/api/auth/get-session', { headers: bearer })
        expect(stillThere.status()).toBe(200)
        expect((await stillThere.json() as { user: { id: string } }).user.id).toBe(fixture.id)
      } finally {
        const deleted = await api.post('/api/auth/organization/delete', { headers: bearer, data: { organizationId: organization.id } })
        expect(deleted.status(), await deleted.text()).toBe(200)
      }
      expect((await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`, { headers: bearer })).status()).toBe(404)

      // A bearer caller reads no cookie cache, so sign-out is immediate.
      const signOut = await api.post('/api/auth/sign-out', { headers: bearer, data: {} })
      expect(signOut.status(), await signOut.text()).toBe(200)
      expect((await api.get(`/api/lodging/principal?organizationId=org-demo`, { headers: bearer })).status()).toBe(401)
    } finally {
      await api.dispose()
    }
  })
})
