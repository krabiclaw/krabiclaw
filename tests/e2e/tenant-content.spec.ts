import { expect, test } from '@playwright/test'
import { openTenantPage } from './helpers'
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
