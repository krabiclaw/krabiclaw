import { expect, test } from '@playwright/test'
import { openTenantPage } from './helpers'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, seededSiteURL } from './test-env'

// These browser cases verify collector transport and source context. Native log
// recording is checked independently in the suite's PLAYWRIGHT_SERVER_LOGS output.
test('anonymous tenant detail failures reach browser error collection with their source request and no private data', async ({ page }) => {
  const studio = seededTenant('experience')
  const experience = studio.products['wheel-class']!
  await openTenantPage(page, `${seededSiteURL('experience')}/experiences`, seededSiteHeaders('experience'))
  await expect(page.locator('main').getByRole('heading').first()).toContainText(studio.name)
  const sourceRequestId = 'tenant-detail-failure-e2e'
  await page.route(`**/api/public/experiences/${experience.slug}?*`, route => route.fulfill({
    status: 500,
    headers: { 'x-request-id': sourceRequestId },
    json: {
      success: false,
      error: {
        code: 'PRODUCT_LOOKUP_FAILED',
        message: 'Product lookup failed for guest@example.test; Bearer detail-secret; /api/private?token=query-secret',
        requestId: sourceRequestId,
      },
    },
  }))
  const collected = page.waitForResponse(response => {
    const request = response.request()
    return new URL(response.url()).pathname === '/api/browser-errors'
      && request.method() === 'POST'
      && request.postDataJSON()?.error_chain?.some((entry: { request_id?: string }) => entry.request_id === sourceRequestId)
  })

  await page.locator(`main a[href^="/experiences/${experience.slug}"]`).first().click()

  await expect(page.getByText('Error 500', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Something went wrong', exact: true })).toBeVisible()
  const response = await collected
  const request = response.request()
  const report = request.postDataJSON()
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ recorded: true, event_id: report.event_id })
  expect(report.page_path).toBe(`/experiences/${experience.slug}`)
  expect(['app_error', 'vue_error']).toContain(report.source)
  expect(report.error_chain).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 500, request_id: sourceRequestId, code: 'PRODUCT_LOOKUP_FAILED' }),
  ]))
  expect(JSON.stringify(report)).toContain('Product lookup failed')
  expect(JSON.stringify(report)).not.toMatch(/guest@example|detail-secret|query-secret/)
  const sentHeaders = await request.allHeaders()
  expect(sentHeaders.authorization).toBeUndefined()
  expect(sentHeaders.cookie).toBeUndefined()
  expect(sentHeaders.referer).toBeUndefined()
})
