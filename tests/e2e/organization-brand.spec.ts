import { randomUUID } from 'node:crypto'
import { expect, test, type APIResponse, type Browser } from '@playwright/test'
import { ORGANIZATION_FONT_OPTIONS, ORGANIZATION_FONT_PRESETS } from '../../shared/organization-fonts'
import { openTenantPage, potteryHouseBaseURL, potteryHouseExtraHeaders } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { E2E_KIKUZUKI_ORGANIZATION_ID, blawbyTestBaseUrl, blawbyTestExtraHeaders, kikuzukiTestBaseUrl, kikuzukiTestExtraHeaders, testBaseUrl } from './test-env'

const NCLS_ORGANIZATION_ID = 'org-ncls-blawby'
const PLATFORM_ORGANIZATION_ID = 'platform'

async function expectStatus(response: APIResponse, status: number) {
  expect(response.status(), await response.text()).toBe(status)
}

// A restore that fails must not skip the restores after it, or the context
// disposal. These specs mutate shared preview state, so a half-restored tenant
// breaks the next run rather than this one; report the failure after cleanup.
async function restoreAll(steps: Array<[string, () => Promise<APIResponse>]>) {
  // Read status and body now: disposing the request context invalidates every
  // response it produced, and disposal has to happen before these are asserted.
  const results: Array<{ name: string; status?: number; body?: string; error?: unknown }> = []
  for (const [name, run] of steps) {
    try {
      const response = await run()
      results.push({ name, status: response.status(), body: await response.text() })
    } catch (error) {
      results.push({ name, error })
    }
  }
  return () => {
    for (const result of results) {
      expect(result.error, `restoring ${result.name} threw`).toBeUndefined()
      if (result.status !== undefined) expect(result.status, `restoring ${result.name}: ${result.body}`).toBe(200)
    }
  }
}

const firstFamily = (fontFamily: string) => fontFamily.split(',')[0]!.trim().replaceAll('"', '')

// Loads a public page as a fresh guest and reports the families its heading and
// body render in, the faces the browser loaded, and every font file it fetched.
async function renderedTypography(browser: Browser, url: string, headers: Record<string, string>, root: string, preset: string) {
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  try {
    const page = await guest.newPage()
    const errors: string[] = []
    const fontUrls: string[] = []
    page.on('console', message => { if (/hydration.*mismatch|mismatch.*hydration/i.test(message.text())) errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.resourceType() !== 'font' || request.frame() !== page.mainFrame()) return
      if (/fonts\.(googleapis|gstatic)\.com/.test(new URL(request.url()).hostname)) errors.push(`External font request: ${request.url()}`)
      fontUrls.push(request.url())
    })
    // The SSR HTML cache is keyed by host and a local tenant resolves by
    // header, so a query string is how this reads the preset it just saved.
    // openTenantPage returns once Nuxt has finished hydrating.
    const response = await openTenantPage(page, `${url}${url.includes('?') ? '&' : '?'}sample=${randomUUID()}`, headers)
    expect(response?.status(), url).toBe(200)
    // First SSR render, before any client code runs.
    expect(await response!.text(), url).toContain(`data-font-preset="${preset}"`)
    await expect(page.locator(root)).toHaveAttribute('data-font-preset', preset)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const typography = await page.evaluate(selector => {
      const layout = document.querySelector(selector)!
      const heading = layout.querySelector('h1, h2')!
      return {
        body: getComputedStyle(layout).fontFamily,
        heading: getComputedStyle(heading).fontFamily,
        loaded: Array.from(document.fonts)
          .filter(font => font.status === 'loaded')
          .map(font => ({ family: font.family.replaceAll('"', ''), unicodeRange: font.unicodeRange })),
      }
    }, root)
    for (const fontUrl of new Set(fontUrls)) {
      expect(new URL(fontUrl).origin).toBe(new URL(url).origin)
      // Faces are bundled build assets from the @fontsource packages.
      expect(new URL(fontUrl).pathname).toMatch(/^\/_nuxt\/assets\/.+\.woff2$/)
      const font = await guest.request.get(fontUrl, { headers })
      await expectStatus(font, 200)
      expect(font.headers()['cache-control']).toMatch(/max-age=31536000/)
      expect(Array.from((await font.body()).subarray(0, 4))).toEqual([0x77, 0x4f, 0x46, 0x32])
    }
    expect(errors).toEqual([])
    return { ...typography, fontUrls }
  } finally { await guest.close() }
}

