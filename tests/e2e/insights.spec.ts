import { expect, test, type Request } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { seededTenant } from './seed/manifest'

const isInsightsRead = (request: Request) => request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/dashboard/insights')

test('an Insights page switches its number in the URL and a return within the live connection reads nothing', async ({ page, baseURL }) => {
  const org = `/dashboard/${seededTenant('restaurant').slug}/insights`
  await loginAs(page.request, baseURL!)
  const socketCapture = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/api/dashboard/guest-inbox/socket' })
  expect((await page.goto(`${org}/conversion/page-views`))?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await dismissPreviewToolbar(page)
  const socket = await socketCapture
  const chart = page.getByTestId('insights-chart')
  await expect(chart.getByRole('heading', { name: 'Page views', exact: true })).toBeVisible()

  // Top pages is read in the browser, once, while the socket is open.
  const topPagesRead = page.waitForResponse(response => isInsightsRead(response.request()) && new URL(response.url()).pathname === '/api/dashboard/insights/conversion/top-pages')
  await page.getByTestId('insights-page-conversion-top-pages').click()
  expect((await topPagesRead).status()).toBe(200)
  await expect(page).toHaveURL(new RegExp(`${org}/conversion/top-pages$`))
  await expect(page).toHaveTitle('Top pages - Insights')
  await expect(chart.getByRole('heading', { name: 'Page views', exact: true })).toBeVisible()

  let reads = 0
  const countRead = (request: Request) => { if (isInsightsRead(request)) reads++ }
  page.on('request', countRead)
  try {
    // A headline number is a link: it switches the chart and its title without reading the page again, and Back switches it back.
    await page.getByTestId('insights-metric-link-pages_viewed').click()
    await expect(page).toHaveURL(new RegExp(`${org}/conversion/top-pages\\?metric=pages_viewed$`))
    await expect(chart.getByRole('heading', { name: 'Pages viewed', exact: true })).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`${org}/conversion/top-pages$`))
    await expect(chart.getByRole('heading', { name: 'Page views', exact: true })).toBeVisible()
    expect(reads).toBe(0)
  } finally { page.off('request', countRead) }

  // Another page is read; Back returns to Top pages as it was, with no read.
  const pageViewsRead = page.waitForResponse(response => isInsightsRead(response.request()) && new URL(response.url()).pathname === '/api/dashboard/insights/conversion/page-views')
  await page.getByTestId('insights-page-conversion-page-views').click()
  expect((await pageViewsRead).status()).toBe(200)
  await expect(page).toHaveURL(new RegExp(`${org}/conversion/page-views$`))
  reads = 0
  page.on('request', countRead)
  try {
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`${org}/conversion/top-pages$`))
    await expect(page.getByTestId('insights-list').getByRole('cell', { name: '/', exact: true })).toBeVisible()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(socket.isClosed()).toBe(false)
    expect(reads).toBe(0)
  } finally { page.off('request', countRead) }
})
