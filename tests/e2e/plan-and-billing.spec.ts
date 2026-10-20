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

          // The index: the plan, Choose a plan, the two services and Cancel only when there is a plan to cancel.
          await open(page, `${BASIC}/billing`)
          const index = page.locator('#dashboard-panel-organization-billing')
          await expect(index.getByRole('heading', { name: 'Plan and billing', exact: true })).toBeVisible()
          await expect(index.locator('[data-testid^="editor-row-"]')).toHaveCount(4)
          await expect(index.getByTestId('editor-row-plan')).toContainText('Free')
          await expect(index.getByTestId('editor-row-upgrade')).toContainText('Choose a plan')
          await expect(index.getByTestId('editor-row-upgrade')).toContainText('Growth $49/mo or Business $149/mo')
          await expect(index.getByTestId('editor-row-managed-ads')).toContainText('Off10% of monthly ad spend')
          await expect(index.getByTestId('editor-row-strategy')).toContainText('Off$2,000/mo')
          // Beside a pane the index opens its first row, the plan; on a narrower screen it is the screen.
          if (wide) {
            await expect(page).toHaveURL(`${BASIC}/billing/plan`)
            await expect(page.locator('#dashboard-panel-organization-plan').getByText('Locations', { exact: true })).toBeVisible()
          }
          else await expect(page).toHaveURL(`${BASIC}/billing`)
          await capture(page, testInfo.outputPath(`billing-index-${suffix}.png`))

          // The plan leaf: what Basic includes, and the way to a paid plan.
          await open(page, `${BASIC}/billing/plan`)
          const plan = page.locator('#dashboard-panel-organization-plan')
          await expect(plan.getByTestId('plan-hero')).toContainText('Basic')
          await expect(plan.getByTestId('plan-hero')).toContainText('Free')
          await expect(plan.getByTestId('editor-row-locations')).toContainText('of 2 included')
          await expect(plan.getByTestId('editor-row-upgrade')).toContainText('Choose a plan')
          await capture(page, testInfo.outputPath(`billing-plan-basic-${suffix}.png`))

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
          // No consent until every requirement holds: the footer says what is left instead.
          await expect(ads.getByRole('button', { name: 'Agree and turn on', exact: true })).toHaveCount(0)
          await expect(page.getByText('Connect Google Ads in USD, upgrade to Business and add a payment method to turn this on.', { exact: true })).toBeVisible()
          // Without a plan there is no Stripe customer, so the portal is not offered.
          await expect(ads.getByTestId('editor-row-payment-method').getByText('Add', { exact: true })).toHaveCount(0)
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
          await expect(index.getByTestId('editor-row-plan')).toContainText('Growth · $49/mo · Renews')
          await expect(index.getByTestId('editor-row-upgrade')).toContainText('Upgrade to Business')
          await expect(index.getByTestId('editor-row-upgrade')).toContainText('$149/mo · online payments, direct stay booking, Google Ads')
          await expect(index.getByTestId('editor-row-portal')).toContainText('Payment method and invoices')
          await expect(index.getByTestId('editor-row-cancel')).toBeVisible()
          await capture(page, testInfo.outputPath(`billing-index-growth-${suffix}.png`))

          await open(page, `${GROWTH}/billing/plan`)
          const plan = page.locator('#dashboard-panel-organization-plan')
          await expect(plan.getByTestId('plan-hero')).toContainText('$49/mo')
          await expect(plan.getByText(/^Your plan renews on /)).toBeVisible()
          await expect(plan.getByTestId('editor-row-upgrade')).toContainText('Upgrade to Business')
          await expect(plan.getByTestId('editor-row-portal')).toContainText('Payment method and invoices')
          await capture(page, testInfo.outputPath(`billing-plan-growth-${suffix}.png`))

          await open(page, `${GROWTH}/billing/upgrade`)
          const upgrade = page.locator('#dashboard-panel-organization-upgrade')
          await expect(upgrade.getByRole('heading', { name: 'Upgrade to Business', exact: true })).toBeVisible()
          await expect(upgrade.getByText('$149/mo', { exact: true })).toBeVisible()
          await expect(upgrade.locator('[data-testid^="editor-row-"]')).toHaveCount(4)
          await expect(upgrade.getByTestId('editor-row-rental-units')).toContainText('2 included, then $19 per additional rental unit per month')
          await expect(upgrade.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
          await expect(upgrade.getByRole('radio')).toHaveCount(0)
          await capture(page, testInfo.outputPath(`billing-upgrade-${suffix}.png`))
        }
      }
    })
  })
})