// A face the page did not render is never fetched: only the selected preset's
// families, and nothing from the rest of the catalog, are loaded.
function expectOnlyFamilies(loaded: Array<{ family: string }>, families: string[]) {
  expect(loaded.length).toBeGreaterThan(0)
  for (const face of loaded) expect(families).toContain(face.family)
}

test('Sarabun saves through Brand and renders for its Saya tenant in English, Thai and Japanese', async ({ browser, playwright }) => {
  // Eight full navigations, fresh guest contexts, font-file checks and restoration
  // share this journey budget; each assertion keeps its own existing deadline.
  test.setTimeout(90_000)
  const organizationId = E2E_KIKUZUKI_ORGANIZATION_ID
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const settingsUrl = `/api/organizations/${organizationId}/settings`
  const initial = await owner.get(settingsUrl)
  await expectStatus(initial, 200)
  const original = (await initial.json() as { settings: { font_preset: string } }).settings
  const localePath = `/api/editor/organizations/${organizationId}/locales`
  const patch = async (data: Record<string, unknown>) => expectStatus(await owner.patch(settingsUrl, { data }), 200)
  const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
  try {
    await patch({ font_preset: 'default' })
    const cms = await dashboard.newPage()
    // The deployed dashboard serves the Zaraz consent modal, whose overlay
    // intercepts pointer events until it is dismissed; openTenantPage accepts it.
    await openTenantPage(cms, `${baseURL}/dashboard/${organizationId}/website/brand/font`, {})
    // Every wait names what it was waiting for: the config sets no action timeout.
    await cms.getByRole('combobox').click({ timeout: 30_000 })
    await cms.getByRole('option', { name: 'Sarabun', exact: true }).click({ timeout: 30_000 })
    const preview = cms.getByTestId('site-font-preview')
    await expect(preview.locator('p').first()).toHaveCSS('font-family', /^"?Sarabun/)
    await expect(preview.locator('p').last()).toHaveCSS('font-family', /^"?Sarabun/)
    const saved = await Promise.all([
      cms.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/dashboard/settings', { timeout: 60_000 }),
      cms.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 30_000 }),
    ]).then(([response]) => response)
    expect(saved.status(), await saved.text()).toBe(200)
    await expect(cms.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const persisted = await owner.get(settingsUrl)
    await expectStatus(persisted, 200)
    expect(await persisted.json()).toMatchObject({ settings: { font_preset: 'sarabun' } })
    const mcpRead = await mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'get_organization_settings', args: { organization_id: organizationId } })
    expect(mcpData<{ settings: { font_preset: string } }>(await mcpRead.json()).settings.font_preset).toBe('sarabun')
    await expectStatus(await owner.patch(settingsUrl, { data: { font_preset: 'https://example.com/font.css' } }), 400)
    await expectStatus(await owner.post(`${localePath}/th/add`), 200)

    for (const path of ['/', '/menu', '/th/reservations', '/contact', '/ja']) {
      const rendered = await renderedTypography(browser, `${kikuzukiTestBaseUrl()}${path}`, kikuzukiTestExtraHeaders(), '.tenant-layout', 'sarabun')
      expect(firstFamily(rendered.body), path).toBe('Sarabun')
      expect(firstFamily(rendered.heading), path).toBe('Sarabun')
      if (path === '/ja') {
        // Sarabun has no Japanese glyphs: the Japanese page's own fallback draws them.
        expectOnlyFamilies(rendered.loaded, ['Sarabun', 'Noto Sans JP'])
        expect(rendered.loaded.some(face => face.family === 'Noto Sans JP')).toBe(true)
        continue
      }
      // Sarabun draws Thai itself; neither the template's families nor a fallback is fetched.
      expectOnlyFamilies(rendered.loaded, ['Sarabun'])
      if (path.startsWith('/th/')) expect(rendered.loaded.some(face => face.unicodeRange.includes('U+E01'))).toBe(true)
    }

    // Another tenant keeps its template typography and fetches none of Sarabun.
    const other = await renderedTypography(browser, `${potteryHouseBaseURL}/`, potteryHouseExtraHeaders, '.tenant-layout', 'default')
    expect(firstFamily(other.body)).toBe('Poppins')
    expect(other.loaded.some(face => face.family === 'Sarabun')).toBe(false)

    await patch({ font_preset: 'default' })
    const reset = await renderedTypography(browser, `${kikuzukiTestBaseUrl()}/th`, kikuzukiTestExtraHeaders(), '.tenant-layout', 'default')
    expect(firstFamily(reset.heading)).toBe('Instrument Serif')
    // Poppins has no Thai glyphs: the Thai fallback draws them.
    expect(reset.loaded.some(face => face.family === 'Noto Sans Thai')).toBe(true)
  } finally {
    const assertRestored = await restoreAll([
      ['font_preset', () => owner.patch(settingsUrl, { data: { font_preset: original.font_preset } })],
    ])
    await dashboard.close()
    await owner.dispose()
    assertRestored()
  }
})

