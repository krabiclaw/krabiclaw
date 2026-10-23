import { expect, test } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { testBaseUrl } from './test-env'

// Real page + canonical billing endpoint. No routes replace billing or CMS data.
test('pricing desktop exposes provider details after one reveal and does not replay', async ({ page }) => {
  const response = await openTenantPage(page, `${testBaseUrl()}/pricing`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  const cards = page.locator('[data-parity-section="plans"] [data-photo-state]')
  await expect(cards).toHaveCount(3)
  for (const card of await cards.all()) await expect(card).toHaveAttribute('data-photo-state', 'details')
  const authored = await page.request.get(`${testBaseUrl()}/api/public/pages?path=%2Fpricing`)
  expect(authored.status()).toBe(200)
  const document = await authored.json()
  expect(JSON.stringify(document), 'complete canonical pricing document').toContain('billing_features')
  const comparison = page.locator('[data-parity-section="comparison"]')
  await expect(comparison).toBeVisible()
  await expect(comparison.locator('tr[data-feature-id]')).toHaveCount(32)
  const locations = comparison.locator('tr[data-feature-id="locations.included"]')
  await expect(locations.locator('td')).toHaveText([
    '2 included',
    '2 included, then $49 per additional location per month',
    '2 included, then $49 per additional location per month',
  ])
  // Homes are billed apart from locations: 2 included, then $9 each on a paid plan.
  const homes = comparison.locator('tr[data-feature-id="homes.included"]')
  await expect(homes).toContainText('Homes')
  await expect(homes.locator('td')).toHaveText([
    '2 included',
    '2 included, then $9 per additional home per month',
    '2 included, then $9 per additional home per month',
  ])
  // Locations and homes are the counts billed: no plan has a rental-unit row.
  await expect(comparison.locator('tr[data-feature-id="rental-units.included"]')).toHaveCount(0)
  const teamAvailability = comparison.locator('tr[data-feature-id="bookings.member-availability"]')
  await expect(teamAvailability).toContainText('Team availability')
  await expect(teamAvailability.locator('td')).toHaveCount(3)
  for (const plan of await teamAvailability.locator('td').all()) await expect(plan).toContainText('Included')
  await expect(comparison.locator('.kc-pricing-comparison__included svg').first()).toBeVisible()
  const languages = comparison.locator('tr[data-feature-id="content.additional-locales"]')
  await expect(languages.locator('td .sr-only')).toHaveText(['Not included', 'Included', 'Included'])
  const payments = comparison.locator('tr[data-feature-id="payments.acceptance"]')
  await expect(payments.locator('td .sr-only')).toHaveText(['Not included', 'Not included', 'Included'])
  const ads = comparison.locator('tr[data-feature-id="ads.google"]')
  await expect(ads.locator('td .sr-only')).toHaveText(['Not included', 'Not included', 'Included'])
  const explanation = payments.locator('details')
  await explanation.locator('summary').click()
  await expect(explanation.locator('p')).toBeVisible()
  await expect(explanation.locator('p')).toHaveText('1.4% of payment volume, plus Stripe fees, billed on your subscription at the end of each month. Set up your Stripe account to accept payments.')
  await explanation.locator('summary').click()
  await expect(page.getByRole('heading', { name: 'Build your online home', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Keep it current', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Grow when you’re ready', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ready for your next chapter?', exact: true })).toBeVisible()

  const billing = await page.request.get(`${testBaseUrl()}/api/billing/plans`)
  expect(billing.status()).toBe(200)
  const plans = await billing.json() as Array<{ id: string; name: string; prices: Array<{ amount: number; currency: string; interval: string }> }>
  expect(plans.map(plan => plan.id)).toEqual(['free', 'growth', 'business'])
  for (const [index, plan] of plans.entries()) await expect(cards.nth(index).getByRole('heading', { name: plan.name, exact: true })).toBeVisible()
  const business = plans.find(plan => plan.id === 'business')!
  expect(business.prices).toEqual([expect.objectContaining({ amount: 14900, currency: 'usd', interval: 'month' })])
  await expect(cards.nth(2).locator('.kc-plan-price')).toHaveText('$149')
  await expect(cards.nth(0).locator('[data-plan-locations]')).toHaveText('2 locations included')
  for (const index of [1, 2]) await expect(cards.nth(index).locator('[data-plan-locations]')).toHaveText('2 locations included, then $49 per additional location per month')
  await expect(cards.nth(0).locator('[data-plan-homes]')).toHaveText('2 homes included')
  for (const index of [1, 2]) await expect(cards.nth(index).locator('[data-plan-homes]')).toHaveText('2 homes included, then $9 per additional home per month')
  await expect(page.getByText(/rental unit/i)).toHaveCount(0)
  // The services under the plans and the Markdown projection state the same add-ons from the same catalog.
  const addons = page.locator('[data-parity-section="add-ons"] .kc-pricing-addon')
  await expect(addons).toHaveCount(2)
  await expect(addons.nth(0).getByRole('heading', { name: 'Managed ads', exact: true })).toBeVisible()
  await expect(addons.nth(0).locator('.kc-pricing-addon__price')).toHaveText('10% of monthly ad spend')
  await expect(addons.nth(1).getByRole('heading', { name: 'SEO and marketing strategy', exact: true })).toBeVisible()
  await expect(addons.nth(1).locator('.kc-pricing-addon__price')).toHaveText('$2,000 per month')
  const markdown = await page.request.get(`${testBaseUrl()}/pricing.md`)
  expect(markdown.status()).toBe(200)
  const markdownText = await markdown.text()
  expect(markdownText).toContain('- **SEO and marketing strategy**: $2,000 per month.')
  expect(markdownText).toContain('- **Price**: $149/month')
  expect(markdownText).toContain('- **Locations**: 2 included, then $49 per additional location per month')
  expect(markdownText).not.toMatch(/rental unit/i)
  const sharedPrimary = page.getByRole('link', { name: 'Start free', exact: true }).first()
  const primaryColors = await sharedPrimary.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })
  for (const card of await cards.all()) {
    const colors = await card.getByRole('link').evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, color: style.color }
    })
    expect(colors).toEqual(primaryColors)
  }
  for (const [index, plan] of plans.entries()) {
    if (plan.id === 'free') continue
    const target = new URL((await cards.nth(index).getByRole('link').getAttribute('href'))!, testBaseUrl())
    expect(target.pathname).toBe('/signup')
    expect(target.searchParams.get('plan')).toBe(plan.id)
    expect(target.searchParams.get('redirect')).toBe(`/api/post-login?plan=${plan.id}`)
  }
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.evaluate(() => window.scrollTo(0, 100))
  await expect(page.locator('[data-photo-state="flipping"]')).toHaveCount(0)
})

