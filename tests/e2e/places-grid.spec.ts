import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { testBaseUrl } from './test-env'
import type { PlaceDay } from '../../server/domain/places'

// Calendar → Places: every restaurant location, experience and consultation as
// a row, days as columns, on the one grid the Homes view renders. A write from
// the panel is read back through the place's own record, never the grid.
const baseURL = testBaseUrl()
const writable = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)

function localDay(timeZone: string, offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}
const next = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

interface Calendar { manage: boolean; places: Array<{ place: { kind: string; id: string; name: string; detail: string; provider: { member_id: string; name: string } | null }; days: PlaceDay[] }> }
async function readCalendar(request: APIRequestContext, slug: string, from: string, to: string): Promise<Calendar> {
  const response = await request.get(`${baseURL}/api/dashboard/places/calendar?org=${encodeURIComponent(slug)}&from=${from}&to=${to}`)
  expect(response.status(), await response.text()).toBe(200)
  return await response.json() as Calendar
}
const cell = (page: Page, placeKey: string, date: string) => page.getByTestId('places-grid').locator(`div[role="rowheader"]:has([data-place="${placeKey}"]) + div [data-night="${date}"]`)

test('a restaurant blocks the same weekdays at two locations from the places grid, and the day leaf reads the closure', async ({ page }, testInfo) => {
  test.skip(!writable, 'Blocks dates; requires isolated local D1')
  const restaurant = seededTenant('restaurant')
  const brooklyn = restaurant.locations.brooklyn!
  const williamsburg = restaurant.locations.williamsburg!
  const pizza = restaurant.products['pizza-class'] ?? Object.values(restaurant.products).find(product => product.kind === 'experience')
  expect(pizza, 'Ember & Slice seeds a pizza class').toBeTruthy()
  const from = localDay(restaurant.timezone, 1)
  const to = localDay(restaurant.timezone, 32)
  const release = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
  const location = async (id: string) => {
    const response = await page.request.get(`${baseURL}/api/organizations/${restaurant.organizationId}/locations/${id}`)
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { location: { updated_at: string; special_hours: unknown } }).location
  }
  try {
    await loginAs(page.request, baseURL)
    // The read the grid draws, and the native app reads: both locations with reservations, then the class; the day with the seeded table is booked.
    const calendar = await readCalendar(page.request, restaurant.slug, from, to)
    expect(calendar.manage).toBe(true)
    expect(calendar.places.map(entry => [entry.place.kind, entry.place.id, entry.place.name, entry.place.detail])).toEqual([
      ['location', brooklyn.id, 'Ember & Slice Brooklyn', '120 Atlantic Avenue, Brooklyn'],
      ['location', williamsburg.id, 'Ember & Slice Williamsburg', '88 Bedford Avenue, Brooklyn'],
      ['offering', pizza!.id, 'Pizza-Making Class', 'Experience · Ember & Slice Brooklyn'],
    ])
    const brooklynDays = calendar.places[0]!.days
    const booked = brooklynDays.find(day => day.held?.kind === 'booked')
    expect(booked, 'Maya Chen’s table is on the window').toBeTruthy()
    // Two free, open days with nothing on them, to block at both locations.
    const free = brooklynDays.filter((day, index) => !day.held && !day.closed && !calendar.places[1]!.days[index]!.held && !calendar.places[1]!.days[index]!.closed && next(day.date) === brooklynDays[index + 1]?.date && !brooklynDays[index + 1]!.held).map(day => day.date)
    const first = free[0]!
    const second = next(first)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/dashboard/${restaurant.slug}/calendar?view=places&from=${from}`)
    const grid = page.getByTestId('places-grid')
    await expect(grid.locator(`[data-place="location:${brooklyn.id}"] span`)).toHaveText(['Ember & Slice Brooklyn', '120 Atlantic Avenue, Brooklyn'])
    await expect(grid.locator(`[data-place="offering:${pizza!.id}"] span`)).toHaveText(['Pizza-Making Class', 'Experience · Ember & Slice Brooklyn'])
    // The booked day is a bar counting its reservations; it opens that day, narrowed to the location.
    const bar = grid.locator(`div[role="rowheader"]:has([data-place="location:${brooklyn.id}"]) + div [data-booked="${booked!.date}"]`)
    await expect(bar).toHaveText(`${booked!.booked} booked`)
    expect(new URL((await bar.getAttribute('href'))!, baseURL).searchParams.get('locationId')).toBe(brooklyn.id)
    // The grid scrolls inside itself; the page does not scroll sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // Search narrows by name or street; No upcoming bookings keeps the places with none in the window.
    await page.getByRole('textbox', { name: 'Search places' }).fill('Bedford')
    await expect(grid.locator('[data-place]')).toHaveCount(1)
    await expect(grid.locator(`[data-place="location:${williamsburg.id}"]`)).toBeVisible()
    await page.getByRole('textbox', { name: 'Search places' }).fill('')
    await expect(grid.locator('[data-place]')).toHaveCount(3)
    await page.getByRole('button', { name: 'No upcoming bookings' }).click()
    await expect(grid.locator(`[data-place="location:${brooklyn.id}"]`)).toHaveCount(0)
    await expect(grid.locator(`[data-place="location:${williamsburg.id}"]`)).toBeVisible()
    await page.getByRole('button', { name: 'No upcoming bookings' }).click()
    await expect(grid.locator('[data-place]')).toHaveCount(3)

    // A first day at Brooklyn and a last at Williamsburg select both rows; the panel offers open or block and the weekdays, and no price.
    await cell(page, `location:${brooklyn.id}`, first).click()
    await cell(page, `location:${williamsburg.id}`, second).click()
    await expect(page).toHaveURL(url => url.searchParams.get('places') === `location:${brooklyn.id},location:${williamsburg.id}` && url.searchParams.get('dates') === `${first}..${next(second)}`)
    const inspector = page.getByTestId('stay-night-inspector')
    await expect(inspector.getByText('2 places · 2 dates')).toBeVisible()
    await expect(inspector.getByText('Available', { exact: true })).toBeVisible()
    await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toHaveCount(0)
    await expect(inspector.getByRole('button', { name: /^Minimum nights/ })).toHaveCount(0)
    await expect(inspector.getByRole('button', { name: 'Custom settings' })).toHaveCount(0)
    await expect(grid.getByTestId('places-selection').first()).toHaveText('2 dates')
    // Only the first day's weekday: the write carries weekdays, and the pill counts one of two dates.
    const weekday = new Date(`${first}T00:00:00Z`).getUTCDay()
    const other = new Date(`${second}T00:00:00Z`).getUTCDay()
    const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
    await inspector.getByRole('button', { name: names[other]!, exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get('weekdays') === String(weekday))
    await expect(inspector.getByTestId('stay-night-weekdays')).toHaveText(`${names[weekday]} · 1 of 2 dates`)
    await expect(grid.getByTestId('places-selection').first()).toHaveText('1 of 2 dates')
    const before = await Promise.all([location(brooklyn.id), location(williamsburg.id)])
    await inspector.getByRole('switch', { name: 'Open selected dates' }).click()
    await expect(inspector.getByText('Blocked by you', { exact: true })).toBeVisible()
    // Each location's own record holds one closure for the weekday's date, and nothing for the other date.
    for (const [index, id] of [brooklyn.id, williamsburg.id].entries()) {
      const saved = await location(id)
      expect(saved.updated_at).not.toBe(before[index]!.updated_at)
      expect(saved.special_hours).toEqual([...(Array.isArray(before[index]!.special_hours) ? before[index]!.special_hours as unknown[] : []), { kind: 'closure', starts_on: first, ends_on: first, note: null }])
    }
    await expect(cell(page, `location:${brooklyn.id}`, first)).toHaveText('Blocked')
    await expect(cell(page, `location:${brooklyn.id}`, second)).toHaveText('')

    // Both weekdays again: the selection is partly open and partly blocked, and Block asks first.
    await inspector.getByRole('button', { name: names[other]!, exact: true }).click()
    await expect(page).toHaveURL(url => !url.searchParams.has('weekdays'))
    await expect(inspector.getByText('Mixed availability', { exact: true })).toBeVisible()
    await inspector.getByRole('button', { name: 'Block dates', exact: true }).click()
    await expect(inspector.getByTestId('stay-night-confirm')).toContainText('Some selected dates are open and some are blocked. Block all 4 dates?')
    await inspector.getByRole('button', { name: 'Keep dates open', exact: true }).click()
    await expect(inspector.getByTestId('stay-night-confirm')).toHaveCount(0)
    await inspector.getByRole('button', { name: 'Open dates', exact: true }).click()
    await inspector.getByRole('button', { name: 'Open all dates', exact: true }).click()
    await expect(inspector.getByText('Available', { exact: true })).toBeVisible()
    for (const [index, id] of [brooklyn.id, williamsburg.id].entries()) expect((await location(id)).special_hours).toEqual(before[index]!.special_hours)

    // The day leaf blocks and opens one day through the same write, and the month reads the closure.
    await page.goto(`/dashboard/${restaurant.slug}/calendar/${first}?locationId=${brooklyn.id}`)
    await page.getByRole('button', { name: 'Block date', exact: true }).click()
    await expect(page.getByText('You blocked this date.')).toBeVisible()
    expect((await location(brooklyn.id)).special_hours).toEqual([...(Array.isArray(before[0]!.special_hours) ? before[0]!.special_hours as unknown[] : []), { kind: 'closure', starts_on: first, ends_on: first, note: null }])
    await page.getByRole('button', { name: 'Open date', exact: true }).click()
    await expect(page.getByText('Guests can book this date.')).toBeVisible()
    expect((await location(brooklyn.id)).special_hours).toEqual(before[0]!.special_hours)
  } finally {
    await release()
  }
})

test('a studio blocks and reopens a class’s sessions by day from the places grid; the sessions read the change', async ({ page }, testInfo) => {
  test.skip(!writable, 'Cancels sessions; requires isolated local D1')
  const studio = seededTenant('experience')
  const wheel = studio.products['wheel-class']!
  const from = localDay(studio.timezone, 1)
  const to = localDay(studio.timezone, 32)
  const release = await acquireTenantMutationLock(testInfo, studio.organizationId)
  const sessions = async (date: string, status: 'scheduled' | 'cancelled') => {
    const response = await page.request.get(`${baseURL}/api/editor/organizations/${studio.organizationId}/products/${wheel.id}/sessions?from=${date}T00:00:00.000Z&to=${next(next(date))}T00:00:00.000Z&status=${status}`)
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { sessions: Array<{ id: string; starts_at: string; timezone: string; status: string }> }).sessions
      .filter(session => new Intl.DateTimeFormat('en-CA', { timeZone: session.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(session.starts_at)) === date)
  }
  try {
    await loginAs(page.request, baseURL)
    const calendar = await readCalendar(page.request, studio.slug, from, to)
    expect(calendar.places.map(entry => [entry.place.kind, entry.place.name, entry.place.detail])).toEqual([
      ['offering', 'Glaze Painting Session', 'Experience · Riverside Studio'],
      ['offering', 'Wheel Throwing Class', 'Experience · Ao Nang Studio'],
    ])
    const wheelDays = calendar.places[1]!.days
    const open = wheelDays.filter(day => !day.held && !day.closed && day.free === 1).map(day => day.date)
    const first = open.find(date => open.includes(next(date)))!
    const second = next(first)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/dashboard/${studio.slug}/calendar?view=places&from=${from}`)
    const key = `offering:${wheel.id}`
    await expect(cell(page, key, first)).toHaveText('1 free')
    // The row's name opens the class's own calendar.
    const own = await page.getByTestId('places-grid').locator(`[data-place="${key}"]`).getAttribute('href')
    expect(new URL(own!, baseURL).searchParams.get('product_id')).toBe(wheel.id)

    // Block one day: its one session is cancelled, read back from the sessions API; the day reads Blocked.
    await cell(page, key, first).click()
    const inspector = page.getByTestId('stay-night-inspector')
    await expect(inspector.getByText('Wheel Throwing Class · 1 date')).toBeVisible()
    await inspector.getByRole('switch', { name: 'Open selected dates' }).click()
    await expect(inspector.getByText('Blocked by you', { exact: true })).toBeVisible()
    expect((await sessions(first, 'cancelled')).length).toBe(1)
    expect((await sessions(first, 'scheduled')).length).toBe(0)
    await expect(cell(page, key, first)).toHaveText('Blocked')
    await expect(cell(page, key, second)).toHaveText('1 free')
    expect((await sessions(second, 'scheduled')).length).toBe(1)

    // Two days, one blocked and one open: Open asks, then restores the cancelled session.
    await inspector.getByRole('button', { name: 'Clear selected dates' }).click()
    await cell(page, key, first).click()
    await cell(page, key, second).click()
    await expect(inspector.getByText('Mixed availability', { exact: true })).toBeVisible()
    await inspector.getByRole('button', { name: 'Open dates', exact: true }).click()
    await expect(inspector.getByTestId('stay-night-confirm')).toContainText('Some selected dates are open and some are blocked. Open all 2 dates?')
    await inspector.getByRole('button', { name: 'Open all dates', exact: true }).click()
    await expect(inspector.getByText('Available', { exact: true })).toBeVisible()
    expect((await sessions(first, 'scheduled')).length).toBe(1)
    expect((await sessions(first, 'cancelled')).length).toBe(0)
    await expect(cell(page, key, first)).toHaveText('1 free')
    // The glaze session kept every session throughout.
    const after = await readCalendar(page.request, studio.slug, from, to)
    expect(after.places[0]!.days).toEqual(calendar.places[0]!.days)
  } finally {
    await release()
  }
})

