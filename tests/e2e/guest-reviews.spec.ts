import { expect, test, type APIResponse } from '@playwright/test'
import type { InsightsPage } from '../../shared/insights'
import { loginAs } from './helpers/auth'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'

const baseURL = testBaseUrl()
// Clayhouse Studio: its seed leaves one instant class booking whose session has ended.
const studio = () => seededTenant('experience')
const ownerId = 'user-e2e-pottery-owner'

async function body<T>(response: APIResponse, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return await response.json() as T
}

test('Quality reads guest feedback, private feedback included, for the range', async ({ page }) => {
  const { slug } = studio()
  await loginAs(page.request, baseURL, ownerId)
  const quality = await body<InsightsPage>(await page.request.get('/api/dashboard/insights/quality/overall-rating', { params: { org: slug } }), 200)
  expect(quality.list?.kind).toBe('reviews')
  expect((await page.request.get('/api/dashboard/insights/quality/overall-rating', { params: { org: slug, start_date: '2020-01-01' } })).status()).toBe(400)

  await page.goto(`/dashboard/${slug}/insights/quality/overall-rating`)
  await waitForNuxtHydration(page)
  await expect(page.getByRole('heading', { name: 'Overall rating', exact: true }).first()).toBeVisible()
  // The page draws the number as the read wrote it.
  await expect(page.getByTestId('insights-metric-overall_rating')).toHaveText(quality.metrics.find(metric => metric.key === 'overall_rating')!.display)
})

test('a review link opens the one review address, and an unknown link says it is unavailable', async ({ page }) => {
  await openTenantPage(page, `${baseURL}/locations/${studio().locations['ao-nang']!.slug}/review-submit?token=not-a-real-token`, seededSiteHeaders('experience'))
  expect(new URL(page.url()).pathname).toBe('/review-submit')
  expect(new URL(page.url()).searchParams.get('token')).toBe('not-a-real-token')
  await expect(page.getByRole('heading', { name: 'This review link is not available' })).toBeVisible()
})
