import { expect, test } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, seededSiteURL, testBaseUrl } from './test-env'

// Tenant behaviour that writes content or reads local-only routing. Real
// customer content is checked read-only against deployed sites in tests/deployed.

test('unknown sites render an unbranded 404 while resolved tenant errors retain their identity', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const unknown = await openTenantPage(page, `${testBaseUrl()}/`, { 'x-preview-tenant': 'no-such-organization' })
  expect(unknown?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  await expect(page.getByText('Error 404', { exact: true })).toBeVisible()
  const practice = seededTenant('legal')
  expect(await page.locator('body').innerText()).not.toMatch(new RegExp(`Krabi[Cc]law|${seededTenant('restaurant').name}|${practice.name}`))
  await page.unrouteAll()
  const missing = await openTenantPage(page, `${seededSiteURL('legal')}/no-such-page`, seededSiteHeaders('legal'))
  expect(missing?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: practice.name, exact: true })).toBeVisible()
  const unsupported = await page.goto(`${seededSiteURL('legal')}/templates`)
  expect(unsupported?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('the platform publishes its localized homepage and includes its canonical URL in the sitemap', async ({ page, request, baseURL }) => {
  const translations = [
    ['ja', 'ウェブサイトを数分で公開'],
    ['zh-Hans', '几分钟内发布网站'],
    ['zh-Hant', '幾分鐘內發佈網站'],
  ] as const
  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.status()).toBe(200)
  const xml = await sitemap.text()
  for (const [locale, heading] of translations) {
    const response = await page.goto(`/${locale}/`)
    expect(response?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    const canonical = new URL(`/${locale}`, baseURL).href
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonical)
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute('href', new URL('/', baseURL).href)
    for (const [alternate] of translations) {
      await expect(page.locator(`link[rel="alternate"][hreflang="${alternate}"]`)).toHaveAttribute('href', new URL(`/${alternate}`, baseURL).href)
    }
    expect(xml).toContain(`<loc>${canonical}</loc>`)
  }
  expect(xml).not.toContain(`<loc>${new URL('/zz', baseURL).href}</loc>`)
  const unknown = await request.get('/zz/')
  expect(unknown.status()).toBe(404)
})

test('tenant blog search opens an article from its body and excludes another tenant', async ({ page, request }) => {
  const articleTitle = 'Preparing for your legal consultation'
  await openTenantPage(page, new URL('/blog', seededSiteURL('legal')).href, seededSiteHeaders('legal'))
  await waitForNuxtHydration(page)
  await page.getByRole('button', { name: /search/i }).filter({ visible: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill('relevant documents')
  await dialog.getByRole('button', { name: new RegExp(articleTitle) }).click()
  await expect(page).toHaveURL(/\/blog\/preparing-for-your-legal-consultation/)
  await expect(page.getByRole('heading', { name: articleTitle, exact: true })).toBeVisible()

  const otherSite = await request.get('/api/public/search', {
    headers: seededSiteHeaders('restaurant'),
    params: { surface: 'tenant_blog', q: 'relevant documents' },
  })
  expect(otherSite.status(), await otherSite.text()).toBe(200)
  await expect(otherSite.json()).resolves.toMatchObject({ results: [] })
})

test('dashboard search opens the signed-in business’s record', async ({ page, baseURL }) => {
  const tenant = seededTenant('legal')
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
  await page.goto(`/dashboard/${tenant.slug}/menu`)
  await waitForNuxtHydration(page)
  await page.getByTestId('dashboard-search').click()
  const dialog = page.getByRole('dialog', { name: 'Search' })
  await dialog.getByPlaceholder('Search…').fill('Preparing for your legal consultation')
  const result = dialog.getByText('Preparing for your legal consultation', { exact: true })
  await expect(result).toBeVisible()
  await result.click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${tenant.slug}/website/blog/`))

  const otherSite = await page.request.get('/api/dashboard/search', {
    params: { org: seededTenant('restaurant').slug, q: 'seasonal dishes' },
  })
  expect(otherSite.status(), await otherSite.text()).toBe(404)
})

test('ChowBot uses Blawby’s domain setup guidance to answer a paraphrased question', async ({ page }) => {
  test.slow()
  await page.goto('/help')
  await waitForNuxtHydration(page)
  await page.getByPlaceholder('Ask ChowBot anything...').fill('What DNS records do I need to point my domain at my site?')
  const response = page.waitForResponse(result => result.url().endsWith('/api/public/help/agent'))
  await page.getByRole('button', { name: 'Send message' }).click()
  const answer = await response
  expect(answer.status(), await answer.text()).toBe(200)
  const body = await answer.json()
  expect(body.citations).toEqual(expect.arrayContaining([expect.objectContaining({
    id: 'faq:custom-domain',
    snippet: expect.stringContaining('add the DNS records Blawby provides'),
  })]))
  expect(body.reply).toMatch(/DNS/i)
  await expect(page.locator('.prose').filter({ hasText: /DNS/i })).toBeVisible()
})
