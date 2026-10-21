import { expect, test } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { insightsPath } from '../../server/utils/dashboard-links'
import { CONVERSION_EVENT_CATALOG, ORGANIZATION_CONVERSION_EVENT_NAMES, type ConversionEventDefinition } from '../../utils/organization-conversion-events'

// A closed month of the pulled production snapshot, so each business's funnel is its real traffic.
const range = { startDate: '2026-09-21', endDate: '2026-10-20' }
const businesses = [
  { user: 'user-e2e-ncls-owner', org: 'org-ncls-blawby', slug: 'north-carolina-legal-services', words: ['Viewed a practice area', 'Clicked Book a consultation', 'Requested a consultation', 'Scheduled'] },
  { user: 'user-e2e-kikuzuki-owner', org: 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX', slug: 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX', words: ['Viewed a dish', 'Started a reservation', 'Reserved', 'Seated'] },
  { user: 'user-e2e-pottery-owner', org: 'org-user-pottery-house', slug: 'org-user-pottery-house', words: ['Viewed', 'Started checkout', 'Booked', 'Confirmed'] },
] as const
const steps = ['viewed', 'intent', 'submitted'] as const
const count = (value: number) => new Intl.NumberFormat('en-US').format(value)
const cellCount = (text: string) => text === '—' ? 0 : Number(text.split(' · ')[0]!.replaceAll(',', ''))

for (const business of businesses) {
  test(`Insights shows ${business.slug} its funnel from visit to request, by source`, async ({ page, baseURL }) => {
    await dismissPreviewToolbar(page)
    await loginAs(page.request, baseURL!, business.user)
    expect((await page.goto(insightsPath(business.slug, range)))?.status()).toBe(200)
    await waitForNuxtHydration(page)

    // The expected counts are read through the analytics query MCP exposes, not the report the page renders.
    const query = async (args: Record<string, unknown>) => {
      const response = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'query_organization_analytics', args: { organization_id: business.org, mode: 'breakdown', start_date: range.startDate, end_date: range.endDate, limit: 200, ...args } })
      expect(response.status()).toBe(200)
      return mcpData<{ rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, number> }>; next_cursor: string | null; totals: Record<string, { value: number }> }>(await response.json())
    }
    const visits = (await query({ filters: { kind: 'pageview' }, dimensions: ['locale'], metrics: ['sessions'] })).totals.sessions!.value
    const byEvent = await query({ dimensions: ['event_name'], metrics: ['events'] })
    expect(byEvent.next_cursor).toBeNull()
    const expected = Object.fromEntries(steps.map(step => [step, byEvent.rows
      .filter(row => ORGANIZATION_CONVERSION_EVENT_NAMES.some(name => name === row.dimensions.event_name && (CONVERSION_EVENT_CATALOG[name] as ConversionEventDefinition).funnel === step))
      .reduce((sum, row) => sum + row.metrics.events!, 0)])) as Record<typeof steps[number], number>
    expect(visits, 'the snapshot carries this business’s visits').toBeGreaterThan(0)
    expect(expected.viewed, 'the snapshot carries this business’s offering views').toBeGreaterThan(0)
    expect(expected.submitted, 'the snapshot carries this business’s requests').toBeGreaterThan(0)

    const funnel = page.getByTestId('insights-funnel')
    await expect(funnel.getByRole('heading', { name: 'Funnel', level: 2 })).toBeVisible()
    await expect(funnel.getByTestId('insights-funnel-visits')).toHaveText(new RegExp(`^Visits\\s*${count(visits)}$`))
    for (const [index, step] of steps.entries()) {
      const row = funnel.getByTestId(`insights-funnel-${step}`)
      await expect(row.getByText(business.words[index]!, { exact: true })).toBeVisible()
      // A step with nothing recorded reads "—"; otherwise its count and its rate from the step before.
      await expect(row).toContainText(expected[step] ? new RegExp(`\\s${count(expected[step])} · [\\d.,]+%$`) : /\s—$/)
    }
    await expect(funnel.getByTestId('insights-funnel-confirmed').getByText(business.words[3], { exact: true })).toBeVisible()

    // Every counted event lands in exactly one source row, so each step's column adds up to its total.
    const bySource = funnel.getByTestId('insights-funnel-by-source')
    await expect(bySource.locator('tbody tr').first()).toBeVisible()
    for (const [index, step] of steps.entries()) {
      const cells = await bySource.locator(`tbody tr td:nth-child(${index + 3})`).allTextContents()
      expect(cells.reduce((sum, text) => sum + cellCount(text.trim()), 0), `${step} by source`).toBe(expected[step])
    }
    const visitCells = await bySource.locator('tbody tr td:nth-child(2)').allTextContents()
    expect(visitCells.reduce((sum, text) => sum + cellCount(text.trim()), 0), 'visits by source').toBe(visits)
  })
}
