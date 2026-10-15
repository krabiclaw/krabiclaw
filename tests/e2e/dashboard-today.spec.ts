import { expect, test } from '@playwright/test'
import { loginAs, authRequestHeaders } from './helpers/auth'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { TodayFeedPayload } from '../../shared/dashboard-today'

const ORG = '/dashboard/ember-slice-demo'

test('Today quick actions retain their item and location concern through navigation', async ({ page, baseURL }, testInfo) => {
  await loginAs(page.request, baseURL!)
  await dismissPreviewToolbar(page)
  const response = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo', locationId: 'loc-demo' } })
  expect(response.status(), await response.text()).toBe(200)
  const feed = await response.json() as TodayFeedPayload
  const availability = feed.cards.find(card => card.headline === 'Mark an item unavailable')
  const hours = feed.cards.find(card => card.headline === 'Update opening hours')
  expect(availability, 'The selected location has an item-availability action').toBeTruthy()
  expect(hours, 'The selected location has a dated-hours action').toBeTruthy()
  expect(hours!.to).toContain('/hours/exceptions/new-hours')
  expect(hours!.locationId).toBe('loc-demo')

  await page.setViewportSize({ width: 1440, height: 900 })
  expect((await page.goto(`${ORG}?locationId=loc-demo`))?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await page.screenshot({ path: testInfo.outputPath('today-wide.png'), fullPage: true })
  await page.goto(availability!.to)
  await waitForNuxtHydration(page)
  const chooser = page.locator('#dashboard-panel-catalog-all')
  await expect(chooser.getByRole('heading', { name: 'Choose an item', exact: true })).toBeVisible()
  const item = chooser.locator('a[href*="/locations/loc-demo"]').first()
  await expect(item).toBeVisible()
  const target = await item.getAttribute('href')
  expect(target).toContain('location_id=loc-demo')
  await item.click()
  await expect(page.getByRole('switch', { name: 'Accept at this location', exact: true })).toBeVisible()
  await expect(page).toHaveURL(target!)
})

test('Today keeps its location across range changes and opens dated hours with a guest message', async ({ page, baseURL }, testInfo) => {
  await loginAs(page.request, baseURL!)
  await dismissPreviewToolbar(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(ORG)
  await waitForNuxtHydration(page)
  await page.getByRole('button', { name: 'Filter bookings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Location', exact: true }).click()
  await page.getByRole('option', { name: 'Ember & Slice Brooklyn', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: 'Upcoming', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === 'loc-demo' && url.searchParams.get('range') === 'upcoming')
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === 'loc-demo' && url.searchParams.get('range') === 'upcoming')
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: testInfo.outputPath('upcoming-mobile.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Today', exact: true }).click()
  const hours = page.locator('[data-card-id="action:hours:loc-demo"]')
  await expect(hours).toHaveAttribute('href', /\/locations\/[^/]+\/hours\/exceptions\/new-hours$/)
  await hours.click()
  const editor = page.locator('#dashboard-panel-location-hours-exception')
  await expect(editor.getByLabel('Date', { exact: true })).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'Guest message', exact: true })).toBeVisible()
})

test('an assigned member receives no owner actions or unassigned restaurant work', async ({ page, browser, baseURL }, testInfo) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Role changes use disposable local actors only')
  const release = await acquireTenantMutationLock(testInfo, 'org-demo')
  await loginAs(page.request, baseURL!)
  const response = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
  expect(response.status(), await response.text()).toBe(200)
  const { members } = await response.json() as { members: Array<{ id: string; userId: string; role: string }> }
  const actor = members.find(member => member.userId === 'user-e2e-demo-role-owner')
  expect(actor).toBeTruthy()
  const memberContext = await browser.newContext()
  try {
    const ownerResponse = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo' } })
    expect(ownerResponse.status(), await ownerResponse.text()).toBe(200)
    const ownerFeed = await ownerResponse.json() as TodayFeedPayload
    expect(ownerFeed.cards.find(card => card.id === 'action:availability')).toMatchObject({
      priority: 'action', to: `${ORG}/products/all?action=availability`,
    })
    const changed = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo', memberId: actor!.id, role: 'member' },
    })
    expect(changed.status(), await changed.text()).toBe(200)
    await loginAs(memberContext.request, baseURL!, actor!.userId)
    const memberFeed = await memberContext.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo' } })
    expect(memberFeed.status(), await memberFeed.text()).toBe(200)
    expect((await memberFeed.json() as TodayFeedPayload).cards).toEqual([])
    const denied = await memberContext.request.get('/api/dashboard/analytics', { params: { org: 'ember-slice-demo' } })
    // Organization-wide surfaces deliberately conceal denied scope with 404.
    expect(denied.status()).toBe(404)
    const memberPage = await memberContext.newPage()
    expect((await memberPage.goto(new URL(ORG, baseURL!).toString()))?.status()).toBe(200)
    await expect(memberPage.getByText('Nothing needs your attention today', { exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('today-card')).toHaveCount(0)
  } finally {
    try {
      const restored = await page.request.post('/api/auth/organization/update-member-role', {
        headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo', memberId: actor!.id, role: actor!.role },
      })
      expect(restored.status(), await restored.text()).toBe(200)
      const read = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
      expect(read.status()).toBe(200)
      expect((await read.json() as { members: Array<{ id: string; role: string }> }).members.find(member => member.id === actor!.id)?.role).toBe(actor!.role)
    } finally {
      await memberContext.close()
      await release()
    }
  }
})
