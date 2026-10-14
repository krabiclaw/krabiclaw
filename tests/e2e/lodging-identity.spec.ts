import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { expect, test } from '@playwright/test'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { devLoginHeaders } from './test-env'

// The native app and the lodging Worker authenticate with a Better Auth bearer
// session and nothing else: no cookies, no Origin, no fetch-metadata headers.
// These use node:http, which sends only the headers given — fetch adds
// Sec-Fetch-Mode, which a native URLSession never sends and which makes Better
// Auth demand an Origin — and keeps no cookie jar, so a cookie can never stand
// in for the bearer.
// docs/shared-auth-contract.md §3–§4.

const fixture = findE2eAuthFixture('user-e2e-lodging-native')
const invitee = findE2eAuthFixture('user-e2e-lodging-invitee')
const lodgingSecret = process.env.LODGING_SERVICE_SECRET ?? ''

test.describe('lodging identity boundary', () => {
  const session = (baseURL: string | undefined) => {
    const password = process.env.CANARY_LOGIN_PASSWORD
    if (!password) throw new Error('CANARY_LOGIN_PASSWORD is not configured.')
    const call = (method: 'GET' | 'POST' | 'DELETE', path: string, init: { headers?: Record<string, string>; data?: unknown } = {}) => new Promise<{
      status: number
      headers: { get: (name: string) => string | null }
      text: () => Promise<string>
      json: () => Promise<unknown>
    }>((resolve, reject) => {
      const url = new URL(path, baseURL)
      const body = init.data === undefined ? undefined : JSON.stringify(init.data)
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest
      const outgoing = send(url, {
        method,
        headers: { ...init.headers, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }) },
      }, (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: incoming.statusCode ?? 0,
            headers: { get: (name: string) => { const value = incoming.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value ?? null } },
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          })
        })
        incoming.on('error', reject)
      })
      outgoing.on('error', reject)
      outgoing.end(body)
    })
    const api = {
      get: (path: string, init?: { headers?: Record<string, string> }) => call('GET', path, init),
      post: (path: string, init?: { headers?: Record<string, string>; data?: unknown }) => call('POST', path, init),
      delete: (path: string, init?: { headers?: Record<string, string> }) => call('DELETE', path, init),
    }
    const signInBearer = async (email: string) => {
      const signIn = await api.post('/api/auth/sign-in/email', {
        headers: devLoginHeaders() ?? {},
        data: { email, password, rememberMe: false },
      })
      expect(signIn.status, await signIn.text()).toBe(200)
      const token = signIn.headers.get('set-auth-token')
      expect(token, 'Better Auth issues the bearer in set-auth-token').toBeTruthy()
      return { authorization: `Bearer ${token}` }
    }
    return { api, signInBearer }
  }

  test('a bearer session resolves its principal, keeps its only organization, and stops at sign-out', async ({ baseURL }) => {
    const { api, signInBearer } = session(baseURL)
    const bearer = await signInBearer(fixture.email)

    const slug = `e2e-lodging-${crypto.randomUUID().slice(0, 8)}`
    const created = await api.post('/api/auth/organization/create', {
      headers: bearer,
      data: { name: `Lodging Native ${slug}`, slug, default_currency: 'THB', timezone: 'Asia/Bangkok' },
    })
    expect(created.status, await created.text()).toBe(200)
    const organization = await created.json() as { id: string; name: string }

    try {
      const principal = await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`, { headers: bearer })
      expect(principal.status, await principal.text()).toBe(200)
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
      expect(members.status, await members.text()).toBe(200)
      expect((await members.json() as { members: Array<{ id: string; userId: string; role: string }> }).members)
        .toEqual([expect.objectContaining({ id: body.member.id, userId: fixture.id, role: 'owner' })])

      expect((await api.get('/api/lodging/principal', { headers: bearer })).status).toBe(400)
      expect((await api.get(`/api/lodging/principal?organizationId=org-demo`, { headers: bearer })).status).toBe(403)
      expect((await api.get(`/api/lodging/principal?organizationId=org-missing-${crypto.randomUUID()}`, { headers: bearer })).status).toBe(404)
      expect((await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`)).status).toBe(401)

      if (!lodgingSecret) throw new Error('LODGING_SERVICE_SECRET is not configured for the local Worker.')
      const service = { 'x-krabiclaw-lodging-secret': lodgingSecret }
      const facts = await api.post('/api/internal/lodging/members', { headers: service, data: { organizationId: organization.id } })
      expect(facts.status, await facts.text()).toBe(200)
      expect(await facts.json()).toEqual([{ userId: fixture.id, memberId: body.member.id, role: 'owner', name: fixture.name, email: fixture.email, image: null, sessionIds: expect.arrayContaining([body.session.id]) }])
      expect((await api.post('/api/internal/lodging/members', { headers: { ...bearer }, data: { organizationId: organization.id } })).status).toBe(401)

      // A single-use link adds whoever accepts it, with the link's role.
      const link = await api.post(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer, data: { role: 'admin' } })
      expect(link.status, await link.text()).toBe(201)
      const { id: inviteLinkId, token: inviteToken, expiresAt } = await link.json() as { id: string; token: string; expiresAt: string }
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
      const pending = await api.get(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer })
      expect(pending.status, await pending.text()).toBe(200)
      expect((await pending.json() as { inviteLinks: Array<{ id: string; role: string }> }).inviteLinks).toEqual([expect.objectContaining({ id: inviteLinkId, role: 'admin' })])
      const offered = await api.get(`/api/internal/lodging/invite-links/${encodeURIComponent(inviteToken)}`, { headers: service })
      expect(offered.status, await offered.text()).toBe(200)
      expect(await offered.json()).toEqual({ organizationName: organization.name, role: 'admin', status: 'pending', expiresAt })
      expect((await api.get(`/api/internal/lodging/invite-links/${encodeURIComponent(inviteToken)}`, { headers: bearer })).status).toBe(401)
      const inviteeBearer = await signInBearer(invitee.email)
      const accepted = await api.post(`/api/invite-links/${encodeURIComponent(inviteToken)}/accept`, { headers: inviteeBearer })
      expect(accepted.status, await accepted.text()).toBe(200)
      expect(await accepted.json()).toMatchObject({ organization: { id: organization.id, name: organization.name }, role: 'admin' })
      const joined = await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`, { headers: inviteeBearer })
      expect(joined.status, await joined.text()).toBe(200)
      expect((await joined.json() as { member: { role: string } }).member.role).toBe('admin')
      expect((await api.post(`/api/invite-links/${encodeURIComponent(inviteToken)}/accept`, { headers: inviteeBearer })).status).toBe(410)
      // Used links are no longer pending, and a withdrawn link cannot be accepted.
      expect((await (await api.get(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer })).json() as { inviteLinks: unknown[] }).inviteLinks).toEqual([])
      const withdrawn = await api.post(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer, data: { role: 'member' } })
      const withdrawnLink = await withdrawn.json() as { id: string; token: string }
      expect((await api.delete(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links/${withdrawnLink.id}`, { headers: bearer })).status).toBe(204)
      expect((await api.post(`/api/invite-links/${encodeURIComponent(withdrawnLink.token)}/accept`, { headers: inviteeBearer })).status).toBe(404)
      expect((await api.post(`/api/organizations/org-demo/invite-links`, { headers: inviteeBearer, data: { role: 'member' } })).status).toBe(404)
      const inviteeLeft = await api.post('/api/auth/organization/leave', { headers: inviteeBearer, data: { organizationId: organization.id } })
      expect(inviteeLeft.status, await inviteeLeft.text()).toBe(200)
      expect((await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`, { headers: inviteeBearer })).status).toBe(403)

      // Deleting the only owner would orphan the organization.
      const refused = await api.post('/api/auth/delete-user', { headers: bearer, data: {} })
      expect(refused.status, await refused.text()).toBe(400)
      expect(await refused.json()).toMatchObject({ code: 'SOLE_ORGANIZATION_OWNER', message: expect.stringContaining(organization.name) })
      const stillThere = await api.get('/api/auth/get-session', { headers: bearer })
      expect(stillThere.status).toBe(200)
      expect((await stillThere.json() as { user: { id: string } }).user.id).toBe(fixture.id)
    } finally {
      const deleted = await api.post('/api/auth/organization/delete', { headers: bearer, data: { organizationId: organization.id } })
      expect(deleted.status, await deleted.text()).toBe(200)
    }
    expect((await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`, { headers: bearer })).status).toBe(404)

    // A bearer caller reads no cookie cache, so sign-out is immediate.
    const signOut = await api.post('/api/auth/sign-out', { headers: bearer, data: {} })
    expect(signOut.status, await signOut.text()).toBe(200)
    expect((await api.get(`/api/lodging/principal?organizationId=org-demo`, { headers: bearer })).status).toBe(401)
  })

  test('a lodging organization publishes a Saya site and cannot be deleted without the lodging service', async ({ baseURL }) => {
    const { api, signInBearer } = session(baseURL)
    const bearer = await signInBearer(fixture.email)
    const slug = `e2e-lodging-${crypto.randomUUID().slice(0, 8)}`
    const name = `Lodging Site ${slug}`
    const created = await api.post('/api/auth/organization/create', {
      headers: bearer,
      data: { name, slug, default_currency: 'THB', timezone: 'Asia/Bangkok' },
    })
    expect(created.status, await created.text()).toBe(200)
    const organization = await created.json() as { id: string }

    const provisioned = await api.post('/api/organizations', {
      headers: bearer,
      data: { organizationId: organization.id, name, subdomain: slug, vertical: 'lodging', sourceLocale: 'en' },
    })
    expect(provisioned.status, await provisioned.text()).toBe(200)
    expect(await provisioned.json()).toMatchObject({ organizationId: organization.id, subdomain: slug })

    // The public site, read through the tenant host rather than the API that wrote it.
    const home = await api.get('/', { headers: { 'x-preview-tenant': slug } })
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain(name)
    expect(html).toContain('vacation rental sites that run themselves')
    expect(html).not.toContain('Check availability')

    // Its homes live in the lodging service, so deleting it must reach that
    // service first. With none configured here the deletion fails and the
    // organization stays; the e2e sweep removes it.
    const refused = await api.post('/api/auth/organization/delete', { headers: bearer, data: { organizationId: organization.id } })
    expect(refused.status, await refused.text()).toBe(500)
    expect(await refused.json()).toMatchObject({ code: 'LODGING_SERVICE_NOT_CONFIGURED' })
    expect((await api.get(`/api/lodging/principal?organizationId=${encodeURIComponent(organization.id)}`, { headers: bearer })).status).toBe(200)
  })
})
