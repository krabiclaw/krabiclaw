import { expect, test, type APIRequestContext } from '@playwright/test'
import { openTenantPage } from './helpers'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'

type Unread = { unread_count: number; unread_conversations: number }

test('a new guest conversation is counted on Messages and the app badge until its reader opens it', async ({ browser, playwright }, testInfo) => {
  const restaurant = seededTenant('restaurant')
  const baseURL = testBaseUrl()
  const unlock = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const unread = async (request: APIRequestContext) => {
    const response = await request.get('/api/dashboard/notifications/unread-count', { params: { org: restaurant.slug } })
    expect(response.status(), await response.text()).toBe(200)
    return await response.json() as Unread
  }
  const badge = async () => {
    const response = await owner.get('/api/dashboard/notifications/badge')
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { badge: number }).badge
  }
  const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
  try {
    const before = await unread(owner)
    const badgeBefore = await badge()
    const submitted = await owner.post('/api/public/contact', {
      headers: seededSiteHeaders('restaurant'),
      data: { name: 'Unread badge proof', email: `unread-badge-${Date.now()}@playwright.example`, message: 'Is the patio open on Sunday evenings?' },
    })
    expect(submitted.status(), await submitted.text()).toBe(201)
    const threadId = (await submitted.json() as { request_id: string }).request_id

    // Counted once on Messages, and on the bell and the icon through its notification.
    const arrived = await unread(owner)
    expect(arrived.unread_conversations).toBe(before.unread_conversations + 1)
    expect(arrived.unread_count).toBeGreaterThan(before.unread_count)
    // The icon spans every workspace this owner belongs to; only this one is locked, so it is at least this one's change.
    const arrivedBadge = await badge()
    expect(arrivedBadge).toBeGreaterThanOrEqual(badgeBefore + (arrived.unread_count - before.unread_count))

    // The dashboard shows the same count on Messages and marks the Menu.
    const page = await dashboard.newPage()
    await openTenantPage(page, `${baseURL}/dashboard/${restaurant.slug}`, {})
    await expect(page.getByTestId('dashboard-nav-unread')).toHaveText(String(arrived.unread_conversations))
    await expect(page.getByTestId('dashboard-top-nav-menu-button').getByTestId('dashboard-menu-unread')).toBeVisible()

    // Opening the conversation reads it: Messages and the icon drop by what it carried.
    const opened = await owner.get(`/api/dashboard/organizations/${restaurant.organizationId}/guest-threads/${threadId}`)
    expect(opened.status(), await opened.text()).toBe(200)
    const read = await unread(owner)
    expect(read.unread_conversations).toBe(before.unread_conversations)
    expect(read.unread_count).toBeLessThan(arrived.unread_count)
    expect(await badge()).toBeLessThanOrEqual(arrivedBadge - (arrived.unread_count - read.unread_count))
  } finally {
    await dashboard.close()
    await owner.dispose()
    await unlock()
  }
})
