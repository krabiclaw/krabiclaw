import { expect, test, type Page } from '@playwright/test'
import { BROWSER_ERROR_LIMITS } from '../../shared/error-telemetry'
import {
  blawbyBaseURL, blawbyExtraHeaders,
  openTenantPage, potteryHouseBaseURL, potteryHouseExtraHeaders,
} from './helpers'
import { kikuzukiTestBaseUrl, kikuzukiTestExtraHeaders } from './test-env'

async function clientJourney(page: Page, options: {
  baseURL: string
  headers: Record<string, string>
  listPath: string
  listHeading: RegExp
  detailPath: string
  detailText: RegExp
}) {
  await openTenantPage(page, `${options.baseURL}/`, options.headers)
  await expect(page.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
  await page.locator(`a[href="${options.listPath}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`${options.listPath}/?$`))
  const main = page.locator('main')
  await expect(main.getByRole('heading').first()).toHaveText(options.listHeading)
  await main.locator(`a[href^="${options.detailPath}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`${options.detailPath}/?(?:\\?.*)?$`))
  await expect(main).toContainText(options.detailText)
}

test('Pottery home → experiences → experience detail', async ({ page }) => {
  await clientJourney(page, {
    baseURL: potteryHouseBaseURL, headers: potteryHouseExtraHeaders,
    listPath: '/experiences', listHeading: /Pottery House Krabi Experiences/i,
    detailPath: '/experiences/pottery-wheel-class', detailText: /Pottery Wheel Class/i,
  })
})

test('Kikuzuki home → menu → menu item', async ({ page }) => {
  await clientJourney(page, {
    baseURL: kikuzukiTestBaseUrl(), headers: kikuzukiTestExtraHeaders(),
    listPath: '/menu', listHeading: /Kikuzuki Krabi Thailand/i,
    detailPath: '/locations/kikuzuki-japanese-robatayaki-izakaya/menu/tuna-sushi', detailText: /Tuna Sushi/i,
  })
})

test('NCLS home → services → service detail', async ({ page }) => {
  await clientJourney(page, {
    baseURL: blawbyBaseURL, headers: blawbyExtraHeaders,
    listPath: '/services', listHeading: /Our Services/i,
    detailPath: '/services/family', detailText: /Family Law/i,
  })
})

test('anonymous tenant detail failures reach browser error collection with their source request and no private data', async ({ page }) => {
  await openTenantPage(page, `${potteryHouseBaseURL}/experiences`, potteryHouseExtraHeaders)
  await expect(page.locator('main').getByRole('heading').first()).toHaveText(/Pottery House Krabi Experiences/i)
  const sourceRequestId = 'tenant-detail-failure-e2e'
  await page.route('**/api/public/experiences/pottery-wheel-class?*', route => route.fulfill({
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

  await page.locator('main a[href^="/experiences/pottery-wheel-class"]').first().click()

  await expect(page.getByText('Error 500', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Something went wrong', exact: true })).toBeVisible()
  const response = await collected
  const request = response.request()
  const report = request.postDataJSON()
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ recorded: true, event_id: report.event_id })
  expect(report.page_path).toBe('/experiences/pottery-wheel-class')
  expect(['app_error', 'vue_error']).toContain(report.source)
  expect(report.error_chain).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 500, request_id: sourceRequestId, code: 'PRODUCT_LOOKUP_FAILED' }),
  ]))
  expect(JSON.stringify(report)).toContain('Product lookup failed')
  expect(JSON.stringify(report)).not.toMatch(/guest@example|detail-secret|query-secret/)
  expect(request.headers().authorization).toBeUndefined()
  expect(request.headers().cookie).toBeUndefined()
  expect(request.headers().referer).toBeUndefined()
})

test('NCLS service failures are collected through the app error hook', async ({ page }) => {
  await openTenantPage(page, `${blawbyBaseURL}/services`, blawbyExtraHeaders)
  await expect(page.locator('main').getByRole('heading').first()).toHaveText(/Our Services/i)
  const sourceRequestId = 'ncls-service-failure-e2e'
  await page.route(url => url.pathname === '/api/public/blawby/document'
    && url.searchParams.get('recipe') === 'page'
    && url.searchParams.get('slug') === '/services/family', route => route.fulfill({
    status: 500,
    headers: { 'x-request-id': sourceRequestId },
    json: { error: { code: 'SERVICE_LOOKUP_FAILED', message: 'Service document could not be loaded', requestId: sourceRequestId } },
  }))
  const collected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser-errors'
    && response.request().postDataJSON()?.error_chain?.some((entry: { request_id?: string }) => entry.request_id === sourceRequestId))

  await page.locator('main a[href^="/services/family"]').first().click()

  await expect(page.getByText('Error 500', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Something went wrong', exact: true })).toBeVisible()
  const response = await collected
  const report = response.request().postDataJSON()
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ recorded: true, event_id: report.event_id })
  expect(report.source).toBe('app_error')
  expect(report.page_path).toBe('/services/family')
  expect(report.error_chain).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 500, request_id: sourceRequestId, message: 'Service document could not be loaded' }),
  ]))
  expect(response.request().headers().cookie).toBeUndefined()
  expect(response.request().headers().authorization).toBeUndefined()
})

