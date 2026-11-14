import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import sharp from 'sharp'
import { E2E_PASSWORD, findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { devLoginHeaders } from './test-env'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import type { TeamMember } from '../../server/domain/team-messages'
import type { InboxRow } from '../../server/domain/guest-threads/types'
import { ALL_VERTICALS } from '../../utils/vertical-copy'
import type { ConversationEntriesPage, ConversationMessage, ConversationPage } from '../../shared/messages-contract'
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
        data: { email, password: E2E_PASSWORD, rememberMe: false },
      })
      expect(signIn.status, await signIn.text()).toBe(200)
      const token = signIn.headers.get('set-auth-token')
      expect(token, 'Better Auth issues the bearer in set-auth-token').toBeTruthy()
      return { authorization: `Bearer ${token}` }
    }
    return { api, signInBearer }
  }

  test('a bearer session keeps its organization and shares team conversations with MCP until membership ends', async ({ baseURL, page, request }) => {
    test.setTimeout(60_000)
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

      const invitation = await api.post('/api/auth/organization/invite-member', {
        headers: bearer, data: { organizationId: organization.id, email: invitee.email, role: 'admin' },
      })
      expect(invitation.status, await invitation.text()).toBe(200)
      const { id: invitationId } = await invitation.json() as { id: string }
      const inviteeBearer = await signInBearer(invitee.email)
      const offered = await api.get('/api/auth/organization/get-invitation?id=' + encodeURIComponent(invitationId), { headers: inviteeBearer })
      expect(offered.status, await offered.text()).toBe(200)
      expect(await offered.json()).toMatchObject({ organizationName: organization.name, email: invitee.email, role: 'admin' })
      const accepted = await api.post('/api/auth/organization/accept-invitation', { headers: inviteeBearer, data: { invitationId } })
      expect(accepted.status, await accepted.text()).toBe(200)
      const { member: joined } = await accepted.json() as { member: { id: string; organizationId: string; role: string } }
      expect(joined).toMatchObject({ organizationId: organization.id, role: 'admin' })
      expect(await members()).toEqual(expect.arrayContaining([expect.objectContaining({ id: joined.id, userId: invitee.id, role: 'admin' })]))

      // MCP and the native app address the same participants, messages and read
      // positions. This organization already exists for the invitation journey.
      await loginAs(request, baseURL!, fixture.id)
      await loginAs(memberMcp, baseURL!, invitee.id)
      const teamCall = async <T>(toolName: string, args: Record<string, unknown> = {}, client = request) => {
        const response = await mcpRequest(client, baseURL!, { method: 'tools/call', toolName, args: { organization_id: organization.id, ...args } })
        expect(response.status(), await response.text()).toBe(200)
        return mcpData<T>(await response.json())
      }
      const messages = (page: Pick<ConversationEntriesPage, 'entries'>) => page.entries.filter((entry): entry is ConversationMessage => entry.type === 'message')
      const teamRead = (args: { before?: number } = {}, client = request) => teamCall<ConversationPage>('get_conversation', { conversation_id: threadId, ...args }, client)
      const recipients = await teamCall<{ current_user_id: string; members: TeamMember[] }>('list_conversation_recipients')
      expect(recipients.current_user_id).toBe(fixture.id)
      const nativeMembers = await api.get(`/api/dashboard/team/members?org=${slug}`, { headers: bearer })
      expect(nativeMembers.status, await nativeMembers.text()).toBe(200)
      expect(recipients.members).toEqual((await nativeMembers.json() as { members: TeamMember[] }).members)
      expect(recipients.members.map(member => member.id).sort()).toEqual([fixture.id, invitee.id].sort())
      const started = await teamCall<{ conversation_id: string; created: boolean }>('start_conversation', { member_user_ids: [invitee.id] })
      expect(started.created).toBe(true)
      const threadId = started.conversation_id
      const teamPath = `/api/messages/${threadId}`
      const reusedTeam = await api.post(`/api/dashboard/team/threads?org=${slug}`, { headers: inviteeBearer, data: { member_user_ids: [fixture.id] } })
      expect(reusedTeam.status, await reusedTeam.text()).toBe(200)
      expect(await reusedTeam.json()).toEqual({ conversation_id: threadId })
      const conversations = await teamCall<{ conversations: Array<{ conversation_id: string; kind: string; unread: boolean }>; page_info: { has_more: boolean; next_cursor: string | null } }>('list_conversations', { kind: 'team' })
      expect(conversations.conversations).toEqual([expect.objectContaining({ conversation_id: threadId, kind: 'team', unread: false })])
      expect(conversations.page_info).toEqual({ has_more: false, next_cursor: null })
      const opened = (await teamRead()).conversation
      expect(opened).toMatchObject({ id: threadId, booking_id: null })
      expect(opened).not.toHaveProperty('location_id')
      expect(opened).not.toHaveProperty('stay')
      expect(opened.participants.map(member => member.id).sort()).toEqual([fixture.id, invitee.id].sort())
      const message = `The guest room is ready ${crypto.randomUUID()}`
      const idempotencyKey = crypto.randomUUID()
      const sentReceipt = await teamCall<{ conversation_id: string; message: { id: string; sequence: number } }>('send_message', { conversation_id: threadId, message, idempotency_key: idempotencyKey })
      expect(sentReceipt).toMatchObject({ conversation_id: threadId, message: { id: expect.any(String), sequence: 1 } })
      const sent = { message: messages(await teamRead())[0]! }
      expect(sent.message).toMatchObject({ id: sentReceipt.message.id, sequence: sentReceipt.message.sequence, author_user_id: fixture.id, body: message, photos: [] })
      const replay = await teamCall<{ conversation_id: string; message: { id: string; sequence: number } }>('send_message', { conversation_id: threadId, message, idempotency_key: idempotencyKey })
      expect(replay).toEqual(sentReceipt)
      const changedRetry = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'send_message', args: { organization_id: organization.id, conversation_id: threadId, message: 'Different content', idempotency_key: idempotencyKey } })
      expect(changedRetry.status()).toBe(200)
      const changedRetryResult = (await changedRetry.json()).result
      expect(changedRetryResult.isError).toBe(true)
      expect(JSON.parse(changedRetryResult.content[0].text)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
      const nativeRead = await api.get(teamPath, { headers: inviteeBearer })
      expect(nativeRead.status, await nativeRead.text()).toBe(200)
      const nativePage = await nativeRead.json() as ConversationPage
      expect(nativePage).toMatchObject({ page: { before: null }, conversation: { id: threadId } })
      expect(nativePage.entries.map(entry => entry.type)).toEqual(['day', 'message'])
      expect(messages(nativePage)).toMatchObject([{ id: sent.message.id, body: message, author_user_id: fixture.id }])
      const teamRows = async (headers: Record<string, string>) => {
        const response = await api.get(`/api/messages?organization_id=${organization.id}&kind=team`, { headers })
        expect(response.status, await response.text()).toBe(200)
        return (await response.json() as { threads: InboxRow[] }).threads
      }
      expect(await teamRows(inviteeBearer)).toEqual([expect.objectContaining({ id: threadId, kind: 'team', unread: true })])
      const marked = await teamCall<{ conversation_id: string; unread: boolean; last_read_message_id: string | null }>('mark_conversation_read', { conversation_id: threadId }, memberMcp)
      expect(marked).toEqual({ conversation_id: threadId, unread: false, last_read_message_id: sent.message.id })
      expect(await teamRows(inviteeBearer)).toEqual([expect.objectContaining({ id: threadId, unread: false })])
      const reply = await api.post(teamPath, { headers: inviteeBearer, data: { body: 'Thank you, I will check the room.', idempotency_key: crypto.randomUUID() } })
      expect(reply.status, await reply.text()).toBe(200)
      const replyMessage = (await reply.json() as { message: ConversationMessage }).message
      const latest = await teamRead()
      expect(messages(latest).at(-1)).toMatchObject({ id: replyMessage.id, sequence: replyMessage.sequence })
      const beforeInvalidCursor = await api.get(teamPath, { headers: bearer })
      expect(beforeInvalidCursor.status, await beforeInvalidCursor.text()).toBe(200)
      const messagesBeforeInvalidCursor = await beforeInvalidCursor.json()
      for (const cursor of [{ before: 'invalid' }, { before: 0 }]) {
        const invalidCursor = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_conversation', args: { organization_id: organization.id, conversation_id: threadId, ...cursor } })
        expect(invalidCursor.status(), await invalidCursor.text()).toBe(200)
        const invalidCursorResult = (await invalidCursor.json()).result
        expect(invalidCursorResult.isError).toBe(true)
        expect(invalidCursorResult.structuredContent).toBeUndefined()
        expect(invalidCursorResult.content[0].text).toContain('Invalid arguments for tool get_conversation')
      }
      const afterInvalidCursor = await api.get(teamPath, { headers: bearer })
      expect(afterInvalidCursor.status, await afterInvalidCursor.text()).toBe(200)
      expect(await afterInvalidCursor.json()).toEqual(messagesBeforeInvalidCursor)
      const earlier = await teamRead({ before: replyMessage.sequence })
      expect(messages(earlier).map(entry => entry.id)).toEqual([sent.message.id])
      expect(earlier.page.before).toBeNull()
      expect(await teamRows(bearer)).toEqual([expect.objectContaining({ id: threadId, unread: true })])

      await loginAs(page.request, baseURL!, fixture.id)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/dashboard/${slug}/messages?kind=team`)
      await dismissPreviewToolbar(page)
      await expect(page.locator('[data-conversation-list-hydrated="true"]')).toBeVisible()
      await page.getByRole('link', { name: 'New conversation', exact: true }).click()
      await page.getByRole('checkbox', { name: invitee.name, exact: true }).check()
      const reopened = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dashboard/team/threads')
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      const reopenedResponse = await reopened
      expect(reopenedResponse.status()).toBe(200)
      expect(await reopenedResponse.json()).toEqual({ conversation_id: threadId })
      await expect(page).toHaveURL(new RegExp(`/messages/${threadId}\\?kind=team$`))
      const cmsBody = `Team CMS proof ${crypto.randomUUID()}`
      const composer = page.getByRole('textbox', { name: 'Message your team', exact: true })
      await composer.fill(cmsBody)
      // A lost request keeps the actual draft and retry identity in the CMS.
      let attemptedKey = ''
      await page.route(`**${teamPath}`, async route => {
        if (route.request().method() !== 'POST') return route.continue()
        attemptedKey = (route.request().postDataJSON() as { idempotency_key: string }).idempotency_key
        await route.abort('failed')
      })
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(page.getByText('Failed to fetch', { exact: false })).toBeVisible()
      await expect(composer).toHaveValue(cmsBody)
      await page.unroute(`**${teamPath}`)
      // The local Worker has no APNs signing key. Register through the native
      // boundary so its actual failed push receipt must be visible in the CMS.
      const deviceToken = crypto.randomUUID().replaceAll('-', '')
      const registered = await api.post('/api/dashboard/devices', { headers: inviteeBearer, data: { token: deviceToken, environment: 'sandbox' } })
      expect(registered.status, await registered.text()).toBe(200)
      expect(await registered.json()).toEqual({ status: 'registered' })
      try {
        const cmsSent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === teamPath)
        await page.getByRole('button', { name: 'Send message', exact: true }).click()
        const cmsSentResponse = await cmsSent
        expect(cmsSentResponse.status()).toBe(200)
        expect((cmsSentResponse.request().postDataJSON() as { idempotency_key: string }).idempotency_key).toBe(attemptedKey)
        await expect(composer).toHaveValue('')
        const cmsNativeRead = await api.get(teamPath, { headers: inviteeBearer })
        expect(cmsNativeRead.status, await cmsNativeRead.text()).toBe(200)
        const cmsMatches = messages(await cmsNativeRead.json() as ConversationPage).filter(message => message.body === cmsBody)
        expect(cmsMatches).toHaveLength(1)
        const saved = cmsMatches[0]!
        expect(saved).toMatchObject({ author_user_id: fixture.id, deliveries: expect.arrayContaining([expect.objectContaining({ channel: 'push', status: 'failed', error: expect.stringMatching(/^APNS_CONFIG_REQUIRED: /) })]) })
        const savedRow = page.locator(`[data-team-message="${saved.id}"]`)
        await expect(savedRow).toContainText(cmsBody)
        await expect(savedRow).toContainText('Message saved. A notification failed.')
        await savedRow.getByRole('button', { name: 'Delivery error details', exact: true }).click()
        await expect(savedRow).toContainText(saved.deliveries.find(delivery => delivery.channel === 'push')!.error!)
        const cmsMcpRead = await teamRead({}, memberMcp)
        expect(messages(cmsMcpRead).at(-1)).toEqual(saved)
      } finally {
        const unregistered = await api.delete('/api/dashboard/devices', { headers: inviteeBearer, data: { token: deviceToken } })
        expect(unregistered.status, await unregistered.text()).toBe(200)
        expect(await unregistered.json()).toEqual({ status: 'unregistered' })
      }

      await page.setViewportSize({ width: 390, height: 844 })
      await expect(composer).toBeVisible()
      await expect(page.locator('[data-team-delivery-failure]')).toContainText('Message saved. A notification failed.')
      await page.locator('input[type="file"]').setInputFiles({ name: 'team-message-proof.avif', mimeType: 'image/avif', buffer: await sharp('public/platform/apple-touch-icon.png').avif().toBuffer() })
      const photoSent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === teamPath)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const photoResponse = await photoSent
      expect(photoResponse.status()).toBe(200)
      const sentPhoto = (await photoResponse.json() as { message: ConversationMessage }).message
      expect(sentPhoto.deliveries).toEqual([expect.objectContaining({ channel: 'email', status: 'sent' })])
      const photoRead = await api.get(teamPath, { headers: inviteeBearer })
      expect(photoRead.status, await photoRead.text()).toBe(200)
      const photo = messages(await photoRead.json() as ConversationPage).at(-1)!
      expect(photo).toMatchObject({ id: sentPhoto.id, body: '', author_user_id: fixture.id, deliveries: [] })
      expect(photo.photos).toHaveLength(1)
      const loadedPhoto = await api.get(photo.photos[0]!.url)
      expect(loadedPhoto.status).toBe(200)
      expect(loadedPhoto.headers.get('content-type')).toBe('image/avif')
      await expect(page.locator(`[data-team-message="${photo.id}"] img`)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const photoMcpRead = await teamRead({}, memberMcp)
      expect(messages(photoMcpRead).at(-1)).toEqual(photo)
      expect(await teamRows(inviteeBearer)).toEqual([expect.objectContaining({ id: threadId, unread: true })])

      // Native arrivals cross the first page. Loading earlier history must keep
      // its oldest row when the next live arrival refreshes the source window.
      let lastHistoryMessage: ConversationMessage | null = null
      for (let index = 0; index < 42; index++) {
        const historySent = await api.post(teamPath, { headers: inviteeBearer, data: { body: `Native team history ${index + 1} ${threadId}`, idempotency_key: crypto.randomUUID() } })
        expect(historySent.status, await historySent.text()).toBe(200)
        lastHistoryMessage = (await historySent.json() as { message: ConversationMessage }).message
      }
      await expect(page.locator(`[data-team-message="${lastHistoryMessage!.id}"]`)).toContainText(lastHistoryMessage!.body!)
      const oldestRow = page.locator(`[data-team-message="${sent.message.id}"]`)
      await expect(oldestRow).toHaveCount(0)
      const earlierMessages = page.getByRole('button', { name: 'Earlier messages', exact: true })
      await expect(earlierMessages).toBeVisible()
      await earlierMessages.click()
      await expect(oldestRow).toContainText(message)
      await expect(earlierMessages).toHaveCount(0)
      const liveBody = `Native arrival after loading earlier messages ${threadId}`
      const liveSent = await api.post(teamPath, { headers: inviteeBearer, data: { body: liveBody, idempotency_key: crypto.randomUUID() } })
      expect(liveSent.status, await liveSent.text()).toBe(200)
      const liveMessage = (await liveSent.json() as { message: ConversationMessage }).message
      const liveRow = page.locator(`[data-team-message="${liveMessage.id}"]`)
      await expect(liveRow).toBeVisible()
      await expect(liveRow).toContainText(liveBody)
      await expect(oldestRow).toBeVisible()
      await expect(oldestRow).toContainText(message)
      await expect(page.locator('[data-team-message]')).toHaveCount(47)
      const retainedHistory = await api.get(teamPath, { headers: bearer })
      expect(retainedHistory.status, await retainedHistory.text()).toBe(200)
      const retained = await retainedHistory.json() as ConversationPage
      expect(retained.page.before).not.toBeNull()
      const older = await api.get(`${teamPath}?before=${retained.page.before}`, { headers: bearer })
      expect(older.status, await older.text()).toBe(200)
      const prior = await older.json() as ConversationEntriesPage
      expect(Object.keys(prior).sort()).toEqual(['conversation_id', 'entries', 'page'])
      expect(prior.conversation_id).toBe(threadId)
      expect(prior.page.before).toBeNull()
      expect(prior.page.newest).toBeLessThan(retained.page.before!)
      expect(await page.locator('[data-team-message]').evaluateAll(rows => rows.map(row => row.getAttribute('data-team-message')))).toEqual([...messages(prior), ...messages(retained)].map(message => message.id))
      const reused = await api.post('/api/auth/organization/accept-invitation', { headers: inviteeBearer, data: { invitationId } })
      expect(reused.status).toBe(400)
      expect(await reused.json()).toMatchObject({ code: 'INVITATION_NOT_FOUND' })
      const inviteeLeft = await api.post('/api/auth/organization/leave', { headers: inviteeBearer, data: { organizationId: organization.id } })
      expect(inviteeLeft.status, await inviteeLeft.text()).toBe(200)
      expect(await members()).toEqual([expect.objectContaining({ userId: fixture.id, role: 'owner' })])
      const lostMcpSeat = await mcpRequest(memberMcp, baseURL!, { method: 'tools/call', toolName: 'get_conversation', args: { organization_id: organization.id, conversation_id: threadId } })
      expect(lostMcpSeat.status()).toBe(200)
      const lostResult = (await lostMcpSeat.json()).result
      expect(lostResult.isError).toBe(true)
      expect(JSON.parse(lostResult.content[0].text)).toMatchObject({ status: 404 })
      const lostNativeSeat = await api.get(teamPath, { headers: inviteeBearer })
      expect(lostNativeSeat.status).toBe(404)
      expect(await lostNativeSeat.json()).toMatchObject({ data: { code: 'THREAD_NOT_FOUND', field: 'conversation_id' } })

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
          data: { organization_id: organization.id, name, subdomain: slug, vertical, source_locale: 'en' },
        })
        expect(provisioned.status, await provisioned.text()).toBe(200)
        expect(await provisioned.json()).toMatchObject({ organization_id: organization.id, subdomain: slug })
        const context = await api.get(`/api/dashboard/context?org=${slug}`, { headers: ownerBearer })
        expect(context.status, await context.text()).toBe(200)
        expect(await context.json()).toMatchObject({ success: true, organization: { id: organization.id, name, slug, subdomain: slug, vertical } })
        const join = async (actor: typeof invitee, role: 'admin' | 'member') => {
          const invitation = await api.post('/api/auth/organization/invite-member', {
            headers: ownerBearer, data: { organizationId: organization.id, email: actor.email, role },
          })
          expect(invitation.status, await invitation.text()).toBe(200)
          const { id: invitationId } = await invitation.json() as { id: string }
          const bearer = await signInBearer(actor.email)
          const accepted = await api.post('/api/auth/organization/accept-invitation', { headers: bearer, data: { invitationId } })
          expect(accepted.status, await accepted.text()).toBe(200)
          expect(await accepted.json()).toMatchObject({ member: { organizationId: organization.id, role } })
          return bearer
        }
        const adminBearer = await join(invitee, 'admin')
        const memberBearer = await join(teammate, 'member')
        const outsiderBearer = await join(nonparticipant, 'admin')
        const buyerBearer = await signInBearer(buyer.email)
        await loginAs(page.request, baseURL!, fixture.id)
        await loginAs(memberContext.request, baseURL!, teammate.id)
        await loginAs(memberMcp, baseURL!, invitee.id)
        await page.goto(`${listPath}?kind=team`)
        await waitForNuxtHydration(page)
        await dismissPreviewToolbar(page)
        await page.getByRole('link', { name: 'New conversation', exact: true }).click()
        await page.getByRole('checkbox', { name: invitee.name, exact: true }).check()
        await page.getByRole('checkbox', { name: teammate.name, exact: true }).check()
        const initialName = `Handover ${slug}`
        await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(initialName)
        const groupCreated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dashboard/team/threads')
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        const groupResponse = await groupCreated
        expect(groupResponse.status(), await groupResponse.text()).toBe(201)
        const { conversation_id: threadId } = await groupResponse.json() as { conversation_id: string }
        const groupPath = `${listPath}/${threadId}`
        const teamPath = `/api/messages/${threadId}`
        const operations = `/api/dashboard/team/threads/${threadId}/operations`
        const createBody = groupResponse.request().postDataJSON() as { member_user_ids: string[]; name: string; idempotency_key: string }
        expect(createBody).toMatchObject({ member_user_ids: [invitee.id, teammate.id].sort(), name: initialName, idempotency_key: expect.any(String) })
        expect(createBody.idempotency_key).not.toBe('')
        const retriedStart = await api.post(teamListPath, { headers: ownerBearer, data: createBody })
        expect(retriedStart.status, await retriedStart.text()).toBe(200)
        expect(await retriedStart.json()).toEqual({ conversation_id: threadId })
        const changedStart = await api.post(teamListPath, { headers: ownerBearer, data: { ...createBody, name: 'Different group' } })
        expect(changedStart.status, await changedStart.text()).toBe(409)
        await expect(page).toHaveURL(new RegExp(`/messages/${threadId}\\?kind=team$`))

        // One team conversation as its screen reads it; a member who is not in it reads 404.
        const threads = async (headers: Record<string, string>, id = threadId) => {
          const response = await api.get(`/api/messages/${id}`, { headers })
          if (response.status === 404) return []
          expect(response.status, await response.text()).toBe(200)
          const { conversation, capabilities } = await response.json() as ConversationPage
          if (conversation.kind !== 'team') throw new Error(`Expected a team conversation for ${id}`)
          return [{ ...conversation, capabilities }]
        }
        const history = async (headers: Record<string, string>) => {
          const response = await api.get(teamPath, { headers })
          expect(response.status, await response.text()).toBe(200)
          return (await response.json() as ConversationPage).entries.filter(entry => entry.type === 'message')
        }
        for (const [bearer, can_manage] of [[ownerBearer, true], [adminBearer, true], [memberBearer, false]] as const) {
          const group = (await threads(bearer)).find(thread => thread.id === threadId)!
          expect(group).toMatchObject({ name: initialName, is_group: true, created_by_user_id: fixture.id, capabilities: { can_manage_participants: can_manage, can_leave: true }, booking_id: null })
          expect(group.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id, teammate.id].sort())
        }
        const messageIds: string[] = []
        const bodies: string[] = []
        for (const [actor, bearer] of [[fixture, ownerBearer], [invitee, adminBearer], [teammate, memberBearer]] as const) {
          const body = `${actor.name} group proof ${crypto.randomUUID()}`
          const sent = await api.post(teamPath, { headers: bearer, data: { body, idempotency_key: crypto.randomUUID() } })
          expect(sent.status, await sent.text()).toBe(200)
          const { message } = await sent.json() as { message: ConversationMessage }
          expect(message).toMatchObject({ sequence: expect.any(Number), body, author_user_id: actor.id })
          messageIds.push(message.id)
          bodies.push(body)
          await expect(page.locator(`[data-team-message="${message.id}"]`)).toContainText(body)
        }
        await page.screenshot({ path: testInfo.outputPath('team-group-conversation.png'), fullPage: true })
        const mcpRead = await mcpRequest(memberMcp, baseURL!, { method: 'tools/call', toolName: 'get_conversation', args: { organization_id: organization.id, conversation_id: threadId } })
        expect(mcpRead.status(), await mcpRead.text()).toBe(200)
        expect(mcpData<ConversationPage>(await mcpRead.json()).entries.filter(entry => entry.type === 'message').map(message => message.id).sort()).toEqual([...messageIds].sort())
        await memberPage.goto(`${groupPath}?kind=team`)
        await waitForNuxtHydration(memberPage)
        await dismissPreviewToolbar(memberPage)
        await expect(memberPage.locator(`[data-team-message="${messageIds[2]}"]`)).toContainText(bodies[2]!)

        const deniedRename = await api.post(`${operations}?org=${slug}`, { headers: memberBearer, data: { action: 'rename', name: 'Unpermitted', idempotency_key: crypto.randomUUID() } })
        expect(deniedRename.status, await deniedRename.text()).toBe(403)
        expect((await threads(adminBearer)).find(thread => thread.id === threadId)?.name).toBe(initialName)
        for (const headers of [outsiderBearer, buyerBearer]) {
          expect((await api.get(teamPath, { headers })).status).toBe(404)
          expect((await api.post(teamPath, { headers, data: { body: 'Outside', idempotency_key: crypto.randomUUID() } })).status).toBe(404)
          expect((await api.post(`${operations}?org=${slug}`, { headers, data: { action: 'rename', name: 'Outside', idempotency_key: crypto.randomUUID() } })).status).toBe(404)
        }

        await page.getByLabel('In this conversation', { exact: true }).click()
        const panel = page.getByRole('dialog', { name: 'In this conversation', exact: true })
        const renamed = `Named group ${slug}`
        await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(renamed)
        await page.getByRole('button', { name: 'Save name', exact: true }).click()
        await expect.poll(async () => (await threads(memberBearer)).find(thread => thread.id === threadId)?.name).toBe(renamed)
        const memberManagement = await api.post(`${operations}?org=${slug}`, { headers: memberBearer, data: { action: 'remove', user_id: invitee.id, idempotency_key: crypto.randomUUID() } })
        expect(memberManagement.status, await memberManagement.text()).toBe(403)

        await page.getByRole('button', { name: `Remove ${teammate.name}`, exact: true }).click()
        const removed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === operations)
        await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
        const removedResponse = await removed
        expect(removedResponse.status(), await removedResponse.text()).toBe(200)
        expect(await removedResponse.json()).toEqual({ status: 'updated', conversation_id: threadId })
        expect((await threads(adminBearer)).find(thread => thread.id === threadId)?.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id].sort())
        expect((await history(adminBearer)).map(message => message.id).sort()).toEqual([...messageIds].sort())
        // Revocation reaches an already-open browser; a stale transcript is not retained.
        await expect(memberPage.locator('[data-team-message]')).toHaveCount(0)
        await expect(memberPage.locator(`[data-thread-row="${threadId}"]`)).toHaveCount(0)
        expect((await api.get(teamPath, { headers: memberBearer })).status).toBe(404)
        expect((await api.post(teamPath, { headers: memberBearer, data: { body: 'No seat', idempotency_key: crypto.randomUUID() } })).status).toBe(404)

        await panel.getByRole('button', { name: 'Add people', exact: true }).click()
        await panel.getByRole('checkbox', { name: teammate.name, exact: true }).check()
        await panel.getByRole('button', { name: 'Add', exact: true }).click()
        await expect.poll(async () => (await threads(adminBearer)).find(thread => thread.id === threadId)?.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id, teammate.id].sort())
        expect((await history(memberBearer)).map(message => message.id).sort()).toEqual([...messageIds].sort())
        await memberPage.goto(`${groupPath}?kind=team`)
        await waitForNuxtHydration(memberPage)
        await expect(memberPage.locator(`[data-team-message="${messageIds[0]}"]`)).toContainText(bodies[0]!)
        await memberPage.getByLabel('In this conversation', { exact: true }).click()
        await expect(memberPage.getByRole('textbox', { name: 'Conversation name', exact: true })).toHaveCount(0)
        await memberPage.getByRole('button', { name: 'Leave conversation', exact: true }).click()
        const left = memberPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === operations)
        await memberPage.getByRole('dialog', { name: 'In this conversation' }).getByRole('button', { name: 'Leave conversation', exact: true }).click()
        const leftResponse = await left
        expect(leftResponse.status(), await leftResponse.text()).toBe(200)
        expect(await leftResponse.json()).toEqual({ status: 'left', conversation_id: threadId })
        expect((await threads(ownerBearer)).find(thread => thread.id === threadId)?.participants.map(person => person.id).sort()).toEqual([fixture.id, invitee.id].sort())
        expect((await api.get(teamPath, { headers: memberBearer })).status).toBe(404)
        expect((await api.post(teamPath, { headers: memberBearer, data: { body: 'After leaving', idempotency_key: crypto.randomUUID() } })).status).toBe(404)

        // The participating admin can manage; an owner's role cannot replace a lost seat.
        const adminRename = await mcpRequest(memberMcp, baseURL!, { method: 'tools/call', toolName: 'update_conversation_group', args: { organization_id: organization.id, conversation_id: threadId, action: 'rename', name: 'Admin handover', idempotency_key: crypto.randomUUID() } })
        expect(adminRename.status(), await adminRename.text()).toBe(200)
        expect(mcpData<{ status: 'updated'; conversation_id: string }>(await adminRename.json())).toEqual({ status: 'updated', conversation_id: threadId })
        expect((await threads(ownerBearer)).find(thread => thread.id === threadId)?.name).toBe('Admin handover')
        await expect(page.getByRole('button', { name: `Remove ${invitee.name}`, exact: true })).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath('team-group-details-after-membership-changes.png'), fullPage: true })
        const ownerLeft = await api.post(`${operations}?org=${slug}`, { headers: ownerBearer, data: { action: 'leave', idempotency_key: crypto.randomUUID() } })
        expect(ownerLeft.status, await ownerLeft.text()).toBe(200)
        expect(await ownerLeft.json()).toEqual({ status: 'left', conversation_id: threadId })
        expect((await api.get(teamPath, { headers: ownerBearer })).status).toBe(404)
        expect((await api.post(teamPath, { headers: ownerBearer, data: { body: 'Owner bypass', idempotency_key: crypto.randomUUID() } })).status).toBe(404)
        expect((await api.post(`${operations}?org=${slug}`, { headers: ownerBearer, data: { action: 'rename', name: 'Owner bypass', idempotency_key: crypto.randomUUID() } })).status).toBe(404)
        expect((await history(adminBearer)).map(message => message.id).sort()).toEqual([...messageIds].sort())

        // A direct conversation keeps its existing protected addressing and has no group controls.
        const direct = await api.post(teamListPath, { headers: adminBearer, data: { member_user_ids: [fixture.id] } })
        expect(direct.status, await direct.text()).toBe(201)
        const { conversation_id: directId } = await direct.json() as { conversation_id: string }
        expect((await threads(ownerBearer, directId)).find(thread => thread.id === directId)).toMatchObject({ name: null, is_group: false, capabilities: { can_manage_participants: false, can_leave: false } })
        const protectedDirect = await api.post(`/api/dashboard/team/threads/${directId}/operations?org=${slug}`, { headers: ownerBearer, data: { action: 'leave', idempotency_key: crypto.randomUUID() } })
        expect(protectedDirect.status, await protectedDirect.text()).toBe(409)
        expect(await protectedDirect.json()).toMatchObject({ data: { code: 'TEAM_GROUP_PROTECTED', field: 'conversation_id' } })
        await page.goto(`${listPath}/${directId}?kind=team`)
        await waitForNuxtHydration(page)
        await page.getByLabel('In this conversation', { exact: true }).click()
        await expect(panel).toBeVisible()
        await expect(panel.getByRole('button', { name: 'Leave conversation', exact: true })).toHaveCount(0)
        await expect(panel.getByRole('textbox', { name: 'Conversation name', exact: true })).toHaveCount(0)
        await loginAs(memberContext.request, baseURL!, buyer.id)
        await memberPage.goto('/dashboard/account/messages')
        await waitForNuxtHydration(memberPage)
        await expect(memberPage.getByRole('link', { name: 'New conversation', exact: true })).toHaveCount(0)
      } finally {
        try {
          const deleted = await api.post('/api/auth/organization/delete', { headers: ownerBearer, data: { organizationId: organization.id } })
          expect(deleted.status, await deleted.text()).toBe(200)
        } finally { await Promise.all([memberContext.close(), memberMcp.dispose()]) }
      }
    })
  }

  test('an experience host manages a business-scheduled booking without a booked individual and loses access when removed', async ({ baseURL, page, browser, request }) => {
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
      const provisioned = await api.post('/api/organizations', { headers: ownerBearer, data: { organization_id: organization.id, name, subdomain: slug, vertical: 'experience', source_locale: 'en' } })
      expect(provisioned.status, await provisioned.text()).toBe(200)
      const offered = await api.post('/api/auth/organization/invite-member', {
        headers: ownerBearer, data: { organizationId: organization.id, email: invitee.email, role: 'member' },
      })
      expect(offered.status, await offered.text()).toBe(200)
      const { id: invitationId } = await offered.json() as { id: string }
      const accepted = await api.post('/api/auth/organization/accept-invitation', { headers: memberBearer, data: { invitationId } })
      expect(accepted.status, await accepted.text()).toBe(200)
      const { member: { id: memberId } } = await accepted.json() as { member: { id: string } }
      const profile = await api.put(`/api/organizations/${organization.id}/members/${memberId}/scheduling`, { headers: ownerBearer, data: { updated_at: null, public_name: 'Experience guide', public_bio: 'Leads the local experience.', public_approved: true } })
      expect(profile.status, await profile.text()).toBe(200)
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
      const listedMembers = await api.get(`/api/auth/organization/list-members?organizationId=${encodeURIComponent(organization.id)}`, { headers: ownerBearer })
      expect(listedMembers.status, await listedMembers.text()).toBe(200)
      const ownerMemberId = (await listedMembers.json() as { members: Array<{ id: string; role: string }> }).members.find(member => member.role === 'owner')!.id
      // Every bookable offering has the member who handles its bookings: the owner, until the guide takes it.
      const configured = await api.put(`${editor}/products/${product.id}/booking`, { headers: ownerBearer, data: { duration_minutes: 60, default_capacity: 4, scheduling_mode: 'business', assigned_member_id: ownerMemberId, confirmation_mode: 'review', online_payment_required: false } })
      expect(configured.status, await configured.text()).toBe(200)
      await loginAs(page.request, baseURL!, fixture.id)
      await page.goto(`/dashboard/${slug}/products/${product.id}/booking/assignment`)
      const assignment = page.locator('#dashboard-panel-booking-assignment')
      await assignment.getByRole('radio', { name: 'Experience guide Profile published', exact: true }).check()
      await expect(assignment.getByRole('switch', { name: 'Book the host\'s working hours', exact: true })).not.toBeChecked()
      const assigned = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `${editor}/products/${product.id}/booking`)
      await assignment.getByRole('button', { name: 'Save', exact: true }).click()
      const assignedResponse = await assigned
      expect(assignedResponse.status(), await assignedResponse.text()).toBe(200)
      expect(assignedResponse.request().postDataJSON()).toEqual({ scheduling_mode: 'business', assigned_member_id: memberId })
      const productRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: organization.id, product_id: product.id } })
      expect(productRead.status(), await productRead.text()).toBe(200)
      expect(mcpData<{ product: Product }>(await productRead.json()).product.booking).toMatchObject({ scheduling_mode: 'business', assigned_member_id: memberId })
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
      const booked = await request.post(`/api/public/products/${product.slug}/book`, { headers: { 'x-preview-tenant': slug }, data: { product_session_id: sessions[0]!.id, product_variant_id: product.variants[0]!.id, party_size: 1, guest_name: guestName, guest_email: `${slug}@playwright.example`, idempotency_key: crypto.randomUUID() } })
      expect(booked.status(), await booked.text()).toBe(201)
      const { conversation_id: requestId, booking_id: bookingId } = await booked.json() as { conversation_id: string; booking_id: string }
      const bookingPath = `/api/dashboard/bookings/${bookingId}?org=${slug}`
      const inboxPath = `/api/messages/${requestId}`
      const memberBooking = await api.get(bookingPath, { headers: memberBearer })
      expect(memberBooking.status, await memberBooking.text()).toBe(200)
      expect(await memberBooking.json()).toMatchObject({ booking: { conversation_id: requestId, assigned_member_id: memberId, product_id: product.id, guest_name: guestName } })
      expect((await api.get(inboxPath, { headers: memberBearer })).status).toBe(404)
      const removed = await api.put(`${editor}/products/${product.id}/booking`, { headers: ownerBearer, data: { assigned_member_id: ownerMemberId } })
      expect(removed.status, await removed.text()).toBe(200)
      expect((await api.get(bookingPath, { headers: memberBearer })).status).toBe(404)
      expect((await api.get(inboxPath, { headers: memberBearer })).status).toBe(404)
      const retained = await api.get(bookingPath, { headers: ownerBearer })
      expect(retained.status, await retained.text()).toBe(200)
      expect(await retained.json()).toMatchObject({ booking: { conversation_id: requestId, assigned_member_id: ownerMemberId, product_id: product.id, guest_name: guestName } })
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
      data: { organization_id: organization.id, name, subdomain: slug, vertical: 'lodging', source_locale: 'en' },
    })
    expect(provisioned.status, await provisioned.text()).toBe(200)
    expect(await provisioned.json()).toMatchObject({ organization_id: organization.id, subdomain: slug })

    // The public site, read through the tenant host rather than the API that wrote it.
    const home = await api.get('/', { headers: { 'x-preview-tenant': slug } })
    expect(home.status).toBe(200)
    expect(await home.text()).toContain(name)
    // A lodging site takes no table reservations.
    expect((await api.get('/reservations', { headers: { 'x-preview-tenant': slug } })).status).toBe(404)

    // Everything it holds lives in KrabiClaw, so its owner deletes it outright.
    const deleted = await api.post('/api/auth/organization/delete', { headers: bearer, data: { organizationId: organization.id } })
    expect(deleted.status, await deleted.text()).toBe(200)
    const remaining = await api.get('/api/auth/organization/list', { headers: bearer })
    expect(remaining.status, await remaining.text()).toBe(200)
    expect((await remaining.json() as Array<{ id: string }>).map(row => row.id)).not.toContain(organization.id)
  })
})
