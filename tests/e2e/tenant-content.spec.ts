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
