import { expect, test, type APIRequestContext, type Request } from '@playwright/test'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import type { InboxRow, InboxThread } from '../../server/domain/guest-threads/types'
import { openTenantPage } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'
import { bookTable, openSeating } from './helpers/tables'

type ConversationPage = { threads: InboxRow[]; unread: { all: number; guests: number; support: number; team: number } }

test('a saved workspace inbox is discarded when the reader loses access', async ({ browser, playwright, baseURL }) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Uses an isolated local workspace')
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
    const invitation = await owner.post('/api/auth/organization/invite-member', {
      headers, data: { organizationId, email: fixture.email, role: 'member' },
    })
    expect(invitation.status(), await invitation.text()).toBe(200)
    const { id: invitationId } = await invitation.json() as { id: string }
    const joined = await reader.post('/api/auth/organization/accept-invitation', { headers, data: { invitationId } })
    expect(joined.status(), await joined.text()).toBe(200)
    const { member } = await joined.json() as { member: { id: string } }

    const team = '/api/dashboard/team/threads'
    const created = await owner.post(team, { params: { org: slug }, headers, data: { member_user_ids: [fixture.id] } })
    expect(created.status(), await created.text()).toBe(201)
    const { conversation_id: id } = await created.json() as { conversation_id: string }
    const preview = 'Preview visible only to the workspace member.'
    const sent = await owner.post(`${team}/${id}/messages`, { params: { org: slug }, headers, data: { body: preview, idempotency_key: crypto.randomUUID() } })
    expect(sent.status(), await sent.text()).toBe(201)
    const conversations = `/api/dashboard/organizations/${organizationId}/conversations`
    const page = await browser.newPage({ baseURL: origin, storageState: await reader.storageState(), viewport: { width: 1280, height: 900 } })
    try {
      const connected = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/api/dashboard/guest-inbox/socket' })
      await openTenantPage(page, `${origin}/dashboard/${slug}/messages/team/${id}`, {})
      const socket = await connected
      const row = page.locator(`[data-thread-row="${id}"]`)
      await expect(row).toContainText(preview)
      const nav = page.getByTestId('dashboard-top-nav')
      await nav.getByRole('link', { name: 'Calendar', exact: true }).click()
      await expect(row).toHaveCount(0)
      const closed = socket.waitForEvent('close')
      const revoked = await owner.post('/api/auth/organization/remove-member', { headers, data: { organizationId, memberIdOrEmail: member.id } })
      expect(revoked.status(), await revoked.text()).toBe(200)
      await closed

      const isInbox = (url: URL) => url.pathname === conversations && url.searchParams.get('offset') === '0'
      const releaseDenied = Promise.withResolvers<undefined>()
      await page.route(isInbox, async route => {
        await releaseDenied.promise
        await route.continue()
      }, { times: 1 })
      try {
        const request = page.waitForRequest(item => item.method() === 'GET' && isInbox(new URL(item.url())))
        await nav.getByRole('link', { name: 'Messages', exact: true }).click()
        await request
        await expect(row).toHaveCount(0)
        const denied = page.waitForResponse(response => response.request().method() === 'GET' && isInbox(new URL(response.url())))
        releaseDenied.resolve(undefined)
        expect((await denied).status()).toBe(404)
        await expect(row).toHaveCount(0)
      } finally {
        releaseDenied.resolve(undefined)
      }
    } finally {
      await page.close()
    }
    const retained = await owner.get(conversations)
    expect(retained.status(), await retained.text()).toBe(200)
    expect(await retained.json()).toMatchObject({ threads: [{ id, preview }] })
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
  const conversations = `/api/dashboard/organizations/${restaurant.organizationId}/conversations`
  // The one unread statement: the list's counts, which Messages' badge reads too.
  const unread = async (request: APIRequestContext = owner) => {
    const response = await request.get(conversations, { params: { limit: 1, mailbox: 'current' } })
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as ConversationPage).unread.all
  }
  // The row as the list draws it: read back through a different path than the one that moved it.
  const row = async (id: string) => {
    const response = await owner.get(conversations, { params: { limit: 100, mailbox: 'current' } })
    expect(response.status(), await response.text()).toBe(200)
    const found = (await response.json() as ConversationPage).threads.find(thread => thread.id === id)
    expect(found, `Conversation ${id} is in the current list`).toBeDefined()
    return found!
  }
  const detail = async (id: string) => {
    const response = await owner.get(`/api/dashboard/organizations/${restaurant.organizationId}/guest-threads/${id}`)
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { thread: InboxThread }).thread
  }
  const newestShown = (thread: InboxThread) => thread.stream.filter(item => item.type !== 'day').at(-1)!.id
  const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
  try {
    const before = await unread()
    const tenantHeaders = seededSiteHeaders('restaurant')
    const seating = await openSeating(owner, 2, 2 * 86_400_000)
    const { requestId: reservationId, cancellationToken } = await bookTable(guest, { name: 'Unread schedule proof', email: `unread-schedule-${Date.now()}@playwright.example`, phone: '+61491570007', partySize: 2, seating })

    // The booking's opening message is KrabiClaw's, so it is unread for the team until opened.
    expect(await unread()).toBe(before + 1)
    expect(await row(reservationId)).toMatchObject({ unread: true })
    // Reading the conversation writes nothing: it stays unread until the reader says how far they read.
    const opening = await detail(reservationId)
    expect(await unread()).toBe(before + 1)
    const read = await owner.post(`${conversations}/${reservationId}/read`, { data: { message_id: newestShown(opening) } })
    expect(read.status(), await read.text()).toBe(200)
    expect(await read.json()).toEqual({ read: true, last_read_message_id: newestShown(opening) })
    expect(await row(reservationId)).toMatchObject({ unread: false })
    expect(await unread()).toBe(before)

    // The guest cancels: KrabiClaw's cancellation message is news, so the conversation is unread again.
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
    await expect.poll(async () => (await row(reservationId)).unread).toBe(false)
    expect(await unread()).toBe(before)

    const preview = 'Is the patio open on Sunday evenings?'
    const submitted = await guest.post('/api/public/contact', {
      headers: tenantHeaders,
      data: { name: 'Unread badge proof', email: `unread-badge-${Date.now()}@playwright.example`, message: preview },
    })
    expect(submitted.status(), await submitted.text()).toBe(201)
    const threadId = (await submitted.json() as { conversation_id: string }).conversation_id

    // Counted once, and Messages on the dashboard shows the same number.
    const arrived = await unread()
    expect(arrived).toBe(before + 1)
    const listRow = page.locator(`[data-thread-row="${threadId}"]`)
    await expect(listRow).toContainText(preview)
    const nav = page.getByTestId('dashboard-top-nav')
    const calendar = nav.getByRole('link', { name: 'Calendar', exact: true })
    const messages = nav.getByRole('link', { name: 'Messages', exact: true })
    await calendar.click()
    await expect(listRow).toHaveCount(0)
    await expect(page.getByTestId('dashboard-nav-unread')).toHaveText(arrived > 99 ? '99+' : String(arrived))

    // Measure only the inbox navigation. A real acknowledgement subsequently refreshes the row.
    const isInbox = (request: Request) => {
      const url = new URL(request.url())
      return request.method() === 'GET' && url.pathname === conversations && url.searchParams.get('offset') === '0'
    }
    const reads: Request[] = []
    const trackInbox = (request: Request) => { if (isInbox(request)) reads.push(request) }
    const readContact = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${conversations}/${threadId}/read`)
    page.on('request', trackInbox)
    const releaseRead = Promise.withResolvers<undefined>()
    await page.route(url => url.pathname === `${conversations}/${threadId}/read`, async route => {
      await releaseRead.promise
      await route.continue()
    }, { times: 1 })
    try {
      await messages.click()
      await expect(listRow).toContainText(preview)
      await expect(listRow).toHaveAttribute('aria-current', 'page')
      expect(reads).toHaveLength(0)
    } finally {
      page.off('request', trackInbox)
      releaseRead.resolve(undefined)
    }
    expect((await readContact).status()).toBe(200)
    await expect.poll(async () => await unread()).toBe(before)

    // From the Messages list: the row's envelope marks it unread, and its menu marks it read
    // again. Each is read back through the count Messages uses.
    await expect(listRow).toBeVisible()
    await expect(listRow.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    await listRow.hover()
    await page.getByRole('button', { name: 'Mark as unread: Unread badge proof' }).click()
    await expect(listRow.getByLabel('Unread badge proof: unread')).toBeVisible()
    await expect.poll(async () => await unread()).toBe(before + 1)
    expect(await row(threadId)).toMatchObject({ unread: true })
    await listRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark as read' }).click()
    await expect(listRow.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    await expect.poll(async () => await unread()).toBe(before)
    expect(await row(threadId)).toMatchObject({ unread: false })

    const refreshed = page.waitForResponse(response => isInbox(response.request()))
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    expect((await refreshed).status()).toBe(200)
    await expect(listRow).toContainText(preview)
  } finally {
    await dashboard.close()
    await owner.dispose()
    await guest.dispose()
    await unlock()
  }
})