test('every catalog preset saves through MCP and renders on Blawby and the platform', async ({ browser, playwright }) => {
  test.setTimeout(240_000)
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const settingsUrl = `/api/organizations/${NCLS_ORGANIZATION_ID}/settings`
  const initial = await owner.get(settingsUrl)
  await expectStatus(initial, 200)
  const original = (await initial.json() as { settings: { font_preset: string } }).settings
  const update = (font_preset: string) => mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'update_organization_settings', args: { organization_id: NCLS_ORGANIZATION_ID, font_preset } })
  try {
    // MCP discovers the supported IDs from the tool schema.
    const listed = await mcpRequest(owner, baseURL, { method: 'tools/list' })
    const tools = (await listed.json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }> } }).result.tools
    expect(tools.find(tool => tool.name === 'update_organization_settings')!.inputSchema.properties.font_preset!.enum).toEqual([...ORGANIZATION_FONT_PRESETS])
    const rejected = await (await update('https://example.com/font.css')).json()
    expect(() => mcpData(rejected)).toThrow()

    const defaults = await renderedTypography(browser, `${blawbyTestBaseUrl()}/`, blawbyTestExtraHeaders(), '.blawby-shell', 'default')
    for (const option of ORGANIZATION_FONT_OPTIONS.filter(option => option.value !== 'default')) {
      mcpData(await (await update(option.value)).json())
      const persisted = await owner.get(settingsUrl)
      await expectStatus(persisted, 200)
      expect((await persisted.json() as { settings: { font_preset: string } }).settings.font_preset).toBe(option.value)
      const rendered = await renderedTypography(browser, `${blawbyTestBaseUrl()}/`, blawbyTestExtraHeaders(), '.blawby-shell', option.value)
      const heading = firstFamily(rendered.heading)
      const body = firstFamily(rendered.body)
      expect(heading, option.value).not.toBe(firstFamily(defaults.heading))
      expect(body, option.value).not.toBe(firstFamily(defaults.body))
      expectOnlyFamilies(rendered.loaded, [heading, body])
      expect(rendered.loaded.some(face => face.family === heading), `${option.value} heading face`).toBe(true)
      expect(rendered.loaded.some(face => face.family === body), `${option.value} body face`).toBe(true)
    }

    // KrabiClaw's own site renders the same setting.
    const platformSettings = `/api/organizations/${PLATFORM_ORGANIZATION_ID}/settings`
    const platformOriginal = await owner.get(platformSettings)
    await expectStatus(platformOriginal, 200)
    const platformPreset = (await platformOriginal.json() as { settings: { font_preset: string } }).settings.font_preset
    try {
      await expectStatus(await owner.patch(platformSettings, { data: { font_preset: 'lora' } }), 200)
      const platform = await renderedTypography(browser, `${baseURL}/`, {}, '.platform-layout', 'lora')
      expect(firstFamily(platform.heading)).toBe('Lora')
      expect(firstFamily(platform.body)).toBe('Lora')
    } finally {
      await expectStatus(await owner.patch(platformSettings, { data: { font_preset: platformPreset } }), 200)
    }

    // The CMS reads back the preset MCP saved.
    const last = ORGANIZATION_FONT_OPTIONS.at(-1)!
    const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
    try {
      const cms = await dashboard.newPage()
      await openTenantPage(cms, `${baseURL}/dashboard/north-carolina-legal-services/website/brand/font`, {})
      await expect(cms.getByRole('combobox')).toContainText(last.label, { timeout: 30_000 })
      await expect(cms.getByTestId('site-font-preview').locator('p').first()).toHaveCSS('font-family', new RegExp(`^"?${last.label.split(' with ')[0]}`))
    } finally { await dashboard.close() }
  } finally {
    const assertRestored = await restoreAll([
      ['font_preset', () => owner.patch(settingsUrl, { data: { font_preset: original.font_preset } })],
    ])
    await owner.dispose()
    assertRestored()
  }
})

