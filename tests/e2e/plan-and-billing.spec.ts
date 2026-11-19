import { expect, test, type Page } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { seededTenant } from './seed/manifest'

// Plan and billing (#1504): its own Menu destination at O/billing. A legal
// practice made for the Starter case has no subscription, so it is what an
// owner on Starter sees: the plan, Choose a plan, and services whose
// requirements are not met. The seeded Clayhouse Studio is Growth on a
// test-mode subscription. Ember & Slice's second owner is turned admin and then
// member to read what they are shown. Each state is read at 800 and 1440, where
// the index either opens beside a pane or is the screen.

const WIDTHS = [800, 1440] as const
const GROWTH_OWNER_ID = 'user-e2e-pottery-owner'

/** Signs in as an organization's owner through Better Auth's admin impersonation, runs the walk, then restores the principal. */
async function asOwner(page: Page, baseURL: string, userId: string, organizationId: string, walk: () => Promise<void>) {
  expect(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Owner impersonation is confined to isolated local D1').toBe(true)
  const principal = await (await page.request.get('/api/auth/get-session')).json() as { user: { id: string; role: string } }
  expect(principal.user.role).toBe('admin')
  let impersonated = false
  try {
    const impersonation = await page.request.post('/api/auth/admin/impersonate-user', { headers: authRequestHeaders(baseURL), data: { userId } })
    expect(impersonation.status(), await impersonation.text()).toBe(200)
    impersonated = true
    const activated = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL), data: { organizationId } })
    expect(activated.status(), await activated.text()).toBe(200)
    await walk()
  } finally {
    try {
      if (impersonated) {
        const stopped = await page.request.post('/api/auth/admin/stop-impersonating', { headers: authRequestHeaders(baseURL), data: {} })
        expect(stopped.status(), await stopped.text()).toBe(200)
      }
    } finally {
      const restored = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL), data: { organizationId: seededTenant('restaurant').organizationId } })
      expect(restored.status(), await restored.text()).toBe(200)
    }
  }
}

async function open(page: Page, path: string) {
  const response = await page.goto(path)
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
}

