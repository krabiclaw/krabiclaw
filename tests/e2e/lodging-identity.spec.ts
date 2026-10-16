import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { expect, test } from '@playwright/test'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { devLoginHeaders } from './test-env'

// The native app authenticates with a Better Auth bearer session and nothing
// else: no cookies, no Origin, no fetch-metadata headers.
// These use node:http, which sends only the headers given — fetch adds
// Sec-Fetch-Mode, which a native URLSession never sends and which makes Better
// Auth demand an Origin — and keeps no cookie jar, so a cookie can never stand
// in for the bearer.
// docs/shared-auth-contract.md §3–§4.

const fixture = findE2eAuthFixture('user-e2e-lodging-native')
const invitee = findE2eAuthFixture('user-e2e-lodging-invitee')

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

  test('a bearer session keeps its only organization, joins by invite link, and stops at sign-out', async ({ baseURL }) => {
    const { api, signInBearer } = session(baseURL)
    const bearer = await signInBearer(fixture.email)

    const slug = `e2e-lodging-${crypto.randomUUID().slice(0, 8)}`
    const created = await api.post('/api/auth/organization/create', {
      headers: bearer,
      data: { name: `Lodging Native ${slug}`, slug, default_currency: 'THB', timezone: 'Asia/Bangkok' },
    })
    expect(created.status, await created.text()).toBe(200)
    const organization = await created.json() as { id: string; name: string }
    const members = async () => {
      const listed = await api.get(`/api/auth/organization/list-members?organizationId=${encodeURIComponent(organization.id)}`, { headers: bearer })
      expect(listed.status, await listed.text()).toBe(200)
      return (await listed.json() as { members: Array<{ id: string; userId: string; role: string }> }).members
    }

    try {
      expect(await members()).toEqual([expect.objectContaining({ userId: fixture.id, role: 'owner' })])

      // A single-use link adds whoever accepts it, with the link's role.
      const link = await api.post(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer, data: { role: 'admin' } })
      expect(link.status, await link.text()).toBe(201)
      const { id: inviteLinkId, token: inviteToken, expiresAt } = await link.json() as { id: string; token: string; expiresAt: string }
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
      const pending = await api.get(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer })
      expect(pending.status, await pending.text()).toBe(200)
      expect((await pending.json() as { inviteLinks: Array<{ id: string; role: string }> }).inviteLinks).toEqual([expect.objectContaining({ id: inviteLinkId, role: 'admin' })])
      // Anyone holding the link reads what it offers, and the public page shows it.
      const offered = await api.get(`/api/invite-links/${encodeURIComponent(inviteToken)}`)
      expect(offered.status, await offered.text()).toBe(200)
      expect(await offered.json()).toEqual({ organization: { name: organization.name }, role: 'admin', expiresAt })
      const page = await api.get(`/invite/${encodeURIComponent(inviteToken)}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain(`Join ${organization.name}`)
      expect((await api.post(`/api/invite-links/${encodeURIComponent(inviteToken)}/accept`)).status).toBe(401)
      const inviteeBearer = await signInBearer(invitee.email)
      const accepted = await api.post(`/api/invite-links/${encodeURIComponent(inviteToken)}/accept`, { headers: inviteeBearer })
      expect(accepted.status, await accepted.text()).toBe(200)
      const joined = await accepted.json() as { organization: { id: string; name: string }; role: string; memberId: string }
      expect(joined).toMatchObject({ organization: { id: organization.id, name: organization.name }, role: 'admin' })
      expect(await members()).toEqual(expect.arrayContaining([expect.objectContaining({ id: joined.memberId, userId: invitee.id, role: 'admin' })]))
      const reused = await api.post(`/api/invite-links/${encodeURIComponent(inviteToken)}/accept`, { headers: inviteeBearer })
      expect(reused.status).toBe(410)
      expect(await reused.json()).toMatchObject({ data: { code: 'INVITE_LINK_USED', field: 'token' } })
      const usedRead = await api.get(`/api/invite-links/${encodeURIComponent(inviteToken)}`)
      expect(usedRead.status).toBe(410)
      expect(await usedRead.json()).toMatchObject({ data: { code: 'INVITE_LINK_USED', field: 'token' } })
      // Used links are no longer pending, and a withdrawn link cannot be read or accepted.
      expect((await (await api.get(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer })).json() as { inviteLinks: unknown[] }).inviteLinks).toEqual([])
      const withdrawn = await api.post(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links`, { headers: bearer, data: { role: 'member' } })
      expect(withdrawn.status, await withdrawn.text()).toBe(201)
      const withdrawnLink = await withdrawn.json() as { id: string; token: string }
      expect((await api.delete(`/api/organizations/${encodeURIComponent(organization.id)}/invite-links/${withdrawnLink.id}`, { headers: bearer })).status).toBe(204)
      const gone = await api.get(`/api/invite-links/${encodeURIComponent(withdrawnLink.token)}`)
      expect(gone.status).toBe(404)
      expect(await gone.json()).toMatchObject({ data: { code: 'INVITE_LINK_NOT_FOUND', field: 'token' } })
      expect((await api.post(`/api/invite-links/${encodeURIComponent(withdrawnLink.token)}/accept`, { headers: inviteeBearer })).status).toBe(404)
      expect((await api.post(`/api/organizations/org-demo/invite-links`, { headers: inviteeBearer, data: { role: 'member' } })).status).toBe(404)
      const inviteeLeft = await api.post('/api/auth/organization/leave', { headers: inviteeBearer, data: { organizationId: organization.id } })
      expect(inviteeLeft.status, await inviteeLeft.text()).toBe(200)
      expect(await members()).toEqual([expect.objectContaining({ userId: fixture.id, role: 'owner' })])

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
    const remaining = await api.get('/api/auth/organization/list', { headers: bearer })
    expect(remaining.status, await remaining.text()).toBe(200)
    expect((await remaining.json() as Array<{ id: string }>).map(row => row.id)).not.toContain(organization.id)

    // A bearer caller reads no cookie cache, so sign-out is immediate.
    const signOut = await api.post('/api/auth/sign-out', { headers: bearer, data: {} })
    expect(signOut.status, await signOut.text()).toBe(200)
    const signedOut = await api.get('/api/auth/get-session', { headers: bearer })
    expect(signedOut.status).toBe(200)
    expect(await signedOut.json()).toBeNull()
  })

  test('a lodging organization publishes a Saya site and is deleted by its owner', async ({ baseURL }) => {
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
    expect(await home.text()).toContain(name)
    // The seeded location is described as a lodging business and offers no
    // availability call to action.
    const location = await api.get('/locations/main', { headers: { 'x-preview-tenant': slug } })
    expect(location.status).toBe(200)
    const locationHtml = await location.text()
    expect(locationHtml).toContain('"LodgingBusiness"')
    // The rendered page has no such control; the platform message catalog the shell
    // payload carries also holds the words, as data, so only element text is checked.
    expect(locationHtml).not.toMatch(/>\s*Check availability\s*</)
    // Its location takes no table reservations, so the site has no reservations page.
    expect((await api.get('/reservations', { headers: { 'x-preview-tenant': slug } })).status).toBe(404)

    // Everything it holds lives in KrabiClaw, so its owner deletes it outright.
    const deleted = await api.post('/api/auth/organization/delete', { headers: bearer, data: { organizationId: organization.id } })
    expect(deleted.status, await deleted.text()).toBe(200)
    const remaining = await api.get('/api/auth/organization/list', { headers: bearer })
    expect(remaining.status, await remaining.text()).toBe(200)
    expect((await remaining.json() as Array<{ id: string }>).map(row => row.id)).not.toContain(organization.id)
  })
})