const rgb = (hex: string) => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`

// The palette a public page renders in one color scheme, read from its layout root.
async function renderedPalette(browser: Browser, url: string, headers: Record<string, string>, root: string, colorScheme: 'light' | 'dark') {
  const guest = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme, serviceWorkers: 'block' })
  try {
    const page = await guest.newPage()
    const response = await openTenantPage(page, `${url}${url.includes('?') ? '&' : '?'}sample=${randomUUID()}`, headers)
    expect(response?.status(), url).toBe(200)
    return await page.evaluate(selector => {
      const layout = document.querySelector(selector)!
      const style = getComputedStyle(layout)
      // What the visitor sees in the first logo (the header's): the frames not
      // hidden by the current mode.
      const shown = [...document.querySelector('[data-site-logo]')?.querySelectorAll<HTMLElement>('[data-logo-slot]') ?? []]
        .filter(frame => getComputedStyle(frame).display !== 'none')
      const logo = shown[0]
      return {
        dark: document.documentElement.classList.contains('dark'),
        primary: style.getPropertyValue('--ui-primary').trim(),
        onPrimary: style.getPropertyValue('--primary-foreground').trim(),
        background: style.backgroundColor,
        logoSlots: shown.map(frame => frame.dataset.logoSlot),
        logoShape: logo?.getAttribute('data-logo-shape') ?? null,
        logoPosition: logo ? getComputedStyle(logo.querySelector('img')!).objectPosition : null,
      }
    }, root)
  } finally { await guest.close() }
}

test('a starter palette saved through Brand colors the Saya site in light and dark', async ({ browser, playwright }) => {
  const { starterPalette } = await import('../../shared/site-palette')
  const { getOptimalForeground } = await import('../../utils/color-utils')
  const forest = starterPalette('forest')
  const organizationId = E2E_KIKUZUKI_ORGANIZATION_ID
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const settingsUrl = `/api/organizations/${organizationId}/settings`
  const initial = await owner.get(settingsUrl)
  await expectStatus(initial, 200)
  const original = (await initial.json() as { settings: { palette: unknown; palette_source: string } }).settings
  const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
  try {
    await expectStatus(await owner.patch(settingsUrl, { data: { palette: null } }), 200)
    const cms = await dashboard.newPage()
    await openTenantPage(cms, `${baseURL}/dashboard/${organizationId}/website/brand/color`, {})
    await cms.getByRole('button', { name: 'Use the Forest palette' }).click({ timeout: 30_000 })
    await expect(cms.getByTestId('palette-preview-dark')).toHaveCSS('background-color', rgb(forest.dark.ground))
    const saved = await Promise.all([
      cms.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/dashboard/settings', { timeout: 60_000 }),
      cms.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 30_000 }),
    ]).then(([response]) => response)
    expect(saved.status(), await saved.text()).toBe(200)

    // Read back through the settings API and MCP, not the response that wrote it.
    const persisted = await owner.get(settingsUrl)
    expect((await persisted.json() as { settings: { palette: unknown } }).settings.palette).toEqual(forest)
    const mcpRead = await mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'get_organization_settings', args: { organization_id: organizationId } })
    expect(mcpData<{ settings: { palette_source: string } }>(await mcpRead.json()).settings.palette_source).toBe('custom')

    for (const mode of ['light', 'dark'] as const) {
      const rendered = await renderedPalette(browser, `${kikuzukiTestBaseUrl()}/`, kikuzukiTestExtraHeaders(), '.tenant-layout', mode)
      expect(rendered.dark).toBe(mode === 'dark')
      expect(rendered.primary).toBe(forest[mode].action)
      expect(rendered.onPrimary).toBe(getOptimalForeground(forest[mode].action))
      expect(rendered.background).toBe(rgb(forest[mode].ground))
    }

    // Another tenant keeps its own colors.
    const pottery = await owner.get('/api/organizations/org-user-pottery-house/settings')
    const potteryPalette = (await pottery.json() as { settings: { palette: { light: { action: string } } } }).settings.palette
    expect((await renderedPalette(browser, `${potteryHouseBaseURL}/`, potteryHouseExtraHeaders, '.tenant-layout', 'light')).primary).toBe(potteryPalette.light.action)
  } finally {
    const assertRestored = await restoreAll([
      ['palette', () => owner.patch(settingsUrl, { data: { palette: original.palette_source === 'custom' ? original.palette : null } })],
    ])
    await dashboard.close()
    await owner.dispose()
    assertRestored()
  }
})

test('palette changes through MCP reach the CMS and Blawby, and invalid colors are refused before writing', async ({ browser, playwright }) => {
  const { TEMPLATE_PALETTES } = await import('../../shared/site-palette')
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const settingsUrl = `/api/organizations/${NCLS_ORGANIZATION_ID}/settings`
  const initial = await owner.get(settingsUrl)
  await expectStatus(initial, 200)
  const original = (await initial.json() as { settings: { palette: unknown; palette_source: string } }).settings
  const update = (palette: unknown) => mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'update_organization_settings', args: { organization_id: NCLS_ORGANIZATION_ID, palette } })
  const readPalette = async () => (await (await owner.get(settingsUrl)).json() as { settings: { palette: typeof TEMPLATE_PALETTES.blawby } }).settings.palette
  try {
    await expectStatus(await owner.patch(settingsUrl, { data: { palette: null } }), 200)
    mcpData(await (await update({ light: { action: '#0F4C5C' } })).json())
    const changed = await readPalette()
    expect(changed.light).toEqual({ ...TEMPLATE_PALETTES.blawby.light, action: '#0F4C5C' })
    expect(changed.dark).toEqual(TEMPLATE_PALETTES.blawby.dark)

    // A color that is not #RRGGBB, or a role there is not, writes nothing.
    for (const invalid of [{ light: { action: '#12' } }, { light: { border: '#000000' } }]) {
      const body = await (await update(invalid)).json()
      expect(() => mcpData(body)).toThrow()
    }
    expect(await readPalette()).toEqual(changed)

    // The CMS reads back what MCP saved.
    const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
    try {
      const cms = await dashboard.newPage()
      await openTenantPage(cms, `${baseURL}/dashboard/north-carolina-legal-services/website/brand/color`, {})
      await expect(cms.getByRole('textbox', { name: 'Action light hex color' })).toHaveValue('#0F4C5C', { timeout: 30_000 })
    } finally { await dashboard.close() }

    // Blawby renders the palette, and its dark mode.
    const light = await renderedPalette(browser, `${blawbyTestBaseUrl()}/`, blawbyTestExtraHeaders(), '.blawby-shell', 'light')
    expect(light.primary).toBe('#0F4C5C')
    const dark = await renderedPalette(browser, `${blawbyTestBaseUrl()}/`, blawbyTestExtraHeaders(), '.blawby-shell', 'dark')
    expect(dark.dark).toBe(true)
    expect(dark.background).toBe(rgb(TEMPLATE_PALETTES.blawby.dark.ground))
  } finally {
    const assertRestored = await restoreAll([
      ['palette', () => owner.patch(settingsUrl, { data: { palette: original.palette_source === 'custom' ? original.palette : null } })],
    ])
    await owner.dispose()
    assertRestored()
  }
})

test('a logo presentation set through MCP reads back and crops the header logo around its focus', async ({ browser, playwright }) => {
  const organizationId = E2E_KIKUZUKI_ORGANIZATION_ID
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const settingsUrl = `/api/organizations/${organizationId}/settings`
  const logoOf = async () => (await (await owner.get(settingsUrl)).json() as { settings: { media: Array<{ asset_id: string; slot: string; presentation: unknown }> } }).settings.media.find(item => item.slot === 'logo')!
  const original = await logoOf()
  expect((await (await owner.get(settingsUrl)).json() as { settings: { media: Array<{ slot: string }> } }).settings.media.some(item => item.slot === 'logo_dark'), 'Kikuzuki starts without a dark-ground logo').toBe(false)
  const setDarkLogo = (assetId: string | null) => mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'set_media', args: { organization_id: organizationId, placement: { owner_type: 'organization', owner_id: organizationId, slot: 'logo_dark' }, asset_id: assetId } })
  const setLogo = (presentation: unknown) => mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'set_media', args: { organization_id: organizationId, placement: { owner_type: 'organization', owner_id: organizationId, slot: 'logo' }, asset_id: original.asset_id, presentation } })
  try {
    const square = { shape: 'square', focus: { x: 0.2, y: 0.5 } }
    mcpData(await (await setLogo(square)).json())
    expect((await logoOf()).presentation).toEqual(square)
    const rendered = await renderedPalette(browser, `${kikuzukiTestBaseUrl()}/`, kikuzukiTestExtraHeaders(), '.tenant-layout', 'light')
    expect(rendered.logoSlots).toEqual(['logo'])
    expect(rendered.logoShape).toBe('square')
    expect(rendered.logoPosition).toBe('20% 50%')

    // A dark-ground logo replaces the logo in dark mode only; each mode shows one.
    mcpData(await (await setDarkLogo(original.asset_id)).json())
    for (const mode of ['light', 'dark'] as const) {
      const shown = await renderedPalette(browser, `${kikuzukiTestBaseUrl()}/`, kikuzukiTestExtraHeaders(), '.tenant-layout', mode)
      expect(shown.logoSlots, mode).toEqual([mode === 'dark' ? 'logo_dark' : 'logo'])
    }
    // A focus outside the image is refused, and the stored presentation stands.
    const refused = await (await setLogo({ shape: 'circle', focus: { x: 2, y: 0 } })).json()
    expect(() => mcpData(refused)).toThrow()
    expect((await logoOf()).presentation).toEqual(square)
  } finally {
    const assertRestored = await restoreAll([
      ['logo presentation', async () => setLogo(original.presentation)],
      ['dark-ground logo', async () => setDarkLogo(null)],
    ])
    await owner.dispose()
    assertRestored()
  }
})
