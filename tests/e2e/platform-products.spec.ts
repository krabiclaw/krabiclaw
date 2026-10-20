import { expect, test } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { testBaseUrl } from './test-env'

test('Products retains its authored content, media and canonical identity after hydration', async ({ page, request }) => {
  const legacy = await request.get(`${testBaseUrl()}/features?source=legacy`, { maxRedirects: 0 })
  expect(legacy.status()).toBe(301)
  expect(legacy.headers().location).toBe('/products?source=legacy')
  const response = await openTenantPage(page, `${testBaseUrl()}/products`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your website is\njust the beginning.')
  await expect(page.getByRole('heading', { name: /^Customer messages,\s+in one place\.$/ })).toBeVisible()
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${testBaseUrl()}/products`)
  const graph = await page.locator('script[type="application/ld+json"]').allTextContents()
  expect(graph.join('')).toContain(`${testBaseUrl()}/products#webpage`)
  const images = page.locator('.kc-products-page img')
  expect(await images.count()).toBe(10)
  const sceneImages = page.locator('.kc-product-scene__art')
  expect(await sceneImages.count()).toBe(2)
  expect(await sceneImages.nth(0).getAttribute('src')).not.toBe(await sceneImages.nth(1).getAttribute('src'))
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
  }
  for (const anchor of [
    { label: 'Build', id: 'products-website-builder', heading: /^Build your\s+business website\.$/ },
    { label: 'Manage', id: 'products-management', heading: /^AI website\s+management\.$/ },
    { label: 'Connect', id: 'products-inbox', heading: /^Customer messages,\s+in one place\.$/ },
    { label: 'Grow', id: 'products-content-social', heading: /^Publishing and\s+social posts\.$/ },
  ]) {
    await page.getByRole('navigation', { name: 'Products', exact: true }).getByRole('link', { name: anchor.label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#${anchor.id}$`))
    await expect(page.getByRole('heading', { name: anchor.heading, exact: true })).toBeInViewport()
  }
})

test('Products remains readable on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openTenantPage(page, `${testBaseUrl()}/products`, {})
  await waitForNuxtHydration(page)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('navigation', { name: 'Products', exact: true }).getByRole('link', { name: 'Grow', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^Publishing and\s+social posts\.$/ })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Products section links reach their relevant published destinations', async ({ page }) => {
  const destinations = [
    { label: 'Explore website builder', path: '/templates', heading: /Your business\.\s*Its own kind of beautiful\./ },
    { label: 'Explore AI management', path: '/plugin', heading: /^Your website\.\s*Your assistant\.$/ },
    { label: 'Read the inbox guide', path: '/docs/handle-inquiries-and-reservation-requests', heading: /Handle inquiries and reservation requests/ },
    { label: 'Explore Calendar and bookings', path: '/docs/category/calendar-and-bookings', heading: /Calendar and bookings/ },
    { label: 'Read the publishing guide', path: '/docs/publish-a-post', heading: /Publish a post/ },
    { label: 'Manage local business details', path: '/docs/update-locations-and-hours', heading: /Update locations and hours/ },
    { label: 'Read the analytics guide', path: '/docs/read-your-site-analytics', heading: /Read your site analytics/ },
  ]
  for (const destination of destinations) {
    await openTenantPage(page, `${testBaseUrl()}/products`, {})
    await waitForNuxtHydration(page)
    await page.getByRole('link', { name: destination.label, exact: false }).click()
    await expect(page).toHaveURL(`${testBaseUrl()}${destination.path}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(destination.heading)
  }
})
