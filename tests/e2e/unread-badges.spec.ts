import { expect, test, type APIRequestContext } from '@playwright/test'
import { openTenantPage } from './helpers'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'

type Unread = { unread_count: number; unread_conversations: number }

test('booking alerts open details while guest messages count on Messages until read', async ({ browser, playwright }, testInfo) => {
  test.setTimeout(60_000)
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
    const locationId = restaurant.locations.brooklyn.id
    const tenantHeaders = seededSiteHeaders('restaurant')
    const availability = await owner.get('/api/public/reservations/availability', {
      headers: tenantHeaders,
      params: { location_id: locationId, date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), days: 7 },
    })
    expect(availability.status(), await availability.text()).toBe(200)
    const calendar = await availability.json() as { dates: Array<{ date: string; slots: Array<{ time_slot: string; is_closed: boolean; is_full: boolean; remaining: number | null }> }> }
    const canBook = (slot: typeof calendar.dates[number]['slots'][number]) => !slot.is_closed && !slot.is_full && (slot.remaining === null || slot.remaining >= 2)
    const day = calendar.dates.find(day => day.slots.some(canBook))
    const slot = day?.slots.find(canBook)
    if (!day || !slot) throw new Error('The seeded restaurant has no available table for two')
    const reservation = await owner.post('/api/public/reservations', { headers: tenantHeaders, data: {
      name: 'Unread schedule proof', email: `unread-schedule-${Date.now()}@playwright.example`, phone: '+61491570007',
      date: day.date, time: slot.time_slot, guests: '2', location_id: locationId, idempotency_key: crypto.randomUUID(),
    } })
    expect(reservation.status(), await reservation.text()).toBe(201)
    const { id: reservationId, cancellationToken } = await reservation.json() as { id: string; cancellationToken: string }
    const destination = `/dashboard/${restaurant.slug}/bookings/reservation/${reservationId}`
    const scheduleAlert = async (template = 'new_reservation') => {
      const response = await owner.get('/api/dashboard/notifications', { params: { org: restaurant.slug } })
      expect(response.status(), await response.text()).toBe(200)
      const { notifications } = await response.json() as { notifications: Array<{ id: string; template: string; deep_link: string; read_at: string | null }> }
      const alert = notifications.find(notification => notification.template === template && notification.deep_link === destination)
      expect(alert, 'The reservation alert points to the actual booking').toBeDefined()
      return alert!
    }
    const schedule = await unread(owner)
    expect(schedule.unread_conversations).toBe(before.unread_conversations)
    expect(schedule.unread_count).toBe(before.unread_count + 1)
    const alert = await scheduleAlert()
    const openedReservationThread = await owner.get(`/api/dashboard/organizations/${restaurant.organizationId}/guest-threads/${reservationId}`)
    expect(openedReservationThread.status(), await openedReservationThread.text()).toBe(200)
    expect((await scheduleAlert()).read_at).toBeNull()
    const page = await dashboard.newPage()
    await openTenantPage(page, `${baseURL}/dashboard/${restaurant.slug}/notifications`, {})
    await page.getByTestId(`notification-${alert.id}`).click()
    await expect(page).toHaveURL(new RegExp(`${destination}$`))
    await expect(page.getByText('Unread schedule proof').first()).toBeVisible()
    await expect.poll(async () => (await scheduleAlert()).read_at).toEqual(expect.any(String))
    expect((await unread(owner)).unread_count).toBe(before.unread_count)

    const cancelled = await owner.post(`/api/public/booking-requests/${reservationId}/cancel`, {
      headers: { ...tenantHeaders, authorization: `Bearer ${cancellationToken}` },
    })
    expect(cancelled.status(), await cancelled.text()).toBe(200)
    expect((await scheduleAlert('reservation_cancelled')).read_at).toBeNull()
    expect((await unread(owner)).unread_conversations).toBe(before.unread_conversations)
    await page.reload()
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible()
    await expect.poll(async () => (await scheduleAlert('reservation_cancelled')).read_at).toEqual(expect.any(String))
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
    await openTenantPage(page, `${baseURL}/dashboard/${restaurant.slug}`, {})
    await expect(page.getByTestId('dashboard-nav-unread')).toHaveText(arrived.unread_conversations > 99 ? '99+' : String(arrived.unread_conversations))
    await expect(page.getByTestId('dashboard-top-nav-menu-button').getByTestId('dashboard-menu-unread')).toBeVisible()

    // Opening the conversation reads it: Messages and the icon drop by what it carried.
    const opened = await owner.get(`/api/dashboard/organizations/${restaurant.organizationId}/guest-threads/${threadId}`)
    expect(opened.status(), await opened.text()).toBe(200)
    const read = await unread(owner)
    expect(read.unread_conversations).toBe(before.unread_conversations)
    expect(read.unread_count).toBeLessThan(arrived.unread_count)
    expect(await badge()).toBeLessThanOrEqual(arrivedBadge - (arrived.unread_count - read.unread_count))

    // From the Messages list: the row's envelope marks it unread, and its menu marks it read
    // again. Each is read back through the count Messages and the icon use. The conversation is
    // open beside the list (as the wide list opens its newest), so opening adds no read of its own.
    await openTenantPage(page, `${baseURL}/dashboard/${restaurant.slug}/messages/${encodeURIComponent(threadId)}`, {})
    const row = page.locator(`[data-thread-row="${threadId}"]`)
    await expect(row).toBeVisible()
    await expect(row.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    await row.hover()
    await page.getByRole('button', { name: 'Mark as unread: Unread badge proof' }).click()
    await expect(row.getByLabel('Unread badge proof: unread')).toBeVisible()
    await expect.poll(async () => (await unread(owner)).unread_conversations).toBe(before.unread_conversations + 1)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark as read' }).click()
    await expect(row.getByLabel('Unread badge proof: unread')).toHaveCount(0)
    await expect.poll(async () => (await unread(owner)).unread_conversations).toBe(before.unread_conversations)
  } finally {
    await dashboard.close()
    await owner.dispose()
    await unlock()
  }
})
