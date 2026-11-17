import { expect, test } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from '../e2e/helpers'
import { testBaseUrl } from '../e2e/test-env'

test('Blawby pricing retains its billing plans after hydration', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('krabiclaw-theme', 'light'))
  const baseURL = testBaseUrl()
  const response = await openTenantPage(page, `${baseURL}/pricing`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('heading', { name: 'Basic', exact: true })).toBeVisible()
  const billing = await page.request.get(`${baseURL}/api/billing/plans`)
  expect(billing.status()).toBe(200)
  const plans = await billing.json() as Array<{ id: string; name: string }>
  const paid = plans.find(plan => plan.id === 'growth')
  expect(paid).toBeDefined()
  await expect(page.getByRole('heading', { name: paid!.name, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get Growth', exact: true })).toHaveAttribute('href', '/signup?plan=growth&redirect=%2Fapi%2Fpost-login%3Fplan%3Dgrowth')
  // Homes are billed by count: Basic includes one, and each home on a paid plan is $4 a month.
  const cards = page.locator('[data-parity-section="plans"] [data-photo-state]')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0).locator('[data-plan-homes]')).toHaveText('1 home included')
  for (const index of [1, 2]) await expect(cards.nth(index).locator('[data-plan-homes]')).toContainText('$4 per home per month')
  await expect(page.locator('[data-parity-section="comparison"] tr[data-feature-id="homes.included"] td')).toHaveText([
    '1 home',
    '$4 per home per month',
    '$4 per home per month',
  ])
})