test.describe('Plan and billing', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await dismissPreviewToolbar(page)
    await loginAs(page.request, baseURL!)
  })

  test('a cold Google Calendar connection renders one panel at desktop and drawer widths', async ({ page }) => {
    const tenant = seededTenant('restaurant')
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1200 })
      const response = await page.goto(`/dashboard/${tenant.slug}/integrations/google-calendar`)
      expect(response?.status()).toBe(200)
      expect(await response?.text()).toContain('id="dashboard-panel-google-calendar"')
      await waitForNuxtHydration(page)
      const panel = page.locator('#dashboard-panel-google-calendar')
      await expect(panel).toHaveCount(1)
      await expect(panel.getByRole('heading', { name: 'Google Calendar sync', exact: true })).toBeVisible()
    }
  })

  test('a Growth owner upgrades to Business in one step', async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    const studio = seededTenant('experience')
    const GROWTH_ID = studio.organizationId
    const GROWTH = `/dashboard/${studio.slug}`
    await asOwner(page, baseURL!, GROWTH_OWNER_ID, GROWTH_ID, async () => {
      // The premise, read from the billing API: Growth on a Stripe subscription this key reads.
      const status = await page.request.get(`/api/billing/status?organization_id=${GROWTH_ID}&include_price=true`)
      expect(status.status(), await status.text()).toBe(200)
      const billing = (await status.json() as { billing: { plan: string; stripeSubscriptionId?: string; status?: string; cancelAtPeriodEnd?: boolean; scheduled_plan?: unknown; subscription_price?: { amount: number; interval: string } } }).billing
      expect(billing).toMatchObject({ plan: 'growth', status: 'active', cancelAtPeriodEnd: false, subscription_price: { amount: 4900, interval: 'month' } })

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1200 })
        await open(page, `${GROWTH}/billing`)
        const index = page.locator('#dashboard-panel-organization-billing')
        const card = index.getByTestId('billing-plan-card')
        await expect(card).toContainText('Growth')
        await expect(card).toContainText('$49/mo')
        await expect(card).toContainText(/Renews \w{3} \d{1,2}, \d{4}/)
        await expect(card.getByRole('link', { name: 'Upgrade to Business', exact: true })).toBeVisible()
        await expect(index.getByTestId('editor-card-locations')).toHaveCount(0)
        await expect(index.getByTestId('editor-card-portal')).toContainText('Card, invoices and receipts, cancel')
        await expect(index.getByTestId('editor-card-cancel')).toHaveCount(0)

        await open(page, `${GROWTH}/billing/upgrade`)
        const upgrade = page.locator('#dashboard-panel-organization-upgrade')
        await expect(upgrade.getByRole('heading', { name: 'Upgrade to Business', exact: true })).toBeVisible()
        await expect(upgrade.getByText('$149/mo', { exact: true })).toBeVisible()
        await expect(upgrade.locator('[data-testid^="editor-row-"]')).toHaveCount(4)
        await expect(upgrade.getByText('This upgrade applies immediately. Stripe calculates any prorated charge for the rest of your billing period.', { exact: true })).toBeVisible()
        await expect(upgrade.getByTestId('editor-row-payments')).toContainText('1.4% of payment volume, plus Stripe fees')
        await expect(upgrade.getByTestId('editor-row-payments')).toContainText('Online payments and direct stay booking')
        await expect(upgrade.getByTestId('editor-row-google-ads')).toContainText('Google Ads campaigns')
        await expect(upgrade.getByTestId('editor-row-calendar-sync')).toContainText('Google Calendar sync')
        await expect(upgrade.getByTestId('editor-row-airbnb-sync')).toContainText('Airbnb sync')
        await expect(upgrade.getByTestId('editor-row-ios')).toHaveCount(0)
        await expect(upgrade.getByTestId('editor-row-messaging')).toHaveCount(0)
        await expect(upgrade.getByRole('button', { name: 'Agree and upgrade to Business', exact: true })).toBeEnabled()
        await expect(upgrade.getByRole('radio')).toHaveCount(0)
      }

      // Continue records the upgrade intent, then asks Better Auth to change this organization's
      // subscription. Both answer at the test boundary without reaching Stripe: the intent writes
      // analytics metadata onto the shared test-mode subscription and customer, and Better Auth would
      // swap their prices. A refusal, not an abort, because Better Auth's client retries a failed request.
      const intents: Array<Record<string, unknown>> = []
      const upgradeRequests: Array<Record<string, unknown>> = []
      await page.route('**/api/billing/analytics-intent**', async (route) => {
        intents.push(route.request().postDataJSON() as Record<string, unknown>)
        await route.fulfill({ json: { success: true, intent_id: 'e2e-boundary' } })
      })
      await page.route('**/api/auth/subscription/upgrade**', async (route) => {
        upgradeRequests.push(route.request().postDataJSON() as Record<string, unknown>)
        await route.fulfill({ status: 400, json: { message: 'Stopped at the test boundary', code: 'E2E_BOUNDARY' } })
      })
      await open(page, `${GROWTH}/billing/upgrade`)
      const upgrade = page.locator('#dashboard-panel-organization-upgrade')
      await upgrade.getByRole('button', { name: 'Agree and upgrade to Business', exact: true }).click()
      await expect(upgrade.getByText('Stopped at the test boundary', { exact: true })).toBeVisible()
      expect(intents).toHaveLength(1)
      expect(intents[0]).toMatchObject({ organizationId: GROWTH_ID, subscriptionId: billing.stripeSubscriptionId, action: 'upgrade', effectiveTiming: 'immediate' })
      expect(upgradeRequests).toHaveLength(1)
      expect(upgradeRequests[0]).toMatchObject({ plan: 'business', referenceId: GROWTH_ID, customerType: 'organization', subscriptionId: billing.stripeSubscriptionId })
      // The owner comes back to Plan and billing: the upgrade leaf no longer applies once the plan is Business.
      expect(upgradeRequests[0]).toMatchObject({ returnUrl: new URL(`${GROWTH}/billing`, baseURL).toString(), successUrl: new URL(`${GROWTH}/billing?success=true&plan=business`, baseURL).toString() })
      // The organization is still on Growth.
      const unchanged = await page.request.get(`/api/billing/status?organization_id=${GROWTH_ID}`)
      expect((await unchanged.json() as { billing: { plan: string } }).billing.plan).toBe('growth')
    })
  })
})
