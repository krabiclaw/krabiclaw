import { expect, test, type APIRequestContext, type Request } from '@playwright/test'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import type { InboxRow } from '../../server/domain/guest-threads/types'
import type { BusinessToday } from '../../shared/dashboard-today'
import { openTenantPage } from './helpers'
import { acceptOrganizationInvitation, authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'
import { bookTable, openSeating } from './helpers/tables'

import type { ConversationPage } from '../../shared/messages-contract'

type WorkspaceInbox = { threads: InboxRow[]; has_unread: boolean }

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

test('a new booking, its cancellation and a guest message are unread until read, and one count says so everywhere', async ({ browser, playwright }, testInfo) => {
  test.setTimeout(60_000)
  const restaurant = seededTenant('restaurant')
  const baseURL = testBaseUrl()
  const unlock = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
  const owner = await playwright.request.newContext({ baseURL })
  const guest = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const conversations = '/api/messages'
  const organization_id = restaurant.organizationId
  // The one unread statement: the Current list's unread rows, and the dot that says whether there are any.
  const unread = async (request: APIRequestContext = owner) => {
    const response = await request.get(conversations, { params: { organization_id, limit: 100, mailbox: 'current' } })
    expect(response.status(), await response.text()).toBe(200)
    const inbox = await response.json() as WorkspaceInbox
    const rows = inbox.threads.filter(thread => thread.unread).length
    expect(inbox.has_unread).toBe(rows > 0)
    return rows
  }
  // The row as the list draws it: read back through a different path than the one that moved it.
  const row = async (id: string) => {
    const response = await owner.get(conversations, { params: { organization_id, limit: 100, mailbox: 'current' } })
    expect(response.status(), await response.text()).toBe(200)
    const found = (await response.json() as WorkspaceInbox).threads.find(thread => thread.id === id)
    expect(found, `Conversation ${id} is in the current list`).toBeDefined()
    return found!
  }
  const detail = async (id: string) => {
    const response = await owner.get(`/api/messages/${id}`)
    expect(response.status(), await response.text()).toBe(200)
    return await response.json() as ConversationPage
  }
  const newestShown = (thread: ConversationPage) => thread.entries.findLast(item => item.type !== 'day')!.id
  const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
  try {
    const before = await unread()
    const tenantHeaders = seededSiteHeaders('restaurant')
    const seating = await openSeating(owner, 2, 2 * 86_400_000)
    const { requestId: reservationId, cancellationToken } = await bookTable(guest, { name: 'Unread schedule proof', email: `unread-schedule-${Date.now()}@playwright.example`, phone: '+61491570007', partySize: 2, seating })

    // The booking's opening message is Blawby's, so it is unread for the team until opened.
    expect(await unread()).toBe(before + 1)
    expect(await row(reservationId)).toMatchObject({ unread: true })
    // Reading the conversation writes nothing: it stays unread until the reader says how far they read.
    const opening = await detail(reservationId)
    expect(await unread()).toBe(before + 1)
    const read = await owner.post(`${conversations}/${reservationId}/read`, { headers: authRequestHeaders(baseURL), data: { message_id: newestShown(opening) } })
    expect(read.status(), await read.text()).toBe(200)
    expect(await read.json()).toEqual({ read: true, last_read_message_id: newestShown(opening) })
    expect(await row(reservationId)).toMatchObject({ unread: false })
    expect(await unread()).toBe(before)

    // The guest cancels: Blawby's cancellation message is news, so the conversation is unread again.
    const cancelled = await guest.post(`/api/public/booking-requests/${reservationId}/cancel`, {
      headers: { ...tenantHeaders, authorization: `Bearer ${cancellationToken}` },
    })
    expect(cancelled.status(), await cancelled.text()).toBe(200)
    expect(await row(reservationId)).toMatchObject({ unread: true })
    expect(await unread()).toBe(before + 1)

    // Opening it on the dashboard reads it through to what the screen shows.
    const page = await dashboard.newPage()
    const readOnOpen = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${conversations}/${reservationId}/read`)
    await openTenantPage(page, `${baseURL}/dashboard/${restaurant.slug}/messages/${encodeURIComponent(reservationId)}`, {})
    expect((await readOnOpen).status()).toBe(200)
    await expect(page.getByText('Unread schedule proof').first()).toBeVisible()
    await expect(page.locator(`[data-thread-row="${reservationId}"]`)).toBeVisible()
    await expect.poll(async () => (await row(reservationId)).unread).toBe(false)
    expect(await unread()).toBe(before)

    const preview = 'Is the patio open on Sunday evenings?'
    const inboxUpdate = page.waitForResponse(async response => {
      const url = new URL(response.url())
      if (!response.ok() || response.request().method() !== 'GET' || url.pathname !== conversations || !url.searchParams.has('ids')) return false
      return ((await response.json()) as WorkspaceInbox).threads.some(thread => thread.preview === preview)
    })
    const submitted = await guest.post('/api/public/contact', {
      headers: tenantHeaders,
      data: { name: 'Unread badge proof', email: `unread-badge-${Date.now()}@playwright.example`, message: preview },
    })
    expect(submitted.status(), await submitted.text()).toBe(201)
    const threadId = (await submitted.json() as { conversation_id: string }).conversation_id
    await inboxUpdate
    const listRow = page.locator(`[data-thread-row="${threadId}"]`)
    await expect(listRow).toContainText(preview)

    // Counted once, and Messages on the dashboard shows the same number.
    const arrived = await unread()
    expect(arrived).toBe(before + 1)
    expect(await row(threadId)).toMatchObject({ unread: true, preview })
    for (const range of ['today', 'upcoming']) {
      const feed = await owner.get('/api/dashboard/today', { params: { org: restaurant.slug, range } })
      expect(feed.status(), await feed.text()).toBe(200)
      const { cards } = await feed.json() as BusinessToday
      expect(cards.filter(card => card.to.endsWith(`/messages/${threadId}`))).toEqual([])
    }
    const dashboardNav = page.getByTestId('dashboard-top-nav')
    const calendar = dashboardNav.getByRole('link', { name: 'Calendar', exact: true })
    const messages = dashboardNav.getByRole('link', { name: 'Messages', exact: true })
    const leaveInbox = async () => {
      await calendar.click()
      await expect(page).toHaveURL(new RegExp(`/dashboard/${restaurant.slug}/calendar(?:/|$)`))
      await expect(listRow).toHaveCount(0)
    }
    await leaveInbox()
    await expect(page.getByTestId('dashboard-nav-unread')).toBeVisible()

    // A return on the same socket uses the latest rows, including the scoped update.
    const firstPageUrl = (url: URL) => url.pathname === conversations
      && url.searchParams.get('organization_id') === organization_id
      && url.searchParams.get('mailbox') === 'current'
      && url.searchParams.get('offset') === '0'
      && !url.searchParams.has('ids')
    let listReads = 0
    const countFullList = (request: Request) => {
      if (request.method() === 'GET' && firstPageUrl(new URL(request.url()))) listReads++
    }
    const waitForRead = () => page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${conversations}/${threadId}/read`)
    const readContact = waitForRead()
    page.on('request', countFullList)
    try {
      await messages.click()
      const retainedPreview = listRow.getByText(preview, { exact: false })
      await expect.poll(async () => {
        if (!await retainedPreview.isVisible()) return false
        return retainedPreview.evaluate(element => {
          for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
            if (Number(getComputedStyle(ancestor).opacity) < 0.95) return false
          }
          return true
        })
      }, { timeout: 3500 }).toBe(true)
      // The desktop inbox opens its newest conversation and acknowledges the messages shown.
      await expect.soft(listRow).toHaveAttribute('aria-current', 'page', { timeout: 1500 })
      if (await listRow.getAttribute('aria-current') !== 'page') await listRow.click()
      expect((await readContact).status()).toBe(200)
      expect.soft(listReads).toBe(0)
    } finally {
      page.off('request', countFullList)
    }
    await expect.poll(async () => await unread()).toBe(before)

    // From the Messages list: the row's envelope marks it unread, and its menu marks it read
    // again. Each is read back through the count Messages uses.
    await expect(listRow).toBeVisible()
    await expect(listRow.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    await listRow.hover()
    await listRow.locator('xpath=../..').getByRole('button', { name: 'Mark as unread: Unread badge proof', exact: true }).click()
    await expect(listRow.getByLabel('Unread badge proof: unread')).toBeVisible()
    await expect.poll(async () => await unread()).toBe(before + 1)
    expect(await row(threadId)).toMatchObject({ unread: true })
    await listRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark as read' }).click()
    await expect(listRow.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    await expect.poll(async () => await unread()).toBe(before)
    expect(await row(threadId)).toMatchObject({ unread: false })

    // A reader-scoped update while the list is closed invalidates the saved rows.
    await leaveInbox()
    const changed = await owner.post(`${conversations}/${threadId}/unread`, { headers: authRequestHeaders(baseURL) })
    expect(changed.status(), await changed.text()).toBe(200)
    await expect(page.getByTestId('dashboard-nav-unread')).toBeVisible()
    const refreshedList = page.waitForResponse(response => response.request().method() === 'GET' && firstPageUrl(new URL(response.url())))
    const readAfterChange = waitForRead()
    await messages.click()
    const refreshed = await refreshedList
    expect(refreshed.status(), await refreshed.text()).toBe(200)
    expect(await refreshed.json()).toMatchObject({ has_unread: true })
    if (await listRow.getAttribute('aria-current') !== 'page') await listRow.click()
    expect((await readAfterChange).status()).toBe(200)
    await expect(listRow.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    expect(await row(threadId)).toMatchObject({ unread: false })

    // An unconfirmed row toggle must never be retained across navigation.
    const unreadPath = `${conversations}/${threadId}/unread`
    const rejectedToggle = Promise.withResolvers<undefined>()
    await page.route(url => url.pathname === unreadPath, async route => {
      await rejectedToggle.promise
      await route.fulfill({ status: 409, json: { message: 'Read state was not changed' } })
    }, { times: 1 })
    try {
      await listRow.hover()
      await listRow.locator('xpath=../..').getByRole('button', { name: 'Mark as unread: Unread badge proof', exact: true }).click()
      await expect(listRow.getByLabel('Unread badge proof: unread')).toBeVisible()
      await leaveInbox()
      const snapshot = page.waitForResponse(response => response.request().method() === 'GET' && firstPageUrl(new URL(response.url())))
      await messages.click()
      const current = await snapshot
      expect(current.status()).toBe(200)
      await expect(listRow).toBeVisible()
      await expect(listRow.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    } finally {
      rejectedToggle.resolve(undefined)
    }
  } finally {
    await dashboard.close()
    await owner.dispose()
    await guest.dispose()
    await unlock()
  }
})
