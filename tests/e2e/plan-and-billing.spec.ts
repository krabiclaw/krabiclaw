import { expect, test, type Page } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'

// Plan and billing (#1504): its own Menu destination at O/billing. The Basic
// review organization is a real snapshot tenant with no subscription, so it is
// what an owner on Starter sees: the plan, Choose a plan, and services whose
// requirements are not met. Each state is captured light and dark at 800 and
// 1440 for the owner's visual review.

const BASIC_ID = 'OcMePkke1szEqCjfyHDYS6l26JenCLcg'
const BASIC_OWNER_ID = '3TW7uQfi4mzTcCqIWPltcwBxav3F67HZ'
const BASIC = '/dashboard/krabiclaw-review-legal'
const WIDTHS = [800, 1440] as const
const SCHEMES = ['light', 'dark'] as const

const GROWTH_ID = 'org-user-pottery-house'
const GROWTH_OWNER_ID = 'user-pottery-house'
const GROWTH = '/dashboard/org-user-pottery-house'

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
      const restored = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL), data: { organizationId: 'org-demo' } })
      expect(restored.status(), await restored.text()).toBe(200)
    }
  }
}

/** A full-page capture once the leaf's drawer has finished rising; looping indicators never finish. */
async function capture(page: Page, path: string) {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().endTime === Infinity))
  await page.screenshot({ path, fullPage: true })
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

  test('a Starter owner reads the plan, chooses one, and sees what managed ads needs', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000)
    await asOwner(page, baseURL!, BASIC_OWNER_ID, BASIC_ID, async () => {
      // The premise, read from the billing API rather than the page: Starter, no Stripe customer.
      const status = await page.request.get(`/api/billing/status?organizationId=${BASIC_ID}`)
      expect(status.status(), await status.text()).toBe(200)
      const billing = (await status.json() as { billing: { plan: string; stripeCustomerId?: string; stripeSubscriptionId?: string } }).billing
      expect(billing.plan).toBe('free')
      expect(billing.stripeSubscriptionId).toBeUndefined()
      expect(billing.stripeCustomerId).toBeUndefined()
      // Managed ads' requirements, as the agreement checks them: none met on Starter with no Google Ads.
      const requirements = await page.request.get('/api/dashboard/services?org=krabiclaw-review-legal&requirements=managed_ads')
      expect(requirements.status(), await requirements.text()).toBe(200)
      expect(await requirements.json()).toEqual({
        success: true,
        services: { managed_ads: null, strategy: null },
        requirements: { managed_ads: { google_ads_usd: false, business_plan: false, default_payment_method: false } },
      })

      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme })
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 1200 })
          const wide = width >= 1024
          const suffix = `${width}-${scheme}`

          // The index: the plan as its one card, then the locations it bills and the two services. No portal without a Stripe customer.
          await open(page, `${BASIC}/billing`)
          const index = page.locator('#dashboard-panel-organization-billing')
          await expect(index.getByRole('heading', { name: 'Plan and billing', exact: true })).toBeVisible()
          const card = index.getByTestId('billing-plan-card')
          await expect(card).toContainText('Basic')
          await expect(card).toContainText('Free')
          await expect(card.getByRole('link', { name: 'Choose a plan', exact: true })).toBeVisible()
          await expect(index.locator('[data-testid^="editor-row-"]')).toHaveCount(3)
          await expect(index.getByTestId('editor-row-locations')).toContainText('in use · 2 included')
          await expect(index.getByTestId('editor-row-managed-ads')).toContainText('Off10% of monthly ad spend')
          await expect(index.getByTestId('editor-row-strategy')).toContainText('Off$2,000/mo')
          // Beside a pane the index opens the plan's one change; on a narrower screen it is the screen.
          await expect(page).toHaveURL(wide ? `${BASIC}/billing/upgrade` : `${BASIC}/billing`)
          await capture(page, testInfo.outputPath(`billing-index-${suffix}.png`))

          // Choose a plan: Growth and Business as two cards, Continue only once one is chosen.
          await open(page, `${BASIC}/billing/upgrade`)
          const upgrade = page.locator('#dashboard-panel-organization-upgrade')
          await expect(upgrade.getByRole('heading', { name: 'Choose a plan', exact: true })).toBeVisible()
          await expect(upgrade.getByRole('radio')).toHaveCount(2)
          // The recommended plan starts chosen, so Continue is live.
          await expect(upgrade.getByRole('radio', { checked: true })).toHaveCount(1)
          await expect(upgrade.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
          await capture(page, testInfo.outputPath(`billing-choose-a-plan-${suffix}.png`))

          // Managed ads off: three unmet requirements, and no consent until they hold.
          await open(page, `${BASIC}/billing/managed-ads`)
          const ads = page.locator('#dashboard-panel-organization-managed-ads')
          await expect(ads.getByText('10% of monthly ad spend, added to your plan\'s invoice.', { exact: true })).toBeVisible()
          await expect(ads.getByTestId('editor-row-google-ads')).toContainText('Not connected in USD · Connect')
          await expect(ads.getByTestId('editor-row-business-plan')).toContainText('On Basic · Upgrade')
          await expect(ads.getByTestId('editor-row-payment-method')).toContainText('None saved')
          // No consent until every requirement holds: the line under the rows says what is left.
          await expect(ads.getByRole('button', { name: 'Agree and turn on', exact: true })).toHaveCount(0)
          await expect(ads.getByText('Connect Google Ads in USD, upgrade to Business and add a payment method to turn this on.', { exact: true })).toBeVisible()
          // Without a plan there is no Stripe customer, so the portal is not offered.
          await expect(ads.getByTestId('editor-row-payment-method')).not.toContainText('Add')
          await capture(page, testInfo.outputPath(`billing-managed-ads-off-${suffix}.png`))
        }
      }
    })
  })

  test('a Growth owner upgrades to Business in one step', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(120_000)
    await asOwner(page, baseURL!, GROWTH_OWNER_ID, GROWTH_ID, async () => {
      // The premise, read from the billing API: Growth on a Stripe subscription this key reads.
      const status = await page.request.get(`/api/billing/status?organizationId=${GROWTH_ID}&includePrice=true`)
      expect(status.status(), await status.text()).toBe(200)
      const billing = (await status.json() as { billing: { plan: string; subscriptionStatus?: string; cancelAtPeriodEnd?: boolean; scheduledPlan?: unknown; subscriptionPrice?: { amount: number; interval: string } } }).billing
      expect(billing).toMatchObject({ plan: 'growth', subscriptionStatus: 'active', cancelAtPeriodEnd: false, subscriptionPrice: { amount: 4900, interval: 'month' } })

      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme })
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 1200 })
          const suffix = `${width}-${scheme}`
          await open(page, `${GROWTH}/billing`)
          const index = page.locator('#dashboard-panel-organization-billing')
          const card = index.getByTestId('billing-plan-card')
          await expect(card).toContainText('Growth')
          await expect(card).toContainText('$49/mo')
          await expect(card).toContainText(/Renews \w{3} \d{1,2}, \d{4}/)
          await expect(card.getByRole('link', { name: 'Upgrade to Business', exact: true })).toBeVisible()
          await expect(index.getByTestId('editor-row-locations')).toContainText('included, then $49 per additional location per month')
          await expect(index.getByTestId('editor-row-portal')).toContainText('Card, invoices and receipts, cancel')
          await expect(index.getByTestId('editor-row-cancel')).toHaveCount(0)
          await capture(page, testInfo.outputPath(`billing-index-growth-${suffix}.png`))

          await open(page, `${GROWTH}/billing/upgrade`)
          const upgrade = page.locator('#dashboard-panel-organization-upgrade')
          await expect(upgrade.getByRole('heading', { name: 'Upgrade to Business', exact: true })).toBeVisible()
          await expect(upgrade.getByText('$149/mo', { exact: true })).toBeVisible()
          await expect(upgrade.locator('[data-testid^="editor-row-"]')).toHaveCount(4)
          await expect(upgrade.getByText('$100/mo more than Growth. Stripe charges the difference for the rest of this period.', { exact: true })).toBeVisible()
          await expect(upgrade.getByTestId('editor-row-payments')).toContainText('1.4% of payment volume, plus Stripe fees')
          await expect(upgrade.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
          await expect(upgrade.getByRole('radio')).toHaveCount(0)
          await capture(page, testInfo.outputPath(`billing-upgrade-${suffix}.png`))
        }
      }
    })
  })
})