test('a consultation’s empty Saturday names the attorney’s hours as the reason and leads to them', async ({ page }) => {
  const legal = seededTenant('legal')
  const family = legal.products['family-law']!
  const from = localDay(legal.timezone, 1)
  const to = localDay(legal.timezone, 32)
  await loginAs(page.request, baseURL)
  const calendar = await readCalendar(page.request, legal.slug, from, to)
  const row = calendar.places.find(entry => entry.place.id === family.id)!
  expect(row.place.detail).toBe('Consultation · Dana Brooks, Esq.')
  expect(row.place.provider).toEqual({ member_id: legal.memberIds['user-e2e-ncls-owner'], name: 'Dana Brooks, Esq.' })
  const saturday = row.days.find(day => new Date(`${day.date}T00:00:00Z`).getUTCDay() === 6)!
  expect(saturday).toMatchObject({ closed: false, held: { kind: 'hours', text: "Outside Dana's hours" }, booked: 0, free: 0 })
  const weekday = row.days.find(day => [1, 2, 3, 4, 5].includes(new Date(`${day.date}T00:00:00Z`).getUTCDay()) && day.free)!
  expect(weekday.free).toBeGreaterThan(0)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/dashboard/${legal.slug}/calendar?view=places&from=${from}`)
  const key = `offering:${family.id}`
  await expect(cell(page, key, saturday.date)).toHaveAttribute('title', new RegExp("Outside Dana's hours"))
  await cell(page, key, saturday.date).click()
  const inspector = page.getByTestId('stay-night-inspector')
  await expect(inspector.getByTestId('stay-night-blocker')).toContainText("Outside Dana's hours")
  const hours = inspector.getByTestId('stay-night-blocker').getByRole('link', { name: 'Bookable times' })
  expect(new URL((await hours.getAttribute('href'))!, baseURL).pathname).toBe(`/dashboard/${legal.slug}/team/${row.place.provider!.member_id}/hours`)
  // Nothing to write: the held explanation stands in for the switch.
  await expect(inspector.getByRole('switch')).toHaveCount(0)
  await expect(inspector.getByTestId('stay-night-held')).toContainText("Outside Dana's hours")
})
