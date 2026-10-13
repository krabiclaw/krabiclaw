import { expect, test } from '@playwright/test'
import { openTenantPage } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { E2E_KIKUZUKI_ORGANIZATION_ID, kikuzukiTestBaseUrl, kikuzukiTestExtraHeaders, testBaseUrl } from './test-env'

// Kikuzuki publishes Japanese. Its /ja pages are a Japanese site from the
// server's first byte: the document language, the navigation and the catalogue
// are Japanese before hydration, and hydration does not replace them.
test('Kikuzuki serves its published Japanese site in Japanese', async ({ page, playwright }) => {
  const hydrationErrors: string[] = []
  page.on('console', message => {
    if (/hydration.*mismatch|mismatch.*hydration/i.test(message.text())) hydrationErrors.push(message.text())
  })
  page.on('pageerror', error => hydrationErrors.push(error.message))

  const pageviews: Array<{ eventId: string; path: string }> = []
  for (const path of ['/ja', '/ja/menu', '/ja/experiences', '/ja/reservations', '/ja/contact']) {
    const document = await page.request.get(`${kikuzukiTestBaseUrl()}${path}`, { headers: kikuzukiTestExtraHeaders() })
    expect(document.status(), path).toBe(200)
    const html = await document.text()
    expect(html, `${path} is served as a Japanese document`).toMatch(/<html[^>]*\slang="ja"/)
    expect(html, `${path} renders the Japanese navigation on the server`).toContain('aria-label="メインナビゲーション"')
    expect(html, `${path} carries no English navigation`).not.toContain('aria-label="Primary navigation"')

    const recorded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/analytics/track'
      && response.request().postDataJSON()?.eventType === 'pageview'
      && response.request().postDataJSON()?.pagePath === path)
    await openTenantPage(page, `${kikuzukiTestBaseUrl()}${path}`, kikuzukiTestExtraHeaders())
    await expect(page.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await expect(page.getByRole('navigation', { name: 'メインナビゲーション' })).toBeVisible()
    const pageview = await recorded
    expect(pageview.status(), `${path} records its public localized visit`).toBe(200)
    expect(await pageview.json()).toMatchObject({ ok: true })
    pageviews.push({ eventId: pageview.request().postDataJSON().eventId, path })
  }

  const owner = await playwright.request.newContext({ baseURL: testBaseUrl() })
  try {
    await loginAs(owner, testBaseUrl())
    const sessionId = (await page.context().cookies()).find(cookie => cookie.name === 'kc_session_id')?.value
    expect(sessionId, 'the recorded visits have a native browser session').toBeTruthy()
    const query = await mcpRequest(owner, testBaseUrl(), {
      method: 'tools/call', toolName: 'query_organization_analytics', args: {
        organization_id: E2E_KIKUZUKI_ORGANIZATION_ID, mode: 'events',
        filters: { kind: 'pageview', locale: 'ja', session_id: sessionId },
      },
    })
    expect(query.status()).toBe(200)
    const { rows } = mcpData<{ rows: Array<{ event_id: string; page: Record<string, unknown> }> }>(await query.json())
    for (const { eventId, path } of pageviews) {
      const visit = rows.find(row => row.event_id === eventId)
      expect(visit, `${path} is persisted and readable through authenticated analytics`).toMatchObject({
        page: { path, source_path: path.slice('/ja'.length) || '/', locale: 'ja' },
      })
      if (path !== '/ja') expect(visit?.page.document_id).toBeNull()
    }
  } finally {
    await owner.dispose()
  }

  // The catalogue is the translated one: a dish shows its Japanese name, never
  // its English one.
  await openTenantPage(page, `${kikuzukiTestBaseUrl()}/ja/menu`, kikuzukiTestExtraHeaders())
  await expect(page.getByText('アメリカーノ', { exact: true }).first()).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Americano')
  expect(hydrationErrors).toEqual([])
})
