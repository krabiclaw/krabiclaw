import { expect, test, type APIRequestContext } from '@playwright/test'
import type { InboxRow, InboxThread } from '../../server/domain/guest-threads/types'
import { openTenantPage } from './helpers'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'
import { bookTable, openSeating } from './helpers/tables'

type ConversationPage = { threads: InboxRow[]; unread: { all: number; guests: number; support: number; team: number } }

test('a new booking, its cancellation and a guest message are unread until read, and one count says so everywhere', async ({ browser, playwright }, testInfo) => {
  test.setTimeout(60_000)
  const restaurant = seededTenant('restaurant')
  const baseURL = testBaseUrl()
  const unlock = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
  const owner = await playwright.request.newContext({ baseURL })
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
    const { requestId: reservationId, cancellationToken } = await bookTable(owner, { name: 'Unread schedule proof', email: `unread-schedule-${Date.now()}@playwright.example`, phone: '+61491570007', partySize: 2, seating })

    // The booking's opening message is KrabiClaw's, so it is unread for the team until opened.
    expect(await unread()).toBe(before + 1)
    expect(await row(reservationId)).toMatchObject({ unread: true })
    // Reading the conversation writes nothing: it stays unread until the reader says how far they read.
    const opening = await detail(reservationId)
    expect(await unread()).toBe(before + 1)
    const read = await owner.post(`${conversations}/${reservationId}/read`, { data: { messageId: newestShown(opening) } })
    expect(read.status(), await read.text()).toBe(200)
    expect(await read.json()).toEqual({ read: true, lastReadMessageId: newestShown(opening) })
    expect(await row(reservationId)).toMatchObject({ unread: false })
    expect(await unread()).toBe(before)

    // The guest cancels: KrabiClaw's cancellation message is news, so the conversation is unread again.
    const cancelled = await owner.post(`/api/public/booking-requests/${reservationId}/cancel`, {
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

    const submitted = await owner.post('/api/public/contact', {
      headers: tenantHeaders,
      data: { name: 'Unread badge proof', email: `unread-badge-${Date.now()}@playwright.example`, message: 'Is the patio open on Sunday evenings?' },
    })
    expect(submitted.status(), await submitted.text()).toBe(201)
    const threadId = (await submitted.json() as { request_id: string }).request_id

    // Counted once, and Messages on the dashboard shows the same number.
    const arrived = await unread()
    expect(arrived).toBe(before + 1)
    await openTenantPage(page, `${baseURL}/dashboard/${restaurant.slug}/calendar`, {})
    await expect(page.getByTestId('dashboard-nav-unread')).toHaveText(arrived > 99 ? '99+' : String(arrived))

    // Opening the conversation reads it: the count drops by it.
    const readContact = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${conversations}/${threadId}/read`)
    await openTenantPage(page, `${baseURL}/dashboard/${restaurant.slug}/messages/${encodeURIComponent(threadId)}`, {})
    expect((await readContact).status()).toBe(200)
    await expect.poll(async () => await unread()).toBe(before)

    // From the Messages list: the row's envelope marks it unread, and its menu marks it read
    // again. Each is read back through the count Messages uses.
    const listRow = page.locator(`[data-thread-row="${threadId}"]`)
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
  } finally {
    await dashboard.close()
    await owner.dispose()
    await unlock()
  }
})
