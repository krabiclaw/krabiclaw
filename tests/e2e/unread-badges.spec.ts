import { expect, test, type APIRequestContext } from '@playwright/test'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { openTenantPage } from './helpers'
import { acceptOrganizationInvitation, authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'

test('a signed-in reader sees an empty inbox until a message arrives and loses workspace inbox access when removed', async ({ browser, playwright, baseURL }) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates and removes an isolated local workspace')
  const origin = baseURL!
  const headers = authRequestHeaders(origin)
  const fixture = findE2eAuthFixture('user-e2e-demo-role-owner')
  const owner = await playwright.request.newContext({ baseURL: origin })
  const reader = await playwright.request.newContext({ baseURL: origin })
  const slug = `e2e-inbox-access-${crypto.randomUUID().slice(0, 8)}`
  let organizationId: string | undefined
  try {
    await loginAs(owner, origin)
    await loginAs(reader, origin, fixture.id)
    const workspace = await owner.post('/api/auth/organization/create', {
      headers, data: { name: slug, slug, default_currency: 'THB', timezone: 'Asia/Bangkok', keepCurrentActiveOrganization: true },
    })
    expect(workspace.status(), await workspace.text()).toBe(200)
    organizationId = (await workspace.json() as { id: string }).id
    const invitationId = await sendOrganizationInvitation(owner, origin, organizationId, fixture.email, 'member')
    const member = await acceptOrganizationInvitation(reader, origin, invitationId)
    const workspaceParams = { organization_id: organizationId }
    const inbox = (request: APIRequestContext) => request.get('/api/messages', { params: { ...workspaceParams, mailbox: 'current' } })
    const empty = await inbox(reader)
    expect(empty.status(), await empty.text()).toBe(200)
    expect(await empty.json()).toMatchObject({ threads: [], has_unread: false })

    const conversation = await owner.post('/api/dashboard/team/threads', { params: { org: slug }, headers, data: { member_user_ids: [fixture.id] } })
    expect(conversation.status(), await conversation.text()).toBe(201)
    const { conversation_id: conversationId } = await conversation.json() as { conversation_id: string }
    const message = 'The member can read this before removal.'
    const sent = await owner.post(`/api/messages/${conversationId}`, { headers, data: { body: message, idempotency_key: crypto.randomUUID() } })
    expect(sent.status(), await sent.text()).toBe(200)
    const seeded = await inbox(reader)
    expect(seeded.status(), await seeded.text()).toBe(200)
    expect(await seeded.json()).toMatchObject({ threads: [{ id: conversationId, preview: message, unread: true }], has_unread: true })
    const session = await reader.get('/api/auth/get-session')
    expect(session.status(), await session.text()).toBe(200)
    const { session: { id: sessionId } } = await session.json() as { session: { id: string } }

    const page = await browser.newPage({ baseURL: origin, storageState: await reader.storageState(), viewport: { width: 1280, height: 900 } })
    try {
      const socketReady = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/api/dashboard/guest-inbox/socket' })
      await openTenantPage(page, `${origin}/dashboard/${slug}/messages/${conversationId}`, {})
      const socket = await socketReady
      const listRow = page.locator(`[data-thread-row="${conversationId}"]`)
      await expect(listRow).toContainText(message)
      const nav = page.getByTestId('dashboard-top-nav')
      await nav.getByRole('link', { name: 'Calendar', exact: true }).click()
      await expect(listRow).toHaveCount(0)
      const closed = socket.waitForEvent('close')
      const revoked = await owner.post('/api/auth/organization/remove-member', { headers, data: { organizationId, memberIdOrEmail: member.id } })
      expect(revoked.status(), await revoked.text()).toBe(200)
      await closed

      const listUrl = (url: URL) => url.pathname === '/api/messages' && url.searchParams.get('organization_id') === organizationId
      const releaseDenied = Promise.withResolvers<undefined>()
      await page.route(listUrl, async route => {
        await releaseDenied.promise
        await route.continue()
      }, { times: 1 })
      try {
        const pending = page.waitForRequest(request => request.method() === 'GET' && listUrl(new URL(request.url())))
        await nav.getByRole('link', { name: 'Messages', exact: true }).click()
        await pending
        await expect.soft(listRow).toHaveCount(0, { timeout: 1500 })
        const denied = page.waitForResponse(response => response.request().method() === 'GET' && listUrl(new URL(response.url())))
        releaseDenied.resolve(undefined)
        expect((await denied).status()).toBe(404)
        await expect(listRow).toHaveCount(0)
      } finally {
        releaseDenied.resolve(undefined)
      }
    } finally {
      await page.close()
    }
    const removed = await inbox(reader)
    expect(removed.status(), await removed.text()).toBe(404)
    expect(await removed.json()).toMatchObject({ data: { code: 'ORGANIZATION_NOT_FOUND', field: 'organizationId' } })
    const stillSignedIn = await reader.get('/api/auth/get-session')
    expect(stillSignedIn.status(), await stillSignedIn.text()).toBe(200)
    expect(await stillSignedIn.json()).toMatchObject({ session: { id: sessionId }, user: { id: fixture.id } })
    const retained = await inbox(owner)
    expect(retained.status(), await retained.text()).toBe(200)
    expect(await retained.json()).toMatchObject({ threads: [{ id: conversationId, preview: message }] })
    const ownerPage = await browser.newPage({ baseURL: origin, storageState: await owner.storageState() })
    try {
      const connected = ownerPage.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/api/dashboard/guest-inbox/socket' })
      await ownerPage.goto(`/dashboard/${slug}/messages/${conversationId}`)
      const ownerSocket = await connected
      const ownerRow = ownerPage.locator(`[data-thread-row="${conversationId}"]`)
      await expect(ownerRow).toContainText(message)
      const disconnected = ownerSocket.waitForEvent('close')
      const deleted = await owner.post('/api/auth/organization/delete', { headers, data: { organizationId } })
      expect(deleted.status(), await deleted.text()).toBe(200)
      organizationId = undefined
      await disconnected
      await expect(ownerRow).toHaveCount(0)
    } finally {
      await ownerPage.close()
    }
  } finally {
    try {
      if (organizationId) {
        const deleted = await owner.post('/api/auth/organization/delete', { headers, data: { organizationId } })
        expect(deleted.status(), await deleted.text()).toBe(200)
      }
    } finally {
      await Promise.all([owner.dispose(), reader.dispose()])
    }
  }
})
