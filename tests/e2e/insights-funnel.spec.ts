import { expect, test } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { seededTenant } from './seed/manifest'
import { insightsPath } from '../../server/utils/dashboard-links'
import { CONVERSION_EVENT_CATALOG, ORGANIZATION_CONVERSION_EVENT_NAMES, type ConversionEventDefinition } from '../../utils/organization-conversion-events'

// The seed's guest visits and contact messages happen today; the range ends today in the businesses' clocks.
const today = new Date().toISOString().slice(0, 10)
const range = { startDate: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10), endDate: today }
const businesses = [
  { user: 'user-e2e-ncls-owner', key: 'legal', words: ['Viewed a practice area', 'Clicked Book a consultation', 'Requested a consultation', 'Scheduled'] },
  { user: 'user-e2e-kikuzuki-owner', key: 'restaurant', words: ['Viewed a dish', 'Started a reservation', 'Reserved', 'Seated'] },
  { user: 'user-e2e-pottery-owner', key: 'experience', words: ['Viewed', 'Started checkout', 'Booked', 'Confirmed'] },
] as const
const steps = ['viewed', 'intent', 'submitted'] as const
const count = (value: number) => new Intl.NumberFormat('en-US').format(value)
const cellCount = (text: string) => text === '—' ? 0 : Number(text.split(' · ')[0]!.replaceAll(',', ''))

for (const business of businesses) {
  test(`Insights shows the ${business.key} business its funnel from visit to request, by source`, async ({ page, baseURL }) => {
    const { organizationId, slug } = seededTenant(business.key)
    await dismissPreviewToolbar(page)
    await loginAs(page.request, baseURL!, business.user)
    expect((await page.goto(insightsPath(slug, range)))?.status()).toBe(200)
    await waitForNuxtHydration(page)

    // The expected counts are read through the analytics query MCP exposes, not the report the page renders.
    const query = async (args: Record<string, unknown>) => {
      const response = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'query_organization_analytics', args: { organization_id: organizationId, mode: 'breakdown', start_date: range.startDate, end_date: range.endDate, limit: 200, ...args } })
      expect(response.status()).toBe(200)
      return mcpData<{ rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, number> }>; next_cursor: string | null; totals: Record<string, { value: number }> }>(await response.json())
    }
    const visits = (await query({ filters: { kind: 'pageview' }, dimensions: ['locale'], metrics: ['sessions'] })).totals.sessions!.value
    const byEvent = await query({ dimensions: ['event_name'], metrics: ['events'] })
    expect(byEvent.next_cursor).toBeNull()
    const expected = Object.fromEntries(steps.map(step => [step, byEvent.rows
      .filter(row => ORGANIZATION_CONVERSION_EVENT_NAMES.some(name => name === row.dimensions.event_name && (CONVERSION_EVENT_CATALOG[name] as ConversionEventDefinition).funnel === step))
      .reduce((sum, row) => sum + row.metrics.events!, 0)])) as Record<typeof steps[number], number>
    expect(visits, 'the seed visits this business').toBeGreaterThan(0)
    expect(expected.viewed, 'the seed views this business’s offering').toBeGreaterThan(0)
    expect(expected.submitted, 'the seed sends this business a message').toBeGreaterThan(0)

    const funnel = page.getByTestId('insights-funnel')
    await expect(funnel.getByRole('heading', { name: 'Funnel', level: 2 })).toBeVisible()
    await expect(funnel.getByTestId('insights-funnel-visits')).toHaveText(new RegExp(`^Visits\\s*${count(visits)}$`))
    for (const [index, step] of steps.entries()) {
      const row = funnel.getByTestId(`insights-funnel-${step}`)
      await expect(row.getByText(business.words[index]!, { exact: true })).toBeVisible()
      // A step with nothing recorded reads "—"; otherwise its count, and its rate
      // from the step before whenever that step recorded anything.
      const label = business.words[index]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const previous = index ? expected[steps[index - 1]!] : visits
      await expect(row).toHaveText(new RegExp(!expected[step] ? `^${label}\\s*—$` : previous ? `^${label}\\s*${count(expected[step])} · [\\d.,]+%$` : `^${label}\\s*${count(expected[step])}$`))
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
