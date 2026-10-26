import { expect, test } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { insightsPath } from '../../server/utils/dashboard-links'
import type { AnalyticsReport } from '../../shared/analytics-report'
import { CONVERSION_EVENT_CATALOG, ORGANIZATION_CONVERSION_EVENT_NAMES, type ConversionEventDefinition } from '../../utils/organization-conversion-events'

// A closed month of the pulled production snapshot, so each business's report is its real activity.
const range = { startDate: '2026-09-21', endDate: '2026-10-20' }
const businesses = [
  { user: 'user-e2e-ncls-owner', org: 'org-ncls-blawby', slug: 'north-carolina-legal-services', requestDescription: 'Messages and requests recorded in this period, including consultation requests.' },
  { user: 'user-e2e-kikuzuki-owner', org: 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX', slug: 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX', requestDescription: 'Messages and requests recorded in this period, including reservation requests.' },
  { user: 'user-e2e-pottery-owner', org: 'org-user-pottery-house', slug: 'org-user-pottery-house', requestDescription: 'Messages and requests recorded in this period, including booking requests.' },
] as const
const eventSteps = ['viewed', 'intent', 'paid'] as const
const steps = ['visits', 'viewed', 'intent', 'submitted', 'confirmed', 'paid'] as const
const labels = ['Website visits', 'Content views', 'Booking and link actions', 'Requests received', 'Requests now confirmed', 'Payments received']
const count = (value: number) => new Intl.NumberFormat('en-US').format(value)
const cellCount = (text: string) => Number(text.split(' · ')[0]!.replaceAll(',', ''))

