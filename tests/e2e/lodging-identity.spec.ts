import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { expect, request as playwrightRequest, test, type WebSocket } from '@playwright/test'
import sharp from 'sharp'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { devLoginHeaders } from './test-env'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import type { TeamMember, TeamMessage, TeamThread } from '../../server/domain/team-messages'
import { ALL_VERTICALS } from '../../utils/vertical-copy'
import { isDashboardInvalidation } from '../../shared/dashboard-invalidations'
import type { TodayFeedPayload } from '../../shared/dashboard-today'
import type { Product } from '../../server/types/products'

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
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, init: { headers?: Record<string, string>; data?: unknown } = {}) => new Promise<{
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
      put: (path: string, init?: { headers?: Record<string, string>; data?: unknown }) => call('PUT', path, init),
      patch: (path: string, init?: { headers?: Record<string, string>; data?: unknown }) => call('PATCH', path, init),
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
      const beforeInvalidCursor = await api.get(`${teamPath}/messages?org=${slug}`, { headers: bearer })
      expect(beforeInvalidCursor.status, await beforeInvalidCursor.text()).toBe(200)
      const messagesBeforeInvalidCursor = await beforeInvalidCursor.json()
      for (const cursor of [{ before: replyMessage.createdAt }, { before_id: replyMessage.id }]) {
        const invalidCursor = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_team_conversation', args: { organization_id: organization.id, thread_id: threadId, ...cursor } })
        expect(invalidCursor.status(), await invalidCursor.text()).toBe(200)
        const invalidCursorResult = (await invalidCursor.json()).result
        expect(invalidCursorResult.isError).toBe(true)
        expect(invalidCursorResult.structuredContent).toBeUndefined()
        // Half a cursor passes the schema, which has no combinator Claude clients mis-render; the team-message domain refuses it.
        expect(JSON.parse(invalidCursorResult.content[0].text)).toEqual({ status: 422, message: 'before and beforeId are sent together', code: 'INVALID_CURSOR' })
      }
      const afterInvalidCursor = await api.get(`${teamPath}/messages?org=${slug}`, { headers: bearer })
      expect(afterInvalidCursor.status, await afterInvalidCursor.text()).toBe(200)
      expect(await afterInvalidCursor.json()).toEqual(messagesBeforeInvalidCursor)
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

  for (const vertical of ALL_VERTICALS) {
    test(`${vertical}: a manual group keeps its name and history while participants manage membership and leave`, async ({ baseURL, page, browser }, testInfo) => {
      test.setTimeout(120_000)
      const { api, signInBearer } = session(baseURL)
      const teammate = findE2eAuthFixture('user-e2e-lodging-host')
      const nonparticipant = findE2eAuthFixture('user-e2e-mcp-fresh-inaccessible')
      const buyer = findE2eAuthFixture('user-e2e-buyer')
      const ownerBearer = await signInBearer(fixture.email)
      const slug = `e2e-group-${vertical}-${crypto.randomUUID().slice(0, 8)}`
      const name = `Team Group ${vertical} ${slug}`
      const created = await api.post('/api/auth/organization/create', {
        headers: ownerBearer,
        data: { name, slug, default_currency: 'THB', timezone: 'Asia/Bangkok' },
      })
      expect(created.status, await created.text()).toBe(200)
      const organization = await created.json() as { id: string }
      const memberContext = await browser.newContext()
      const memberPage = await memberContext.newPage()
      const memberMcp = await playwrightRequest.newContext()
      const listPath = `/dashboard/${slug}/messages`
      const teamListPath = `/api/dashboard/team/threads?org=${slug}`
      try {
        const provisioned = await api.post('/api/organizations', {
          headers: ownerBearer,
          data: { organizationId: organization.id, name, subdomain: slug, vertical, sourceLocale: 'en' },
        })
        expect(provisioned.status, await provisioned.text()).toBe(200)
        expect(await provisioned.json()).toMatchObject({ organizationId: organization.id, subdomain: slug })
        const context = await api.get(`/api/dashboard/context?org=${slug}`, { headers: ownerBearer })
        expect(context.status, await context.text()).toBe(200)
        expect(await context.json()).toMatchObject({ success: true, organization: { id: organization.id, name, slug, subdomain: slug, vertical } })
        // Invitations use the same single-use link as a new teammate joining from the app.
        const join = async (actor: typeof invitee, role: 'admin' | 'member') => {
          const link = await api.post(`/api/organizations/${organization.id}/invite-links`, { headers: ownerBearer, data: { role } })
          expect(link.status, await link.text()).toBe(201)
          const { token } = await link.json() as { token: string }
          const bearer = await signInBearer(actor.email)
          const accepted = await api.post(`/api/invite-links/${encodeURIComponent(token)}/accept`, { headers: bearer })
          expect(accepted.status, await accepted.text()).toBe(200)
          expect(await accepted.json()).toMatchObject({ organization: { id: organization.id }, role })
          return bearer
        }
        const adminBearer = await join(invitee, 'admin')
        const memberBearer = await join(teammate, 'member')
        const outsiderBearer = await join(nonparticipant, 'admin')
        const buyerBearer = await signInBearer(buyer.email)
        await loginAs(page.request, baseURL!, fixture.id)
        await loginAs(memberContext.request, baseURL!, teammate.id)
        await loginAs(memberMcp, baseURL!, invitee.id)
        await page.goto(`${listPath}?view=team`)
        await waitForNuxtHydration(page)
        await dismissPreviewToolbar(page)
        await page.getByRole('link', { name: 'New team conversation', exact: true }).click()
        await page.getByRole('checkbox', { name: invitee.name, exact: true }).check()
        await page.getByRole('checkbox', { name: teammate.name, exact: true }).check()
        const initialName = `Handover ${slug}`
        await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(initialName)
        const groupCreated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dashboard/team/threads')
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        const groupResponse = await groupCreated
        expect(groupResponse.status(), await groupResponse.text()).toBe(201)
        const { id: threadId } = await groupResponse.json() as { id: string }
        const groupPath = `${listPath}/team/${threadId}`
        const teamPath = `/api/dashboard/team/threads/${threadId}`
        const createBody = groupResponse.request().postDataJSON() as { memberIds: string[]; name: string; idempotencyKey: string }
        expect(createBody).toMatchObject({ memberIds: [invitee.id, teammate.id].sort(), name: initialName, idempotencyKey: expect.any(String) })
        expect(createBody.idempotencyKey).not.toBe('')
        const retriedStart = await api.post(teamListPath, { headers: ownerBearer, data: createBody })
        expect(retriedStart.status, await retriedStart.text()).toBe(200)
        expect(await retriedStart.json()).toEqual({ id: threadId })
        const changedStart = await api.post(teamListPath, { headers: ownerBearer, data: { ...createBody, name: 'Different group' } })
        expect(changedStart.status, await changedStart.text()).toBe(409)
        await expect(page).toHaveURL(new RegExp(`/messages/team/${threadId}\\?view=team$`))

        const threads = async (headers: Record<string, string>) => {
          const response = await api.get(teamListPath, { headers })
          expect(response.status, await response.text()).toBe(200)
          return (await response.json() as { threads: TeamThread[] }).threads
        }
        const history = async (headers: Record<string, string>) => {
          const response = await api.get(`${teamPath}/messages?org=${slug}&limit=100`, { headers })
          expect(response.status, await response.text()).toBe(200)
          return (await response.json() as { messages: TeamMessage[] }).messages
        }
        for (const [bearer, canManage] of [[ownerBearer, true], [adminBearer, true], [memberBearer, false]] as const) {
          const group = (await threads(bearer)).find(thread => thread.id === threadId)!
          expect(group).toMatchObject({ name: initialName, isGroup: true, createdByUserId: fixture.id, canManage, canLeave: true, stayId: null, locationId: null })
          expect(group.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id, teammate.id].sort())
        }
        const messageIds: string[] = []
        const bodies: string[] = []
        for (const [actor, bearer] of [[fixture, ownerBearer], [invitee, adminBearer], [teammate, memberBearer]] as const) {
          const body = `${actor.name} group proof ${crypto.randomUUID()}`
          const sent = await api.post(`${teamPath}/messages?org=${slug}`, { headers: bearer, data: { body, idempotencyKey: crypto.randomUUID() } })
          expect(sent.status, await sent.text()).toBe(201)
          const { message } = await sent.json() as { message: TeamMessage }
          expect(message).toMatchObject({ threadId, body, senderId: actor.id })
          messageIds.push(message.id)
          bodies.push(body)
          await expect(page.locator(`[data-team-message="${message.id}"]`)).toContainText(body)
        }
        await page.screenshot({ path: testInfo.outputPath('team-group-conversation.png'), fullPage: true })
        const mcpRead = await mcpRequest(memberMcp, baseURL!, { method: 'tools/call', toolName: 'get_team_conversation', args: { organization_id: organization.id, thread_id: threadId } })
        expect(mcpRead.status(), await mcpRead.text()).toBe(200)
        expect(mcpData<{ messages: TeamMessage[] }>(await mcpRead.json()).messages.map(message => message.id).sort()).toEqual([...messageIds].sort())
        await memberPage.goto(`${groupPath}?view=team`)
        await waitForNuxtHydration(memberPage)
        await dismissPreviewToolbar(memberPage)
        await expect(memberPage.locator(`[data-team-message="${messageIds[2]}"]`)).toContainText(bodies[2]!)

        const deniedRename = await api.post(`${teamPath}/operations?org=${slug}`, { headers: memberBearer, data: { action: 'rename', name: 'Unpermitted', idempotencyKey: crypto.randomUUID() } })
        expect(deniedRename.status, await deniedRename.text()).toBe(403)
        expect((await threads(adminBearer)).find(thread => thread.id === threadId)?.name).toBe(initialName)
        for (const headers of [outsiderBearer, buyerBearer]) {
          expect((await api.get(`${teamPath}/messages?org=${slug}`, { headers })).status).toBe(404)
          expect((await api.post(`${teamPath}/messages?org=${slug}`, { headers, data: { body: 'Outside', idempotencyKey: crypto.randomUUID() } })).status).toBe(404)
          expect((await api.post(`${teamPath}/operations?org=${slug}`, { headers, data: { action: 'rename', name: 'Outside', idempotencyKey: crypto.randomUUID() } })).status).toBe(404)
        }

        await page.getByLabel('Conversation details', { exact: true }).click()
        await page.getByRole('link', { name: /^Name/ }).click()
        const renamed = `Named group ${slug}`
        await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(renamed)
        await page.getByRole('button', { name: 'Save name', exact: true }).click()
        await expect.poll(async () => (await threads(memberBearer)).find(thread => thread.id === threadId)?.name).toBe(renamed)
        const memberManagement = await api.post(`${teamPath}/operations?org=${slug}`, { headers: memberBearer, data: { action: 'remove', userId: invitee.id, idempotencyKey: crypto.randomUUID() } })
        expect(memberManagement.status, await memberManagement.text()).toBe(403)

        await page.goto(`${groupPath}/details/members?view=team`)
        await waitForNuxtHydration(page)
        await page.getByRole('button', { name: `Remove ${teammate.name}`, exact: true }).click()
        const removed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${teamPath}/operations`)
        await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
        const removedResponse = await removed
        expect(removedResponse.status(), await removedResponse.text()).toBe(200)
        expect(await removedResponse.json()).toEqual({ status: 'updated', threadId })
        expect((await threads(adminBearer)).find(thread => thread.id === threadId)?.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id].sort())
        expect((await history(adminBearer)).map(message => message.id).sort()).toEqual([...messageIds].sort())
        // Revocation reaches an already-open browser; a stale transcript is not retained.
        await expect(memberPage.locator('[data-team-message]')).toHaveCount(0)
        await expect(memberPage.locator(`[data-team-thread="${threadId}"]`)).toHaveCount(0)
        expect((await api.get(`${teamPath}/messages?org=${slug}`, { headers: memberBearer })).status).toBe(404)
        expect((await api.post(`${teamPath}/messages?org=${slug}`, { headers: memberBearer, data: { body: 'No seat', idempotencyKey: crypto.randomUUID() } })).status).toBe(404)

        await page.getByRole('checkbox', { name: teammate.name, exact: true }).check()
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await expect.poll(async () => (await threads(adminBearer)).find(thread => thread.id === threadId)?.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id, teammate.id].sort())
        expect((await history(memberBearer)).map(message => message.id).sort()).toEqual([...messageIds].sort())
        await memberPage.goto(`${groupPath}?view=team`)
        await waitForNuxtHydration(memberPage)
        await expect(memberPage.locator(`[data-team-message="${messageIds[0]}"]`)).toContainText(bodies[0]!)
        await memberPage.getByLabel('Conversation details', { exact: true }).click()
        await expect(memberPage.getByRole('link', { name: /^Name/ })).toHaveCount(0)
        await memberPage.getByRole('button', { name: 'Leave conversation', exact: true }).click()
        const left = memberPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${teamPath}/operations`)
        await memberPage.getByRole('dialog').getByRole('button', { name: 'Leave conversation', exact: true }).click()
        const leftResponse = await left
        expect(leftResponse.status(), await leftResponse.text()).toBe(200)
        expect(await leftResponse.json()).toEqual({ status: 'left', threadId })
        expect((await threads(ownerBearer)).find(thread => thread.id === threadId)?.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id].sort())
        expect((await api.get(`${teamPath}/messages?org=${slug}`, { headers: memberBearer })).status).toBe(404)
        expect((await api.post(`${teamPath}/messages?org=${slug}`, { headers: memberBearer, data: { body: 'After leaving', idempotencyKey: crypto.randomUUID() } })).status).toBe(404)

        // The participating admin can manage; an owner's role cannot replace a lost seat.
        const adminRename = await mcpRequest(memberMcp, baseURL!, { method: 'tools/call', toolName: 'update_team_group', args: { organization_id: organization.id, thread_id: threadId, action: 'rename', name: 'Admin handover', idempotency_key: crypto.randomUUID() } })
        expect(adminRename.status(), await adminRename.text()).toBe(200)
        expect(mcpData<{ status: 'updated'; threadId: string }>(await adminRename.json())).toEqual({ status: 'updated', threadId })
        expect((await threads(ownerBearer)).find(thread => thread.id === threadId)?.name).toBe('Admin handover')
        await page.goto(`${groupPath}/details/members?view=team`)
        await waitForNuxtHydration(page)
        await expect(page.getByRole('button', { name: `Remove ${invitee.name}`, exact: true })).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath('team-group-details-after-membership-changes.png'), fullPage: true })
        const ownerLeft = await api.post(`${teamPath}/operations?org=${slug}`, { headers: ownerBearer, data: { action: 'leave', idempotencyKey: crypto.randomUUID() } })
        expect(ownerLeft.status, await ownerLeft.text()).toBe(200)
        expect(await ownerLeft.json()).toEqual({ status: 'left', threadId })
        expect((await api.get(`${teamPath}/messages?org=${slug}`, { headers: ownerBearer })).status).toBe(404)
        expect((await api.post(`${teamPath}/messages?org=${slug}`, { headers: ownerBearer, data: { body: 'Owner bypass', idempotencyKey: crypto.randomUUID() } })).status).toBe(404)
        expect((await api.post(`${teamPath}/operations?org=${slug}`, { headers: ownerBearer, data: { action: 'rename', name: 'Owner bypass', idempotencyKey: crypto.randomUUID() } })).status).toBe(404)
        expect((await history(adminBearer)).map(message => message.id).sort()).toEqual([...messageIds].sort())

        // A direct conversation keeps its existing protected addressing and has no group controls.
        const direct = await api.post(teamListPath, { headers: adminBearer, data: { memberIds: [fixture.id] } })
        expect(direct.status, await direct.text()).toBe(201)
        const { id: directId } = await direct.json() as { id: string }
        expect((await threads(ownerBearer)).find(thread => thread.id === directId)).toMatchObject({ name: null, isGroup: false, canManage: false, canLeave: false })
        const protectedDirect = await api.post(`/api/dashboard/team/threads/${directId}/operations?org=${slug}`, { headers: ownerBearer, data: { action: 'leave', idempotencyKey: crypto.randomUUID() } })
        expect(protectedDirect.status, await protectedDirect.text()).toBe(409)
        expect(await protectedDirect.json()).toMatchObject({ data: { code: 'TEAM_GROUP_PROTECTED', field: 'threadId' } })
        await page.goto(`${listPath}/team/${directId}?view=team`)
        await waitForNuxtHydration(page)
        await expect(page.getByLabel('Conversation details', { exact: true })).toHaveCount(0)
        await loginAs(memberContext.request, baseURL!, buyer.id)
        await memberPage.goto('/dashboard/account/messages')
        await waitForNuxtHydration(memberPage)
        await expect(memberPage.getByRole('link', { name: 'New team conversation', exact: true })).toHaveCount(0)
        await expect(memberPage.getByLabel('Conversation details', { exact: true })).toHaveCount(0)
      } finally {
        try {
          const deleted = await api.post('/api/auth/organization/delete', { headers: ownerBearer, data: { organizationId: organization.id } })
          expect(deleted.status, await deleted.text()).toBe(200)
        } finally { await Promise.all([memberContext.close(), memberMcp.dispose()]) }
      }
    })
  }

  test('an experience team manages a business-scheduled booking without a booked individual and loses access when removed', async ({ baseURL, page, browser, request }) => {
    test.setTimeout(120_000)
    const { api, signInBearer } = session(baseURL)
    const ownerBearer = await signInBearer(fixture.email)
    const memberBearer = await signInBearer(invitee.email)
    const slug = `e2e-responsibility-${crypto.randomUUID().slice(0, 8)}`
    const name = `Experience responsibility ${slug}`
    const created = await api.post('/api/auth/organization/create', { headers: ownerBearer, data: { name, slug, default_currency: 'THB', timezone: 'UTC' } })
    expect(created.status, await created.text()).toBe(200)
    const organization = await created.json() as { id: string }
    const memberContext = await browser.newContext()
    try {
      const provisioned = await api.post('/api/organizations', { headers: ownerBearer, data: { organizationId: organization.id, name, subdomain: slug, vertical: 'experience', sourceLocale: 'en' } })
      expect(provisioned.status, await provisioned.text()).toBe(200)
      const offered = await api.post(`/api/organizations/${organization.id}/invite-links`, { headers: ownerBearer, data: { role: 'member' } })
      expect(offered.status, await offered.text()).toBe(201)
      const { token } = await offered.json() as { token: string }
      const accepted = await api.post(`/api/invite-links/${token}/accept`, { headers: memberBearer })
      expect(accepted.status, await accepted.text()).toBe(200)
      const { memberId } = await accepted.json() as { memberId: string }
      const profile = await api.put(`/api/organizations/${organization.id}/members/${memberId}/scheduling`, { headers: ownerBearer, data: { expected_updated_at: null, public_name: 'Experience guide', public_bio: 'Leads the local experience.', public_approved: true } })
      expect(profile.status, await profile.text()).toBe(200)
      const teamName = 'Experience hosts'
      const madeTeam = await api.post('/api/auth/organization/create-team', { headers: ownerBearer, data: { organizationId: organization.id, name: teamName } })
      expect(madeTeam.status, await madeTeam.text()).toBe(200)
      const { id: teamId } = await madeTeam.json() as { id: string }
      const included = await api.post('/api/auth/organization/add-team-member', { headers: ownerBearer, data: { organizationId: organization.id, teamId, userId: invitee.id } })
      expect(included.status, await included.text()).toBe(200)
      const context = await api.get(`/api/dashboard/context?org=${slug}`, { headers: ownerBearer })
      expect(context.status, await context.text()).toBe(200)
      const { locations } = await context.json() as { locations: Array<{ id: string }> }
      expect(locations).toHaveLength(1)
      const locationId = locations[0]!.id
      const opened = await api.patch(`/api/dashboard/locations/${locationId}?org=${slug}`, { headers: ownerBearer, data: { timezone: 'UTC', opening_hours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] } } })
      expect(opened.status, await opened.text()).toBe(200)
      const editor = `/api/editor/organizations/${organization.id}`
      const madeProduct = await api.post(`${editor}/products`, { headers: ownerBearer, data: { kind: 'experience', name: 'Team-led local experience', active: true, variants: [{ name: 'One guest', prices: [{ unit_amount: 0, currency: 'THB' }] }] } })
      expect(madeProduct.status, await madeProduct.text()).toBe(201)
      const { product } = await madeProduct.json() as { product: Product }
      const configured = await api.put(`${editor}/products/${product.id}/booking`, { headers: ownerBearer, data: { duration_minutes: 60, default_capacity: 4, scheduling_mode: 'legacy', confirmation_mode: 'review', online_payment_required: false } })
      expect(configured.status, await configured.text()).toBe(200)
      await loginAs(page.request, baseURL!, fixture.id)
      await page.goto(`/dashboard/${slug}/products/${product.id}/booking/assignment`)
      const assignment = page.locator('#dashboard-panel-booking-assignment')
      await assignment.getByRole('radio', { name: `Team: ${teamName} 1 member: Guests see each one with a published profile`, exact: true }).check()
      await expect(assignment.getByRole('switch', { name: 'Book each team member’s working hours', exact: true })).not.toBeChecked()
      const assigned = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `${editor}/products/${product.id}/booking`)
      await assignment.getByRole('button', { name: 'Save', exact: true }).click()
      const assignedResponse = await assigned
      expect(assignedResponse.status(), await assignedResponse.text()).toBe(200)
      expect(assignedResponse.request().postDataJSON()).toEqual({ scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: teamId })
      const productRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: organization.id, product_id: product.id } })
      expect(productRead.status(), await productRead.text()).toBe(200)
      expect(mcpData<{ product: Product }>(await productRead.json()).product.booking).toMatchObject({ scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: teamId })
      const placed = await api.put(`${editor}/products/${product.id}/locations/${locationId}`, { headers: ownerBearer, data: { active: true, published: false } })
      expect(placed.status, await placed.text()).toBe(200)
      const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
      const sessionCreated = await api.post(`${editor}/products/${product.id}/sessions`, { headers: ownerBearer, data: { location_id: locationId, starts_at: `${day}T10:00:00.000Z`, ends_at: `${day}T11:00:00.000Z`, capacity: 4, idempotency_key: crypto.randomUUID() } })
      expect(sessionCreated.status, await sessionCreated.text()).toBe(201)
      const { sessions } = await sessionCreated.json() as { sessions: Array<{ id: string }> }
      expect(sessions).toHaveLength(1)
      const shownAtLocation = await api.put(`${editor}/products/${product.id}/locations/${locationId}`, { headers: ownerBearer, data: { active: true, published: true } })
      expect(shownAtLocation.status, await shownAtLocation.text()).toBe(200)
      const published = await api.put(`${editor}/products/${product.id}/publication`, { headers: ownerBearer, data: { published: true } })
      expect(published.status, await published.text()).toBe(200)
      const guestName = `Experience team guest ${crypto.randomUUID()}`
      const booked = await request.post(`/api/public/products/${product.slug}/book`, { headers: { 'x-preview-tenant': slug }, data: { session_id: sessions[0]!.id, variant_id: product.variants[0]!.id, party_size: 1, guest_name: guestName, guest_email: `${slug}@playwright.example`, idempotency_key: crypto.randomUUID() } })
      expect(booked.status(), await booked.text()).toBe(201)
      const { request_id: requestId } = await booked.json() as { request_id: string }
      const bookingPath = `/api/dashboard/bookings/booking/${requestId}?org=${slug}`
      const inboxPath = `/api/dashboard/organizations/${organization.id}/guest-threads/${requestId}`
      const memberBooking = await api.get(bookingPath, { headers: memberBearer })
      expect(memberBooking.status, await memberBooking.text()).toBe(200)
      expect(await memberBooking.json()).toMatchObject({ booking: { id: requestId, assignedMemberId: null, experienceId: product.id, guestName } })
      const today = await api.get(`/api/dashboard/today?org=${slug}`, { headers: memberBearer })
      expect(today.status, await today.text()).toBe(200)
      expect((await today.json() as TodayFeedPayload).cards.map(card => card.id)).toContain(`attention:${requestId}`)
      await loginAs(memberContext.request, baseURL!, invitee.id)
      const memberPage = await memberContext.newPage()
      let socket: WebSocket | undefined
      memberPage.on('websocket', next => { if (new URL(next.url()).pathname === '/api/dashboard/guest-inbox/socket') socket = next })
      const reconciled = memberPage.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === inboxPath)
      await memberPage.goto(`/dashboard/${slug}/messages/${requestId}`)
      expect((await reconciled).status()).toBe(200)
      await expect(memberPage.getByRole('heading', { name: guestName, exact: true })).toBeVisible()
      await expect(memberPage.getByRole('textbox', { name: 'Write a message…', exact: true })).toBeVisible()
      if (!socket || socket.isClosed()) throw new Error('The responsible experience member has no live inbox socket')
      const revoked = socket.waitForEvent('framereceived', { predicate: frame => {
        if (frame.payload === 'pong') return false
        const event: unknown = JSON.parse(String(frame.payload))
        return isDashboardInvalidation(event) && event.type === 'access.changed' && event.organizationId === organization.id
      } })
      const removed = await api.post('/api/auth/organization/remove-team-member', { headers: ownerBearer, data: { organizationId: organization.id, teamId, userId: invitee.id } })
      expect(removed.status, await removed.text()).toBe(200)
      await revoked
      await expect(memberPage.getByText(guestName, { exact: true })).toHaveCount(0)
      await expect(memberPage.getByRole('textbox', { name: 'Write a message…', exact: true })).toHaveCount(0)
      expect((await api.get(bookingPath, { headers: memberBearer })).status).toBe(404)
      expect((await api.get(inboxPath, { headers: memberBearer })).status).toBe(404)
      const afterToday = await api.get(`/api/dashboard/today?org=${slug}`, { headers: memberBearer })
      expect(afterToday.status, await afterToday.text()).toBe(200)
      expect((await afterToday.json() as TodayFeedPayload).cards.map(card => card.id)).not.toContain(`attention:${requestId}`)
      const retained = await api.get(bookingPath, { headers: ownerBearer })
      expect(retained.status, await retained.text()).toBe(200)
      expect(await retained.json()).toMatchObject({ booking: { id: requestId, assignedMemberId: null, experienceId: product.id, guestName } })
    } finally {
      try {
        const deleted = await api.post('/api/auth/organization/delete', { headers: ownerBearer, data: { organizationId: organization.id } })
        expect(deleted.status, await deleted.text()).toBe(200)
      } finally { await memberContext.close() }
    }
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
