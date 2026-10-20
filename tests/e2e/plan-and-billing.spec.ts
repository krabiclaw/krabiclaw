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
    expect(['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Owner impersonation is confined to isolated local D1').toBe(true)
    const principal = await (await page.request.get('/api/auth/get-session')).json() as { user: { id: string; role: string } }
    expect(principal.user.role).toBe('admin')
    let impersonated = false
    try {
      const impersonation = await page.request.post('/api/auth/admin/impersonate-user', { headers: authRequestHeaders(baseURL!), data: { userId: BASIC_OWNER_ID } })
      expect(impersonation.status(), await impersonation.text()).toBe(200)
      impersonated = true
      const activated = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL!), data: { organizationId: BASIC_ID } })
      expect(activated.status(), await activated.text()).toBe(200)

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

      const capture = async (name: string) => {
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
      }

      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme })
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 })
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
          await expect(index.getByTestId('editor-row-managed-ads')).toContainText('Off · 10% of monthly ad spend')
          await expect(index.getByTestId('editor-row-strategy')).toContainText('Off · $2,000/mo')
          // Beside a pane the index opens its first row, the plan; on a narrower screen it is the screen.
          if (wide) {
            await expect(page).toHaveURL(`${BASIC}/billing/plan`)
            await expect(page.locator('#dashboard-panel-organization-plan').getByText('Locations', { exact: true })).toBeVisible()
          }
          else await expect(page).toHaveURL(`${BASIC}/billing`)
          await capture(`billing-index-${suffix}`)

          // Choose a plan: Growth and Business as two cards, Continue only once one is chosen.
          await open(page, `${BASIC}/billing/upgrade`)
          const upgrade = page.locator('#dashboard-panel-organization-upgrade')
          await expect(upgrade.getByRole('heading', { name: 'Choose a plan', exact: true })).toBeVisible()
          await expect(upgrade.getByRole('radio')).toHaveCount(2)
          await expect(upgrade.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
          await capture(`billing-choose-a-plan-${suffix}`)

          // Managed ads off: three unmet requirements, and no consent until they hold.
          await open(page, `${BASIC}/billing/managed-ads`)
          const ads = page.locator('#dashboard-panel-organization-managed-ads')
          await expect(ads.getByText('10% of monthly ad spend, added to your plan\'s invoice.', { exact: true })).toBeVisible()
          for (const id of ['google-ads', 'business-plan', 'payment-method']) await expect(ads.getByTestId(`editor-row-${id}`)).toContainText('Not yet')
          await expect(ads.getByRole('button', { name: 'Agree and turn on', exact: true })).toBeDisabled()
          await capture(`billing-managed-ads-off-${suffix}`)
        }
      }
    } finally {
      try {
        if (impersonated) {
          const stopped = await page.request.post('/api/auth/admin/stop-impersonating', { headers: authRequestHeaders(baseURL!), data: {} })
          expect(stopped.status(), await stopped.text()).toBe(200)
        }
      } finally {
        const restored = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo' } })
        expect(restored.status(), await restored.text()).toBe(200)
      }
    }
  })
})