for (const business of businesses) {
  test(`Insights shows ${business.slug} its overview with activity and website details on demand`, async ({ page, baseURL }, testInfo) => {
    await dismissPreviewToolbar(page)
    await loginAs(page.request, baseURL!, business.user)
    expect((await page.goto(insightsPath(business.slug, range)))?.status()).toBe(200)
    await waitForNuxtHydration(page)

    // Visits and recorded events are checked independently through the analytics query.
    const query = async (args: Record<string, unknown>) => {
      const response = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'query_organization_analytics', args: { organization_id: business.org, mode: 'breakdown', start_date: range.startDate, end_date: range.endDate, limit: 200, ...args } })
      expect(response.status()).toBe(200)
      return mcpData<{ rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, number> }>; next_cursor: string | null; totals: Record<string, { value: number }> }>(await response.json())
    }
    const visits = (await query({ filters: { kind: 'pageview' }, dimensions: ['locale'], metrics: ['sessions'] })).totals.sessions!.value
    const byEvent = await query({ dimensions: ['event_name'], metrics: ['events'] })
    expect(byEvent.next_cursor).toBeNull()
    const eventCounts = Object.fromEntries(eventSteps.map(step => [step, byEvent.rows
      .filter(row => ORGANIZATION_CONVERSION_EVENT_NAMES.some(name => name === row.dimensions.event_name && (CONVERSION_EVENT_CATALOG[name] as ConversionEventDefinition).funnel === step))
      .reduce((sum, row) => sum + row.metrics.events!, 0)])) as Record<typeof eventSteps[number], number>
    // Raw submit events exclude checkout-created requests, so the former submit-event
    // expectation was wrong. These two cards render the canonical report's request cohort
    // and current confirmation status; the producer's counting invariant belongs in D1 tests.
    const reportResponse = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_organization_analytics', args: { organization_id: business.org, start_date: range.startDate, end_date: range.endDate } })
    expect(reportResponse.status()).toBe(200)
    const report = mcpData<AnalyticsReport>(await reportResponse.json())
    const expected = { visits, ...eventCounts, submitted: report.funnel.submitted, confirmed: report.funnel.confirmed }
    expect(visits, 'the snapshot carries this business’s visits').toBeGreaterThan(0)
    expect(expected.viewed, 'the snapshot carries this business’s offering views').toBeGreaterThan(0)
    expect(expected.submitted, 'the snapshot carries this business’s requests').toBeGreaterThan(0)

    const overview = page.getByTestId('insights-overview')
    await expect(overview.getByRole('heading', { name: 'At a glance', level: 2 })).toBeVisible()
    for (const key of ['submitted', 'confirmed', 'paid', 'visits'] as const) {
      await expect(overview.getByTestId(`insights-overview-${key}-count`)).toHaveText(count(expected[key]))
    }
    await expect(overview.getByTestId('insights-overview-submitted').getByText(business.requestDescription, { exact: true })).toBeVisible()
    await expect(overview.getByTestId('insights-overview-confirmed').getByText('Requests received in this period that are currently confirmed.', { exact: true })).toBeVisible()

    const activityDetails = page.getByTestId('insights-activity-details')
    const websiteDetails = page.getByTestId('insights-website-details')
    await expect(activityDetails).toHaveJSProperty('open', false)
    await expect(websiteDetails).toHaveJSProperty('open', false)
    const sourceSummary = page.getByTestId('insights-requests-by-source')
    await expect(sourceSummary).toBeVisible()
    const requestSourceCount = report.funnel.bySource.filter(row => row.submitted > 0).length
    await expect(sourceSummary.locator('tbody tr')).toHaveCount(Math.min(5, requestSourceCount))
    if (requestSourceCount > 5) {
      await page.getByRole('button', { name: `Show all ${requestSourceCount} sources`, exact: true }).click()
      await expect(sourceSummary.locator('tbody tr')).toHaveCount(requestSourceCount)
      await page.getByRole('button', { name: 'Show fewer', exact: true }).click()
      await expect(sourceSummary.locator('tbody tr')).toHaveCount(5)
    }

    await activityDetails.getByText('All recorded activity', { exact: true }).click()
    await expect(activityDetails).toHaveJSProperty('open', true)
    await expect(websiteDetails).toHaveJSProperty('open', false)
    const funnel = page.getByTestId('insights-funnel')
    for (const [index, step] of steps.entries()) {
      const row = funnel.getByTestId(`insights-funnel-${step}`)
      await expect(row.getByText(labels[index]!, { exact: true })).toBeVisible()
      const value = row.getByTestId(`insights-funnel-${step}-count`)
      await expect(value).toBeVisible()
      await expect(value).not.toContainText('%')
      if (step !== 'paid') await expect(value).toHaveText(count(expected[step]))
      expect(cellCount((await value.innerText()).trim()), `${step} total`).toBe(expected[step])
    }

    // Every activity count lands in exactly one source row, so each column adds up to its total.
    const bySource = funnel.getByTestId('insights-funnel-by-source')
    await expect(bySource.locator('tbody tr').first()).toBeVisible()
    for (const [index, step] of steps.entries()) {
      const cells = await bySource.locator(`tbody tr td:nth-child(${index + 2})`).allTextContents()
      expect(cells.reduce((sum, text) => sum + cellCount(text.trim()), 0), `${step} by source`).toBe(expected[step])
    }

    await activityDetails.getByText('All recorded activity', { exact: true }).click()
    await expect(activityDetails).toHaveJSProperty('open', false)
    await websiteDetails.getByText('Website details', { exact: true }).click()
    await expect(websiteDetails).toHaveJSProperty('open', true)
    await expect(websiteDetails.getByRole('group', { name: 'Website visits by day', exact: true })).toBeVisible()
    await websiteDetails.getByTestId('insights-chart-pageViews').click()
    await expect(websiteDetails.getByRole('group', { name: 'Page views by day', exact: true })).toBeVisible()
    await websiteDetails.getByTestId('insights-chart-visits').click()
    if (report.topPages.length > 5) {
      const topPages = websiteDetails.locator('#insights-top-pages tbody tr')
      await expect(topPages).toHaveCount(5)
      await websiteDetails.getByRole('button', { name: `Show all ${report.topPages.length} pages`, exact: true }).click()
      await expect(topPages).toHaveCount(report.topPages.length)
      await websiteDetails.getByRole('button', { name: 'Show fewer pages', exact: true }).click()
      await expect(topPages).toHaveCount(5)
    }
    await websiteDetails.getByText('Website details', { exact: true }).click()
    await expect(websiteDetails).toHaveJSProperty('open', false)
    await page.setViewportSize({ width: 1280, height: 900 })
    await testInfo.attach('insights-desktop', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(overview).toBeVisible()
    await expect(activityDetails).toHaveJSProperty('open', false)
    await expect(websiteDetails).toHaveJSProperty('open', false)
    await testInfo.attach('insights-mobile', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  })
}

