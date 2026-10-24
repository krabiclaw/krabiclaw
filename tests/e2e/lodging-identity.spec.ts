import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import sharp from 'sharp'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { devLoginHeaders } from './test-env'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { dismissPreviewToolbar } from './helpers'
import type { TeamMember, TeamMessage, TeamThread } from '../../server/domain/team-messages'

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
      delete: (path: string, init?: { headers?: Record<string, string>; data?: unknown }) => call('DELETE', path, init),
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

  test('a bearer session keeps its organization and shares team conversations with MCP until membership ends', async ({ baseURL, page, request }) => {
    const { api, signInBearer } = session(baseURL)
    const bearer = await signInBearer(fixture.email)

    const slug = `e2e-lodging-${crypto.randomUUID().slice(0, 8)}`
    const created = await api.post('/api/auth/organization/create', {
      headers: bearer,
      data: { name: `Lodging Native ${slug}`, slug, default_currency: 'THB', timezone: 'Asia/Bangkok' },
    })
    expect(created.status, await created.text()).toBe(200)
    const organization = await created.json() as { id: string; name: string }
    const memberMcp = await playwrightRequest.newContext()
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
      const invitePage = await api.get(`/invite/${encodeURIComponent(inviteToken)}`)
      expect(invitePage.status).toBe(200)
      expect(await invitePage.text()).toContain(`Join ${organization.name}`)
      // In a browser with no session the page offers sign-in and the app.
      await page.goto(`/invite/${encodeURIComponent(inviteToken)}`)
      await expect(page.getByRole('heading', { name: `Join ${organization.name}`, level: 1 })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Sign in with email' })).toHaveAttribute('href', `/login?redirect=${encodeURIComponent(`/invite/${encodeURIComponent(inviteToken)}`)}`)
      await expect(page.getByRole('link', { name: 'Open this invite in the KrabiClaw app' })).toHaveAttribute('href', `krabiclaw://invite?token=${encodeURIComponent(inviteToken)}`)
      expect((await api.post(`/api/invite-links/${encodeURIComponent(inviteToken)}/accept`)).status).toBe(401)
      const inviteeBearer = await signInBearer(invitee.email)
      const accepted = await api.post(`/api/invite-links/${encodeURIComponent(inviteToken)}/accept`, { headers: inviteeBearer })
      expect(accepted.status, await accepted.text()).toBe(200)
      const joined = await accepted.json() as { organization: { id: string; name: string }; role: string; memberId: string }
      expect(joined).toMatchObject({ organization: { id: organization.id, name: organization.name }, role: 'admin' })
      expect(await members()).toEqual(expect.arrayContaining([expect.objectContaining({ id: joined.memberId, userId: invitee.id, role: 'admin' })]))

      // MCP and the native app address the same participants, messages and read
      // positions. This organization already exists for the invitation journey.
      await loginAs(request, baseURL!, fixture.id)
      await loginAs(memberMcp, baseURL!, invitee.id)
      const teamCall = async <T>(toolName: string, args: Record<string, unknown> = {}, client = request) => {
        const response = await mcpRequest(client, baseURL!, { method: 'tools/call', toolName, args: { organization_id: organization.id, ...args } })
        expect(response.status(), await response.text()).toBe(200)
        return mcpData<T>(await response.json())
      }
      const recipients = await teamCall<{ current_user_id: string; members: TeamMember[] }>('list_team_conversation_recipients')
      expect(recipients.current_user_id).toBe(fixture.id)
      const nativeMembers = await api.get(`/api/dashboard/team/members?org=${slug}`, { headers: bearer })
      expect(nativeMembers.status, await nativeMembers.text()).toBe(200)
      expect(recipients.members).toEqual((await nativeMembers.json() as { members: TeamMember[] }).members)
      expect(recipients.members.map(member => member.id).sort()).toEqual([fixture.id, invitee.id].sort())
      const started = await teamCall<{ id: string; created: boolean }>('start_team_conversation', { member_user_ids: [invitee.id] })
      expect(started.created).toBe(true)
      const threadId = started.id
      const teamPath = `/api/dashboard/team/threads/${threadId}`
      const reusedTeam = await api.post(`/api/dashboard/team/threads?org=${slug}`, { headers: inviteeBearer, data: { memberIds: [fixture.id] } })
      expect(reusedTeam.status, await reusedTeam.text()).toBe(200)
      expect(await reusedTeam.json()).toEqual({ id: threadId })
      const conversations = await teamCall<{ conversations: TeamThread[]; page_info: { has_more: boolean; next_cursor: string | null } }>('list_team_conversations')
      expect(conversations.conversations).toHaveLength(1)
      expect(conversations.conversations[0]).toMatchObject({ id: threadId, unread: false, unreadCount: 0, stayId: null, locationId: null })
      expect(conversations.conversations[0]!.participants.map(member => member.id).sort()).toEqual([fixture.id, invitee.id].sort())
      expect(conversations.page_info).toEqual({ has_more: false, next_cursor: null })
      const message = `The guest room is ready ${crypto.randomUUID()}`
      const idempotencyKey = crypto.randomUUID()
      const sent = await teamCall<{ message: TeamMessage; created: boolean }>('send_team_message', { thread_id: threadId, message, idempotency_key: idempotencyKey })
      expect(sent).toMatchObject({ created: true, message: { threadId, senderId: fixture.id, body: message, attachments: [] } })
      const replay = await teamCall<{ message: TeamMessage; created: boolean }>('send_team_message', { thread_id: threadId, message, idempotency_key: idempotencyKey })
      expect(replay).toEqual({ message: sent.message, created: false })
      const changedRetry = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'send_team_message', args: { organization_id: organization.id, thread_id: threadId, message: 'Different content', idempotency_key: idempotencyKey } })
      expect(changedRetry.status()).toBe(200)
      const changedRetryResult = (await changedRetry.json()).result
      expect(changedRetryResult.isError).toBe(true)
      expect(JSON.parse(changedRetryResult.content[0].text)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
      const nativeRead = await api.get(`${teamPath}/messages?org=${slug}`, { headers: inviteeBearer })
      expect(nativeRead.status, await nativeRead.text()).toBe(200)
      expect(await nativeRead.json()).toEqual({ messages: [sent.message], hasMore: false })
      const unread = await api.get(`/api/dashboard/team/threads?org=${slug}`, { headers: inviteeBearer })
      expect(unread.status, await unread.text()).toBe(200)
      expect((await unread.json() as { threads: TeamThread[] }).threads).toEqual([expect.objectContaining({ id: threadId, unread: true, unreadCount: 1 })])
      const marked = await teamCall<{ status: string; lastReadAt: string }>('mark_team_conversation_read', { thread_id: threadId }, memberMcp)
      expect(marked).toMatchObject({ status: 'read', lastReadAt: expect.any(String) })
      const readBack = await api.get(`/api/dashboard/team/threads?org=${slug}`, { headers: inviteeBearer })
      expect(readBack.status, await readBack.text()).toBe(200)
      expect((await readBack.json() as { threads: TeamThread[] }).threads).toEqual([expect.objectContaining({ id: threadId, unread: false, unreadCount: 0 })])
      const reply = await api.post(`${teamPath}/messages?org=${slug}`, { headers: inviteeBearer, data: { body: 'Thank you, I will check the room.', idempotencyKey: crypto.randomUUID() } })
      expect(reply.status, await reply.text()).toBe(201)
      const replyMessage = (await reply.json() as { message: TeamMessage }).message
      const latest = await teamCall<{ messages: TeamMessage[]; hasMore: boolean }>('get_team_conversation', { thread_id: threadId, limit: 1 })
      expect(latest).toEqual({ messages: [replyMessage], hasMore: true })
      const earlier = await teamCall<{ messages: TeamMessage[]; hasMore: boolean }>('get_team_conversation', { thread_id: threadId, limit: 1, before: replyMessage.createdAt, before_id: replyMessage.id })
      expect(earlier).toEqual({ messages: [sent.message], hasMore: false })
      const ownerUnread = await api.get(`/api/dashboard/team/threads?org=${slug}`, { headers: bearer })
      expect(ownerUnread.status, await ownerUnread.text()).toBe(200)
      expect((await ownerUnread.json() as { threads: TeamThread[] }).threads).toEqual([expect.objectContaining({ id: threadId, unread: true, unreadCount: 1 })])

      await loginAs(page.request, baseURL!, fixture.id)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/dashboard/${slug}/messages?view=team`)
      await dismissPreviewToolbar(page)
      await expect(page.locator('[data-team-thread-list-hydrated="true"]')).toBeVisible()
      await page.getByRole('link', { name: 'New team conversation', exact: true }).click()
      await page.getByRole('checkbox', { name: invitee.name, exact: true }).check()
      const reopened = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dashboard/team/threads')
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      const reopenedResponse = await reopened
      expect(reopenedResponse.status()).toBe(200)
      expect(await reopenedResponse.json()).toEqual({ id: threadId })
      await expect(page).toHaveURL(new RegExp(`/messages/team/${threadId}\\?view=team$`))
      const cmsBody = `Team CMS proof ${crypto.randomUUID()}`
      const composer = page.getByRole('textbox', { name: 'Message your team', exact: true })
      await composer.fill(cmsBody)
      // A lost request keeps the actual draft and retry identity in the CMS.
      let attemptedKey = ''
      await page.route('**/api/dashboard/team/threads/*/messages?*', async route => {
        if (route.request().method() !== 'POST') return route.continue()
        attemptedKey = (route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey
        await route.abort('failed')
      })
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(page.getByText('Conversation needs attention', { exact: true })).toBeVisible()
      await expect(composer).toHaveValue(cmsBody)
      await page.unroute('**/api/dashboard/team/threads/*/messages?*')
      // The local Worker has no APNs signing key. Register through the native
      // boundary so its actual failed push receipt must be visible in the CMS.
      const deviceToken = crypto.randomUUID().replaceAll('-', '')
      const registered = await api.post('/api/dashboard/devices', { headers: inviteeBearer, data: { deviceToken, environment: 'sandbox' } })
      expect(registered.status, await registered.text()).toBe(200)
      expect(await registered.json()).toEqual({ status: 'registered' })
      try {
        const cmsSent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${teamPath}/messages`)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        const cmsSentResponse = await cmsSent
        expect(cmsSentResponse.status()).toBe(201)
        expect((cmsSentResponse.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey).toBe(attemptedKey)
        await expect(composer).toHaveValue('')
        const cmsNativeRead = await api.get(`${teamPath}/messages?org=${slug}`, { headers: inviteeBearer })
        expect(cmsNativeRead.status, await cmsNativeRead.text()).toBe(200)
        const cmsMatches = (await cmsNativeRead.json() as { messages: TeamMessage[] }).messages.filter(message => message.body === cmsBody)
        expect(cmsMatches).toHaveLength(1)
        const saved = cmsMatches[0]!
        expect(saved).toMatchObject({ senderId: fixture.id, deliveries: [expect.objectContaining({ channel: 'push', status: 'failed', error: expect.stringMatching(/^APNS_CONFIG_REQUIRED: /) })] })
        const savedRow = page.locator(`[data-team-message="${saved.id}"]`)
        await expect(savedRow).toContainText(cmsBody)
        await expect(savedRow).toContainText('Message saved. A push notification failed.')
        await savedRow.getByRole('button', { name: 'Push error details', exact: true }).click()
        await expect(savedRow).toContainText(saved.deliveries[0]!.error!)
        const cmsMcpRead = await teamCall<{ messages: TeamMessage[]; hasMore: boolean }>('get_team_conversation', { thread_id: threadId, limit: 1 }, memberMcp)
        expect(cmsMcpRead).toEqual({ messages: [saved], hasMore: true })
      } finally {
        const unregistered = await api.delete('/api/dashboard/devices', { headers: inviteeBearer, data: { deviceToken } })
        expect(unregistered.status, await unregistered.text()).toBe(200)
        expect(await unregistered.json()).toEqual({ status: 'unregistered' })
      }

      await page.setViewportSize({ width: 390, height: 844 })
      await expect(composer).toBeVisible()
      await expect(page.locator('[data-team-push-failure]')).toContainText('Message saved. A push notification failed.')
      await page.locator('input[type="file"]').setInputFiles({ name: 'team-message-proof.avif', mimeType: 'image/avif', buffer: await sharp('public/platform/apple-touch-icon.png').avif().toBuffer() })
      const photoSent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${teamPath}/messages`)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      expect((await photoSent).status()).toBe(201)
      const photoRead = await api.get(`${teamPath}/messages?org=${slug}`, { headers: inviteeBearer })
      expect(photoRead.status, await photoRead.text()).toBe(200)
      const photo = (await photoRead.json() as { messages: TeamMessage[] }).messages[0]!
      expect(photo).toMatchObject({ body: '', senderId: fixture.id })
      expect(photo.deliveries).toEqual([])
      expect(photo.attachments).toHaveLength(1)
      const loadedPhoto = await api.get(photo.attachments[0]!.url)
      expect(loadedPhoto.status).toBe(200)
      expect(loadedPhoto.headers.get('content-type')).toBe('image/avif')
      await expect(page.locator(`[data-team-message="${photo.id}"] img`)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const photoMcpRead = await teamCall<{ messages: TeamMessage[]; hasMore: boolean }>('get_team_conversation', { thread_id: threadId, limit: 1 }, memberMcp)
      expect(photoMcpRead).toEqual({ messages: [photo], hasMore: true })
      const finalUnread = await api.get(`/api/dashboard/team/threads?org=${slug}`, { headers: inviteeBearer })
      expect(finalUnread.status, await finalUnread.text()).toBe(200)
      expect((await finalUnread.json() as { threads: TeamThread[] }).threads).toEqual([expect.objectContaining({ id: threadId, unread: true, unreadCount: 2 })])

      // Native arrivals cross the first page. Loading earlier history must keep
      // its oldest row when the next live arrival refreshes the source window.
      let lastHistoryMessage: TeamMessage | null = null
      for (let index = 0; index < 17; index++) {
        const historySent = await api.post(`${teamPath}/messages?org=${slug}`, { headers: inviteeBearer, data: { body: `Native team history ${index + 1} ${threadId}`, idempotencyKey: crypto.randomUUID() } })
        expect(historySent.status, await historySent.text()).toBe(201)
        lastHistoryMessage = (await historySent.json() as { message: TeamMessage }).message
      }
      await expect(page.locator(`[data-team-message="${lastHistoryMessage!.id}"]`)).toContainText(lastHistoryMessage!.body)
      const oldestRow = page.locator(`[data-team-message="${sent.message.id}"]`)
      await expect(oldestRow).toHaveCount(0)
      const earlierMessages = page.getByRole('button', { name: 'Earlier messages', exact: true })
      await expect(earlierMessages).toBeVisible()
      await earlierMessages.click()
      await expect(oldestRow).toContainText(message)
      await expect(earlierMessages).toHaveCount(0)
      const liveBody = `Native arrival after loading earlier messages ${threadId}`
      const liveSent = await api.post(`${teamPath}/messages?org=${slug}`, { headers: inviteeBearer, data: { body: liveBody, idempotencyKey: crypto.randomUUID() } })
      expect(liveSent.status, await liveSent.text()).toBe(201)
      const liveMessage = (await liveSent.json() as { message: TeamMessage }).message
      const liveRow = page.locator(`[data-team-message="${liveMessage.id}"]`)
      await expect(liveRow).toBeVisible()
      await expect(liveRow).toContainText(liveBody)
      await expect(oldestRow).toBeVisible()
      await expect(oldestRow).toContainText(message)
      await expect(page.locator('[data-team-message]')).toHaveCount(22)
      const retainedHistory = await api.get(`${teamPath}/messages?org=${slug}&limit=100`, { headers: bearer })
      expect(retainedHistory.status, await retainedHistory.text()).toBe(200)
      const retained = await retainedHistory.json() as { messages: TeamMessage[]; hasMore: boolean }
      expect(retained.hasMore).toBe(false)
      expect(await page.locator('[data-team-message]').evaluateAll(rows => rows.map(row => row.getAttribute('data-team-message')))).toEqual(retained.messages.map(message => message.id).reverse())
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
      const lostMcpSeat = await mcpRequest(memberMcp, baseURL!, { method: 'tools/call', toolName: 'get_team_conversation', args: { organization_id: organization.id, thread_id: threadId } })
      expect(lostMcpSeat.status()).toBe(200)
      const lostResult = (await lostMcpSeat.json()).result
      expect(lostResult.isError).toBe(true)
      expect(JSON.parse(lostResult.content[0].text)).toMatchObject({ status: 404 })
      const lostNativeSeat = await api.get(`/api/dashboard/team/threads/${threadId}/messages?org=${slug}`, { headers: inviteeBearer })
      expect(lostNativeSeat.status).toBe(404)
      // Membership resolution refuses the organization before the thread's seat check.
      expect(await lostNativeSeat.json()).toMatchObject({ data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })

      // Deleting the only owner would orphan the organization.
      const refused = await api.post('/api/auth/delete-user', { headers: bearer, data: {} })
      expect(refused.status, await refused.text()).toBe(400)
      expect(await refused.json()).toMatchObject({ code: 'SOLE_ORGANIZATION_OWNER', message: expect.stringContaining(organization.name) })
      const stillThere = await api.get('/api/auth/get-session', { headers: bearer })
      expect(stillThere.status).toBe(200)
      expect((await stillThere.json() as { user: { id: string } }).user.id).toBe(fixture.id)
    } finally {
      try {
        const deleted = await api.post('/api/auth/organization/delete', { headers: bearer, data: { organizationId: organization.id } })
        expect(deleted.status, await deleted.text()).toBe(200)
      } finally { await memberMcp.dispose() }
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