test('collector rejection is visible in the browser without recursively reporting itself', async ({ page }) => {
  await openTenantPage(page, `${potteryHouseBaseURL}/experiences`, potteryHouseExtraHeaders)
  await page.route('**/api/public/experiences/pottery-wheel-class?*', route => route.fulfill({
    status: 500,
    json: { message: 'Product lookup failed' },
  }))
  let collectionAttempts = 0
  await page.route('**/api/browser-errors', async (route) => {
    collectionAttempts++
    await route.fulfill({ status: 500, json: { message: 'Error collector unavailable' } })
  })
  const collectionFailure = page.waitForEvent('pageerror', {
    predicate: error => error.name === 'BrowserErrorNotRecorded',
  })

  await page.locator('main a[href^="/experiences/pottery-wheel-class"]').first().click()

  const error = await collectionFailure
  expect(error.message).toBe('Browser error was not recorded')
  await expect(page.getByText('Error 500', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Something went wrong', exact: true })).toBeVisible()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(collectionAttempts).toBe(1)
})

test('anonymous browser exceptions and unhandled rejections are collected without the page query', async ({ page }) => {
  await openTenantPage(page, `${potteryHouseBaseURL}/experiences?token=page-query-secret`, potteryHouseExtraHeaders)
  const browserError = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser-errors'
    && response.request().postDataJSON()?.source === 'browser_error')
  const unhandledRejection = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser-errors'
    && response.request().postDataJSON()?.source === 'unhandled_rejection'
    && response.request().postDataJSON()?.error_chain[0]?.message.startsWith('Unhandled rejection'))
  const reasonlessRejection = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser-errors'
    && response.request().postDataJSON()?.source === 'unhandled_rejection'
    && response.request().postDataJSON()?.error_chain[0]?.message === 'undefined')

  await page.evaluate(() => {
    setTimeout(() => { throw new Error('Browser exception for browser@example.test; Bearer exception-secret') }, 0)
    void Promise.reject(new Error('Unhandled rejection for promise@example.test; /private?token=rejection-secret'))
    void Promise.reject()
  })

  const responses = await Promise.all([browserError, unhandledRejection, reasonlessRejection])
  const expectedMessages = [/Browser exception/, /Unhandled rejection/, /^undefined$/]
  for (const [index, response] of responses.entries()) {
    const request = response.request()
    const report = request.postDataJSON()
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ recorded: true, event_id: report.event_id })
    expect(report.page_path).toBe('/experiences')
    expect(report.error_chain[0].message).toMatch(expectedMessages[index]!)
    expect(JSON.stringify(report)).not.toMatch(/browser@example|promise@example|exception-secret|rejection-secret|page-query-secret/)
    expect(request.headers().authorization).toBeUndefined()
    expect(request.headers().cookie).toBeUndefined()
    expect(request.headers().referer).toBeUndefined()
  }
  await expect(page.locator('main').getByRole('heading').first()).toHaveText(/Pottery House Krabi Experiences/i)
})

test('long Unicode rejection chains fit the native collector and preserve each cause', async ({ page }) => {
  await openTenantPage(page, `${potteryHouseBaseURL}/experiences`, potteryHouseExtraHeaders)
  const collected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser-errors'
    && response.request().postDataJSON()?.error_chain[0]?.request_id === 'unicode-browser-request-0')

  await page.evaluate(() => {
    let error: Error | undefined
    for (let index = 3; index >= 0; index--) {
      error = Object.assign(new Error(`Unicode rejection ${index} ${'ข้อมูล😀"\\\n\r\t\u0001'.repeat(1000)}`, { cause: error }), {
        name: `UnicodeRejection${index}`,
        code: `UNICODE_REJECTION_${index}`,
        statusCode: 500,
        requestId: `unicode-browser-request-${index}`,
        ray_id: `unicode-browser-ray-${index}`,
      })
    }
    void Promise.reject(error)
  })

  const response = await collected
  const request = response.request()
  const report = request.postDataJSON()
  expect(new TextEncoder().encode(request.postData()!).byteLength).toBeLessThanOrEqual(BROWSER_ERROR_LIMITS.bodyBytes)
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ recorded: true, event_id: report.event_id })
  expect(report.source).toBe('unhandled_rejection')
  expect(report.page_path).toBe('/experiences')
  expect(report.error_chain).toHaveLength(4)
  for (const [index, entry] of report.error_chain.entries()) {
    expect(entry).toMatchObject({
      name: `UnicodeRejection${index}`,
      code: `UNICODE_REJECTION_${index}`,
      status: 500,
      request_id: `unicode-browser-request-${index}`,
      ray_id: `unicode-browser-ray-${index}`,
    })
    expect(entry.message).toMatch(new RegExp(`^Unicode rejection ${index} `))
    expect(entry.message).toMatch(/\[truncated\]$/)
    expect(entry.stack).toMatch(/\[truncated\]$/)
  }
  await expect(page.locator('main').getByRole('heading').first()).toHaveText(/Pottery House Krabi Experiences/i)
})
