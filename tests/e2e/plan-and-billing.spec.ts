import { expect, test, type Page } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { HomesQuote } from '../../server/utils/billing'

// Plan and billing (#1504): its own Menu destination at O/billing. The Basic
// review organization is a real snapshot tenant with no subscription, so it is
// what an owner on Starter sees: the plan, Choose a plan, and services whose
// requirements are not met. Pottery House is Growth on a test-mode
// subscription (billing:test-mode in local:setup). Ember & Slice's second owner
// is turned admin and then member to read what they are shown. Each state is
// read at 800 and 1440, where the index either opens beside a pane or is the screen.

const BASIC_ID = 'OcMePkke1szEqCjfyHDYS6l26JenCLcg'
const BASIC_OWNER_ID = '3TW7uQfi4mzTcCqIWPltcwBxav3F67HZ'
const BASIC = '/dashboard/krabiclaw-review-legal'
const WIDTHS = [800, 1440] as const

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

  test('a Starter owner reads the plan, chooses one, and sees what managed ads needs', async ({ page, baseURL }) => {
    test.setTimeout(180_000)
    await asOwner(page, baseURL!, BASIC_OWNER_ID, BASIC_ID, async () => {
      // The premise, read from the billing API rather than the page: Starter, no Stripe customer.
      const status = await page.request.get(`/api/billing/status?organizationId=${BASIC_ID}`)
      expect(status.status(), await status.text()).toBe(200)
      const billing = (await status.json() as { billing: { plan: string; stripeCustomerId?: string; stripeSubscriptionId?: string } }).billing
      expect(billing.plan).toBe('free')
      expect(billing.stripeSubscriptionId).toBeUndefined()
      expect(billing.stripeCustomerId).toBeUndefined()
      // This Legal practice has no live or draft homes. Its allowance remains
      // canonical billing state; the irrelevant Homes row is not navigation.
      const [contextResponse, homesResponse] = await Promise.all([
        page.request.get('/api/dashboard/context', { params: { org: 'krabiclaw-review-legal' } }),
        page.request.get(`/api/organizations/${BASIC_ID}/billing/homes`, { params: { adding: '0' } }),
      ])
      for (const response of [contextResponse, homesResponse]) expect(response.status(), await response.text()).toBe(200)
      expect((await contextResponse.json() as { organization: { id: string; vertical: string } }).organization).toMatchObject({ id: BASIC_ID, vertical: 'service' })
      expect(await homesResponse.json() as HomesQuote).toMatchObject({
        plan: 'free', currency: 'USD',
        homes: { used: 0, drafts: 0, included: 2, amount_minor: 0 },
        adding: { count: 0, additional_homes: 0, amount_minor: 0, allowed: true },
        billing: { period_end: null, trial_end: null, prorated: false },
      })
      // Managed ads' requirements, as the agreement checks them: none met on Starter with no Google Ads.
      const requirements = await page.request.get('/api/dashboard/services?org=krabiclaw-review-legal&requirements=managed_ads')
      expect(requirements.status(), await requirements.text()).toBe(200)
      expect(await requirements.json()).toEqual({
        success: true,
        services: { managed_ads: null, strategy: null },
        requirements: { managed_ads: { google_ads_usd: false, business_plan: false, default_payment_method: false } },
      })

      // Plan and billing is the owner's own Menu row; Payments keeps only how money arrives.
      await page.setViewportSize({ width: 1440, height: 1200 })
      await open(page, `${BASIC}/menu`)
      await page.getByTestId('dashboard-top-nav-menu-button').click()
      await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('link', { name: 'Plan and billing', exact: true }).click()
      await expect(page).toHaveURL(`${BASIC}/billing/upgrade`)
      await expect(page.locator('#dashboard-panel-organization-billing [data-testid="dashboard-navbar-back"]')).toHaveAttribute('href', `${BASIC}/menu`)
      await open(page, `${BASIC}/payments`)
      const payments = page.locator('#dashboard-panel-organization-payments')
      await expect(payments.getByRole('link', { name: /^How you get paid/ })).toBeVisible()
      await expect(payments.getByRole('link', { name: /^(Payment methods|Your payments|Plan)/ })).toHaveCount(0)

      // Agreeing to managed ads is refused on the server while its requirements are open, and nothing is recorded.
      const rejected = await page.request.post('/api/dashboard/services?org=krabiclaw-review-legal', { headers: authRequestHeaders(baseURL!), data: { service: 'managed_ads', action: 'agree' } })
      expect(rejected.status(), await rejected.text()).toBe(409)
      expect((await rejected.json() as { message: string }).message).toBe('Managed ads is billed on the Business plan. Choose Business in Plan and billing before turning on managed ads.')
      const after = await page.request.get('/api/dashboard/services?org=krabiclaw-review-legal')
      expect(after.status(), await after.text()).toBe(200)
      expect(await after.json()).toEqual({ success: true, services: { managed_ads: null, strategy: null } })

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1200 })
        const wide = width >= 1024

        // The index: the plan as its one card, the firm's Offices and the two services. No portal without a Stripe customer.
        await open(page, `${BASIC}/billing`)
        const index = page.locator('#dashboard-panel-organization-billing')
        await expect(index.getByRole('heading', { name: 'Plan and billing', exact: true })).toBeVisible()
        const card = index.getByTestId('billing-plan-card')
        await expect(card).toContainText('Basic')
        await expect(card).toContainText('Free')
        await expect(card.getByRole('link', { name: 'Choose a plan', exact: true })).toBeVisible()
        await expect(index.locator('[data-testid^="editor-row-"]')).toHaveCount(2)
        await expect(index.getByTestId('editor-row-locations')).toHaveCount(0)
        await expect(index.getByTestId('editor-row-homes')).toHaveCount(0)
        await expect(index.getByTestId('editor-row-portal')).toHaveCount(0)
        await expect(index.getByTestId('editor-row-managed-ads')).toContainText('Off10% of monthly ad spend')
        await expect(index.getByTestId('editor-row-strategy')).toContainText('Off$2,000/mo')
        // Beside a pane the index opens the plan's one change; on a narrower screen it is the screen.
        await expect(page).toHaveURL(wide ? `${BASIC}/billing/upgrade` : `${BASIC}/billing`)

        // Choose a plan: Growth and Business as two cards, Continue only once one is chosen.
        await open(page, `${BASIC}/billing/upgrade`)
        const upgrade = page.locator('#dashboard-panel-organization-upgrade')
        await expect(upgrade.getByRole('heading', { name: 'Choose a plan', exact: true })).toBeVisible()
        await expect(upgrade.getByRole('radio')).toHaveCount(2)
        // The recommended plan starts chosen, so Continue is live.
        await expect(upgrade.getByRole('radio', { checked: true })).toHaveCount(1)
        await expect(upgrade.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
        // The card is what a person presses. Its radio is named by the card's label beside the pane,
        // and by its value inside the drawer, where Nuxt UI's label is not yet associated.
        await upgrade.getByText('Business', { exact: true }).click()
        await expect(upgrade.getByRole('radio', { name: /^business/i })).toBeChecked()

        // Managed ads off: three unmet requirements, and no consent until they hold.
        await open(page, `${BASIC}/billing/managed-ads`)
        const ads = page.locator('#dashboard-panel-organization-managed-ads')
        await expect(ads.getByText('10% of monthly ad spend, added to your plan\'s invoice.', { exact: true })).toBeVisible()
        // Each open requirement says where it stands; the two with somewhere to go are links there.
        await expect(ads.getByTestId('editor-row-google-ads')).toContainText('Not connected in USD')
        await expect(ads.getByTestId('editor-row-google-ads')).toHaveAttribute('href', `${BASIC}/integrations/google-ads`)
        await expect(ads.getByTestId('editor-row-business-plan')).toContainText('On Basic')
        await expect(ads.getByTestId('editor-row-business-plan')).toHaveAttribute('href', `${BASIC}/billing/upgrade`)
        await expect(ads.getByTestId('editor-row-payment-method')).toContainText('None saved')
        // Without a plan there is no Stripe customer, so the payment-method row opens nothing.
        await expect(ads.getByTestId('editor-row-payment-method')).not.toHaveAttribute('type', 'button')
        // No consent until every requirement holds: the line under the rows says what is left.
        await expect(ads.getByRole('button', { name: 'Agree and turn on', exact: true })).toHaveCount(0)
        await expect(ads.getByText('Connect Google Ads in USD, upgrade to Business and add a payment method to turn this on.', { exact: true })).toBeVisible()
      }
    })
  })

  test('a Growth owner upgrades to Business in one step', async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    await asOwner(page, baseURL!, GROWTH_OWNER_ID, GROWTH_ID, async () => {
      // The premise, read from the billing API: Growth on a Stripe subscription this key reads.
      const status = await page.request.get(`/api/billing/status?organizationId=${GROWTH_ID}&includePrice=true`)
      expect(status.status(), await status.text()).toBe(200)
      const billing = (await status.json() as { billing: { plan: string; stripeSubscriptionId?: string; subscriptionStatus?: string; cancelAtPeriodEnd?: boolean; scheduledPlan?: unknown; subscriptionPrice?: { amount: number; interval: string } } }).billing
      expect(billing).toMatchObject({ plan: 'growth', subscriptionStatus: 'active', cancelAtPeriodEnd: false, subscriptionPrice: { amount: 4900, interval: 'month' } })

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1200 })
        await open(page, `${GROWTH}/billing`)
        const index = page.locator('#dashboard-panel-organization-billing')
        const card = index.getByTestId('billing-plan-card')
        await expect(card).toContainText('Growth')
        await expect(card).toContainText('$49/mo')
        await expect(card).toContainText(/Renews \w{3} \d{1,2}, \d{4}/)
        await expect(card.getByRole('link', { name: 'Upgrade to Business', exact: true })).toBeVisible()
        await expect(index.getByTestId('editor-row-locations')).toHaveCount(0)
        await expect(index.getByTestId('editor-row-portal')).toContainText('Card, invoices and receipts, cancel')
        await expect(index.getByTestId('editor-row-cancel')).toHaveCount(0)

        await open(page, `${GROWTH}/billing/upgrade`)
        const upgrade = page.locator('#dashboard-panel-organization-upgrade')
        await expect(upgrade.getByRole('heading', { name: 'Upgrade to Business', exact: true })).toBeVisible()
        await expect(upgrade.getByText('$149/mo', { exact: true })).toBeVisible()
        await expect(upgrade.locator('[data-testid^="editor-row-"]')).toHaveCount(4)
        await expect(upgrade.getByText(/^\$100\/mo more than Growth\. Stripe charges the difference for the rest of this period, then \$149\/mo from \w{3} \d{1,2}, \d{4}\.$/)).toBeVisible()
        await expect(upgrade.getByTestId('editor-row-payments')).toContainText('1.4% of payment volume, plus Stripe fees')
        await expect(upgrade.getByTestId('editor-row-payments')).toContainText('Online payments and direct stay booking')
        await expect(upgrade.getByTestId('editor-row-google-ads')).toContainText('Google Ads campaigns')
        await expect(upgrade.getByTestId('editor-row-calendar-sync')).toContainText('Google Calendar sync')
        await expect(upgrade.getByTestId('editor-row-airbnb-sync')).toContainText('Airbnb sync')
        await expect(upgrade.getByTestId('editor-row-ios')).toHaveCount(0)
        await expect(upgrade.getByTestId('editor-row-messaging')).toHaveCount(0)
        await expect(upgrade.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
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
        await route.fulfill({ json: { success: true, intentId: 'e2e-boundary' } })
      })
      await page.route('**/api/auth/subscription/upgrade**', async (route) => {
        upgradeRequests.push(route.request().postDataJSON() as Record<string, unknown>)
        await route.fulfill({ status: 400, json: { message: 'Stopped at the test boundary', code: 'E2E_BOUNDARY' } })
      })
      await open(page, `${GROWTH}/billing/upgrade`)
      const upgrade = page.locator('#dashboard-panel-organization-upgrade')
      await upgrade.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(upgrade.getByText('Stopped at the test boundary', { exact: true })).toBeVisible()
      expect(intents).toHaveLength(1)
      expect(intents[0]).toMatchObject({ organizationId: GROWTH_ID, subscriptionId: billing.stripeSubscriptionId, action: 'upgrade', effectiveTiming: 'immediate' })
      expect(upgradeRequests).toHaveLength(1)
      expect(upgradeRequests[0]).toMatchObject({ plan: 'business', referenceId: GROWTH_ID, customerType: 'organization', subscriptionId: billing.stripeSubscriptionId })
      // The owner comes back to Plan and billing: the upgrade leaf no longer applies once the plan is Business.
      expect(upgradeRequests[0]).toMatchObject({ returnUrl: new URL(`${GROWTH}/billing`, baseURL).toString(), successUrl: new URL(`${GROWTH}/billing?success=true&plan=business`, baseURL).toString() })
      // The organization is still on Growth.
      const unchanged = await page.request.get(`/api/billing/status?organizationId=${GROWTH_ID}`)
      expect((await unchanged.json() as { billing: { plan: string } }).billing.plan).toBe('growth')
    })
  })

  test('an admin reads Plan and billing and changes nothing; a member has no Menu row', async ({ page, browser, baseURL }, testInfo) => {
    test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Role changes use disposable local actors only')
    test.setTimeout(90_000)
    const release = await acquireTenantMutationLock(testInfo, 'org-demo')
    try {
      const membersResponse = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
      expect(membersResponse.status(), await membersResponse.text()).toBe(200)
      const { members } = await membersResponse.json() as { members: Array<{ id: string; userId: string; role: string }> }
      const actor = members.find(member => member.userId === 'user-e2e-demo-role-owner')
      expect(actor).toBeTruthy()
      const setRole = async (role: string) => {
        const changed = await page.request.post('/api/auth/organization/update-member-role', { headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo', memberId: actor!.id, role } })
        expect(changed.status(), await changed.text()).toBe(200)
      }
      const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
      try {
        try {
          await setRole('admin')
          await loginAs(context.request, baseURL!, actor!.userId)
          const admin = await context.newPage()
          await dismissPreviewToolbar(admin)
          await open(admin, '/dashboard/ember-slice-demo/menu')
          await admin.getByTestId('dashboard-top-nav-menu-button').click()
          await expect(admin.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('link', { name: 'Plan and billing', exact: true })).toBeVisible()
          await open(admin, '/dashboard/ember-slice-demo/billing')
          const index = admin.locator('#dashboard-panel-organization-billing')
          // One line names who changes it; the plan card has no button and Stripe's portal is not offered.
          await expect(index.getByTestId('billing-owner-line')).toContainText('is the owner and changes the plan and billing.')
          await expect(index.getByTestId('billing-plan-card')).toContainText('Business')
          await expect(index.getByTestId('billing-plan-card').getByRole('button')).toHaveCount(0)
          await expect(index.getByTestId('billing-plan-card').getByRole('link')).toHaveCount(0)
          await expect(index.getByTestId('editor-row-portal')).toContainText('Manage billing')
          await expect(index.locator('button[data-testid="editor-row-portal"]')).toHaveCount(0)
          // A service leaf reads the same, with no consent to give.
          await open(admin, '/dashboard/ember-slice-demo/billing/strategy')
          const strategy = admin.locator('#dashboard-panel-organization-strategy')
          await expect(strategy.getByText('Owners turn services on and off.', { exact: true })).toBeVisible()
          await expect(admin.getByRole('button', { name: /^(Agree and turn on|Turn off)$/ })).toHaveCount(0)
          // Better Auth refuses the admin's agreement on the server too, and nothing is recorded.
          const servicesBefore = await page.request.get('/api/dashboard/services?org=ember-slice-demo')
          expect(servicesBefore.status(), await servicesBefore.text()).toBe(200)
          const before = (await servicesBefore.json() as { services: Record<string, unknown> }).services
          const refused = await context.request.post('/api/dashboard/services?org=ember-slice-demo', { headers: authRequestHeaders(baseURL!), data: { service: 'managed_ads', action: 'agree' } })
          expect(refused.status(), await refused.text()).toBe(403)
          const servicesAfter = await page.request.get('/api/dashboard/services?org=ember-slice-demo')
          expect(servicesAfter.status(), await servicesAfter.text()).toBe(200)
          expect((await servicesAfter.json() as { services: Record<string, unknown> }).services).toEqual(before)

          await setRole('member')
          await open(admin, '/dashboard/ember-slice-demo/menu')
          await admin.getByTestId('dashboard-top-nav-menu-button').click()
          const menu = admin.getByRole('dialog', { name: 'Menu', exact: true })
          await expect(menu.getByRole('link', { name: 'Website', exact: true })).toBeVisible()
          await expect(menu.getByTestId('dashboard-menu-error')).toHaveCount(0)
          await expect(menu.getByRole('link', { name: 'Plan and billing', exact: true })).toHaveCount(0)
        } finally {
          await setRole(actor!.role)
          const read = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
          expect(read.status()).toBe(200)
          expect((await read.json() as { members: Array<{ id: string; role: string }> }).members.find(member => member.id === actor!.id)?.role).toBe(actor!.role)
        }
      } finally {
        await context.close()
      }
    } finally {
      await release()
    }
  })
})