test('pricing mobile stacks readable plans, contains overflow, and respects reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const response = await openTenantPage(page, `${testBaseUrl()}/pricing`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  const rail = page.locator('.kc-pricing-plans__rail')
  const cards = rail.locator('[data-photo-state]')
  await expect(cards).toHaveCount(3)
  await expect(page.locator('[data-photo-state="flipping"]')).toHaveCount(0)
  const geometry = await rail.evaluate(element => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    cards: Array.from(element.children, card => {
      const bounds = card.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    }),
    pageWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  expect(geometry.scrollWidth).toBe(geometry.width)
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport + 1)
  for (const card of geometry.cards) {
    expect(card.left).toBeGreaterThanOrEqual(20)
    expect(card.right).toBeLessThanOrEqual(geometry.viewport - 20)
  }
  for (let index = 1; index < geometry.cards.length; index++) {
    expect(geometry.cards[index]!.left).toBe(geometry.cards[0]!.left)
    expect(geometry.cards[index]!.top).toBeGreaterThan(geometry.cards[index - 1]!.bottom)
  }
  await cards.nth(1).scrollIntoViewIfNeeded()
  await expect(cards.nth(1).getByRole('link')).toBeVisible()
  await cards.nth(2).scrollIntoViewIfNeeded()
  await expect(cards.nth(2).getByRole('heading', { name: 'Business', exact: true })).toBeVisible()
  await expect(cards.nth(2).getByRole('link', { name: 'Get Business', exact: true })).toBeVisible()
})

test('pricing keyboard focus exposes the action immediately', async ({ page }) => {
  const response = await openTenantPage(page, `${testBaseUrl()}/pricing`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  const card = page.locator('[data-photo-state]').first()
  const action = card.getByRole('link')
  await action.focus()
  await expect(action).toBeFocused()
  await expect(card).toHaveAttribute('data-photo-state', 'details')
  await expect(action).toBeVisible()
})

test('pricing remains readable with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  try {
    const response = await page.goto(`${testBaseUrl()}/pricing`)
    expect(response?.status()).toBe(200)
    const cards = page.locator('[data-photo-state="details"]')
    await expect(cards).toHaveCount(3)
    await expect(cards.first().getByRole('heading')).toBeVisible()
    await expect(cards.first().getByRole('link')).toBeVisible()
    await expect(cards.nth(2).getByRole('heading', { name: 'Business', exact: true })).toBeVisible()
    await expect(cards.nth(2).locator('.kc-plan-price')).toHaveText('$149')
    await expect(cards.nth(0).locator('[data-plan-locations]')).toHaveText('2 locations included')
    for (const index of [1, 2]) await expect(cards.nth(index).locator('[data-plan-locations]')).toHaveText('2 locations included, then $49 per additional location per month')
    await expect(cards.nth(0).locator('[data-plan-homes]')).toHaveText('2 homes included')
    for (const index of [1, 2]) await expect(cards.nth(index).locator('[data-plan-homes]')).toHaveText('2 homes included, then $9 per additional home per month')
    await expect(cards.nth(2).getByRole('link', { name: 'Get Business', exact: true })).toHaveAttribute('href', '/signup?plan=business&redirect=%2Fapi%2Fpost-login%3Fplan%3Dbusiness')
    await expect(page.locator('[data-price-unavailable]')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
