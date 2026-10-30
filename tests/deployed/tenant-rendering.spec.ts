import { expect, test, type Page } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from '../e2e/helpers'
import { testBaseUrl } from '../e2e/test-env'
import { loginAs } from '../e2e/helpers/auth'
import { mcpData, mcpRequest } from '../e2e/helpers/mcp'
import { environmentTenantAliasHostname } from '../../server/utils/tenant-hosts'
import { blawbyBaseURL, blawbyExtraHeaders, potteryHouseBaseURL, potteryHouseExtraHeaders } from './real-tenants'

// Two tenants stand in for the two verticals' routes this renderer serves:
// Pottery House a venue and NCLS a legal practice, both on .tenant-layout.
// Kikuzuki renders through the same shell and is exercised by tenant-client-navigation,
// tenant-guest-journeys, and kikuzuki-localization, so repeating the generic
// render matrix for it proves nothing the Pottery pass does not.
type Tenant = {
  name: string
  baseURL: string
  headers: Record<string, string>
  shell: string
  identity: RegExp
  definingContent: RegExp
  primaryLabel: RegExp
  detailPath: string
  detailContent: RegExp
  forbidden: RegExp[]
  // The shell's own theme token, asserted to survive hydration. Saya and
  // blawby name theirs differently.
  themeVar: string
}

const tenants: Tenant[] = [
  {
    name: 'Pottery House', baseURL: potteryHouseBaseURL, headers: potteryHouseExtraHeaders,
    shell: '.tenant-layout', identity: /Pottery House/i, definingContent: /pottery|wheel|clay/i,
    primaryLabel: /product|class|book/i, detailPath: '/locations/krabi/products/pottery-wheel-class',
    detailContent: /Pottery Wheel Class/i, themeVar: '--ui-bg',
    forbidden: [/Come dine with us/i, /Reserve a table/i, /From the kitchen/i, /Also part of Saya/i],
  },
  {
    name: 'North Carolina Legal Services', baseURL: blawbyBaseURL, headers: blawbyExtraHeaders,
    shell: '.tenant-layout', identity: /North Carolina Legal Services/i,
    definingContent: /Access to Justice|affordable legal services/i,
    primaryLabel: /services|get started|consultation/i, detailPath: '/services/family',
    detailContent: /Family Law|child custody|divorce/i, themeVar: '--ui-bg',
    forbidden: [/Ember & Slice/i, /No services/i],
  },
]

test('unknown and retired API routes return JSON 404 without rendering a tenant page', async ({ request }) => {
  for (const [method, path] of [
    ['GET', '/api/no-such-route'],
    ['POST', '/api/organizations/org-demo/recommendations/preview'],
  ] as const) {
    const response = await request.fetch(path, { method })
    expect(response.status(), await response.text()).toBe(404)
    expect(response.headers()['content-type']).toContain('application/json')
    expect(await response.json()).toMatchObject({ status: 404 })
  }
})

test('Blawby authored contact sections retain their forms and selected locations', async ({ page, request }) => {
  const platform = new URL(testBaseUrl())
  test.skip(platform.hostname !== 'krabiclaw.com', 'These authored contact pages are production tenants.')
  // Two generated contact pages, and Cedar's, re-authored in the CMS with its own titles and a divider.
  const generated = (documentId: string) => ({ types: ['hero', 'location_grid', 'contact_form'], locations: { id: `block-contact-locations-${documentId}`, title: 'Our locations', description: 'Contact' }, formId: `block-contact-form-${documentId}` })
  for (const tenant of [
    { slug: 'krabiclaw-review-legal', documentId: 'ade2018e-693d-4b0e-8025-daf3143abb8a', locationIds: ['loc-554dde4c-3dcf-406f-ab9d-82038dd1b70c'], ...generated('ade2018e-693d-4b0e-8025-daf3143abb8a') },
    { slug: 'krabiclaw-onboarding-check', documentId: '8780bc6a-6e90-4db6-aac3-2cb1048fbe28', locationIds: ['e151c459-0437-477a-a27e-bb360128b43d', 'loc-5b52502a-0a3e-4410-b14c-d3662f74ae43'], ...generated('8780bc6a-6e90-4db6-aac3-2cb1048fbe28') },
    { slug: 'cedar-legal', documentId: 'cd961dbe-9250-4878-b05b-b7fe1e95591d', locationIds: ['loc-abce1341-c462-4e8d-ab8c-f4f6657f07cf'], types: ['hero', 'divider', 'location_grid', 'contact_form'], locations: { id: 'ce64db84-0b72-41e2-a87b-2090c29103d7', title: 'Office Location & Contact Info', description: undefined }, formId: 'a0970094-2071-42a4-8605-2b1ab88b3dcd' },
  ]) {
    const site = `https://${tenant.slug}.${platform.hostname}`
    const response = await request.get(`${site}/api/public/pages`, { params: { path: '/contact' } })
    expect(response.status(), await response.text()).toBe(200)
    const document = await response.json() as { page: { id: string; blocks: Array<{ id: string; type: string; data: { title?: string; description?: string; location_ids?: string[]; items?: Array<{ id: string }> } }> } }
    expect(document.page.id).toBe(tenant.documentId)
    expect(document.page.blocks.map(block => block.type)).toEqual(tenant.types)
    const locations = document.page.blocks.find(block => block.type === 'location_grid')!
    expect(locations).toMatchObject({ id: tenant.locations.id, data: { title: tenant.locations.title, location_ids: tenant.locationIds } })
    // Cedar's authored block carries no description at all.
    expect(locations.data.description).toBe(tenant.locations.description)
    expect(locations.data.items!.map(item => item.id)).toEqual(tenant.locationIds)
    expect(document.page.blocks.find(block => block.type === 'contact_form')!.id).toBe(tenant.formId)
    await page.unrouteAll()
    const rendered = await openTenantPage(page, `${site}/contact`, {})
    expect(rendered?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: tenant.locations.title, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Send a message', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(1)
  }
  await page.unrouteAll()
  const disabled = await openTenantPage(page, `${blawbyBaseURL}/contact`, blawbyExtraHeaders)
  expect(disabled?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Send a message', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0)
})

async function expectTenantDocument(page: Page, tenant: Tenant) {
  await expect(page.locator(tenant.shell)).toBeVisible()
  await expect(page.locator('header').getByRole('link', { name: tenant.identity }).first()).toBeVisible()
  await expect(page.locator('main')).toContainText(tenant.definingContent)
  await expect(page.locator('footer')).toBeVisible()
  await expect(page.locator('footer')).not.toBeEmpty()
  await expect(page.getByRole('link', { name: tenant.primaryLabel }).first()).toBeVisible()
  // Authored media has to arrive, not merely be referenced: a placement that
  // lost its asset still renders an <img> with a src that 404s.
  const media = page.locator([
    'img[src*="media.krabiclaw.com"]',
    'video[src*="media.krabiclaw.com"]',
    'img[src*="imagedelivery.net"]',
    'video[src*="imagedelivery.net"]',
  ].join(', ')).first()
  await expect(media).toBeVisible()
  for (const text of tenant.forbidden) await expect(page.locator('body')).not.toContainText(text)
  // A component handed a prop it never declared renders it onto the element as
  // block="[object Object]". The shield divider did exactly that for seven weeks
  // while every assertion here still passed, because nothing read the markup.
  expect(await page.content()).not.toContain('[object Object]')
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#__nuxt') as (Element & { __vue_app__?: unknown }) | null)?.__vue_app__,
  ))
}

test('Pottery fullscreen gallery leaves native video controls usable', async ({ page }) => {
  const response = await openTenantPage(page, `${potteryHouseBaseURL}/experiences/ceramics-painting-class`, potteryHouseExtraHeaders)
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  const trigger = page.getByRole('button', { name: /^Play video,/ }).first()
  const source = await trigger.locator('video').getAttribute('src')
  expect(source).toBeTruthy()
  const previews = page.locator('[data-media-gallery] video')
  await expect.poll(() => previews.evaluateAll(elements => elements.filter(element => !(element as HTMLVideoElement).paused).length)).toBe(1)
  const playingIndex = await previews.evaluateAll(elements => elements.findIndex(element => !(element as HTMLVideoElement).paused))
  const playingPreview = previews.nth(playingIndex)
  const previewTime = await playingPreview.evaluate(element => (element as HTMLVideoElement).currentTime)
  await expect.poll(() => playingPreview.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(previewTime)
  await trigger.click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()
  await expect.poll(() => previews.evaluateAll(elements => elements.filter(element => !(element as HTMLVideoElement).paused).length)).toBe(0)
  const video = viewer.locator(`video[src=${JSON.stringify(source)}]`)
  await expect(video).toHaveAttribute('tabindex', '0')
  await video.focus()
  await expect(video).toBeFocused()
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
  const bounds = await video.boundingBox()
  expect(bounds).not.toBeNull()
  await video.click({ position: { x: 24, y: bounds!.height - 48 } })
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false)
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
  await viewer.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
  await expect(viewer).toHaveCount(0)
  await expect.poll(() => previews.evaluateAll(elements => elements.filter(element => !(element as HTMLVideoElement).paused).length)).toBe(1)
  await expect.poll(() => playingPreview.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false)
  const resumedTime = await playingPreview.evaluate(element => (element as HTMLVideoElement).currentTime)
  await expect.poll(() => playingPreview.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(resumedTime)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => previews.evaluateAll(elements => elements.filter(element => !(element as HTMLVideoElement).paused).length)).toBe(0)
  await trigger.click()
  await expect(viewer).toBeVisible()
  await expect(video).toHaveJSProperty('controls', true)
  await video.focus()
  await video.press('Space')
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false)
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
  await viewer.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
  await expect.poll(() => previews.evaluateAll(elements => elements.filter(element => !(element as HTMLVideoElement).paused).length)).toBe(0)
})

for (const tenant of tenants) {
  test(`${tenant.name} renders home and detail routes on desktop`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const response = await openTenantPage(page, `${tenant.baseURL}/`, tenant.headers)
    expect(response?.status()).toBe(200)
    expect(new URL(page.url()).origin).toBe(new URL(tenant.baseURL).origin)
    await expectTenantDocument(page, tenant)
    const route = await page.goto(`${tenant.baseURL}${tenant.detailPath}`, { waitUntil: 'load' })
    expect(route?.status()).toBe(200)
    await expect(page.locator('main')).toContainText(tenant.detailContent)
    await expect(page.locator(tenant.shell)).toBeVisible()
    // The tenant's own theme tokens must survive hydration; losing them
    // repaints the detail page in the platform default mid-load.
    await expect(page.locator(tenant.shell)).not.toHaveCSS(tenant.themeVar, '')
    for (const text of tenant.forbidden) await expect(page.locator('body')).not.toContainText(text)

    if (tenant.name === 'Pottery House') {
      const shell = await request.get(`${tenant.baseURL}/api/public/shell`, { headers: tenant.headers })
      expect(shell.status(), await shell.text()).toBe(200)
      const socialImage = (await shell.json()).organization.social_image
      expect(socialImage).toMatchObject({ width: 1200, height: 630 })
      for (const path of ['/reviews', '/photos']) {
        const aggregate = await openTenantPage(page, `${tenant.baseURL}${path}`, tenant.headers)
        expect(aggregate?.status()).toBe(200)
        await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', socialImage.url)
        await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200')
        await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630')
      }
    }
  })
}

// The staging lodging demo's studio, Stripe
// test mode ready: reached from the home page's link, it opens the booking
// dialog from the card and walks a guest to the contact step. Nothing is
// submitted. A pressed "Check availability" once flipped the dialog's checkbox shut.
test('a guest opens a stay\'s booking dialog, picks nights the calendar allows and reaches the contact step', async ({ page }) => {
  const platform = new URL(testBaseUrl())
  test.skip(platform.hostname !== 'staging.krabiclaw.com', 'The lodging demo with online payments exists on staging only')
  const baseURL = `https://${environmentTenantAliasHostname(platform.hostname, 'saltleaf-stays-demo')}`
  const slug = 'saltleaf-ocean-avenue-studio'
  const stayPath = `/stays/${slug}`
  const homePage = await page.request.get(`${baseURL}/`)
  expect(homePage.status()).toBe(200)
  expect(await homePage.text(), 'the lodging demo home page does not offer the studio').toContain(`href="${stayPath}"`)
  type Night = { date: string; available: boolean; price_minor: number | null; min_stay_arrival: number; max_stay: number | null; closed_to_arrival: boolean; closed_to_departure: boolean }
  const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const to = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10)
  const read = await page.request.get(`${baseURL}/api/public/products/${slug}/nights?from=${from}&to=${to}`)
  expect(read.status(), await read.text()).toBe(200)
  const { home, nights } = await read.json() as { home: { today: string; currency: string }; nights: Night[] }
  // The first stay the home's own nights allow, check-in and checkout in one month.
  let chosen: { checkIn: Night; checkOut: string; stayed: Night[]; minimum: number } | null = null
  for (let start = 0; start < nights.length && !chosen; start++) {
    const arrival = nights[start]!
    if (arrival.date < home.today || !arrival.available || arrival.closed_to_arrival) continue
    const minimum = arrival.min_stay_arrival
    for (let end = start; end < nights.length - 1; end++) {
      if (!nights[end]!.available) break
      const count = end - start + 1
      const departure = nights[end + 1]!
      if (count >= minimum && !departure.closed_to_departure && (arrival.max_stay === null || count <= arrival.max_stay)) {
        if (departure.date.slice(0, 7) === arrival.date.slice(0, 7)) chosen = { checkIn: arrival, checkOut: departure.date, stayed: nights.slice(start, end + 1), minimum }
        break
      }
    }
  }
  expect(chosen, 'the demo stay has no bookable nights in the next 120 days').not.toBeNull()
  const dayLabel = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
  const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: home.currency }).format(minor / 100)

  await page.setViewportSize({ width: 1440, height: 900 })
  expect((await openTenantPage(page, `${baseURL}/`, {}))?.status()).toBe(200)
  const homes = page.locator('main section').filter({ has: page.locator(`[data-carousel-item][href="${stayPath}"]`) })
  const viewAllHomes = homes.getByRole('link', { name: /^View all/ })
  await expect(viewAllHomes).toHaveAttribute('href', '/stays')
  await viewAllHomes.click()
  await expect(page).toHaveURL(`${baseURL}/stays`)
  const studio = page.locator(`main a[href="${stayPath}"]`).first()
  await expect(studio).toBeVisible()
  await studio.click()
  await expect(page).toHaveURL(`${baseURL}${stayPath}`)
  await waitForNuxtHydration(page)
  const card = page.locator('article')
  // A stay is a reservation: none of an appointment's words.
  await expect(card).not.toContainText(/appointment/i)
  const dialog = page.locator('#product-booking')
  await expect(dialog).toBeHidden()
  await card.getByRole('button', { name: 'Check availability', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Select check-in date')

  const { checkIn, checkOut, stayed, minimum } = chosen!
  const [todayYear, todayMonth] = home.today.split('-').map(Number) as [number, number]
  const [year, month] = checkIn.date.split('-').map(Number) as [number, number]
  for (let step = 0; step < (year - todayYear) * 12 + month - todayMonth; step++) await dialog.getByRole('button', { name: 'Next month' }).click()
  await dialog.locator(`[data-reka-calendar-cell-trigger][data-value="${checkIn.date}"]:not([data-outside-view])`).click()
  await expect(dialog).toContainText('Select checkout date')
  // A checkout short of the minimum is not offered.
  if (minimum > 1) {
    await expect(dialog.locator(`[data-reka-calendar-cell-trigger][data-value="${stayed[1]!.date}"]:not([data-outside-view])`)).toBeDisabled()
  }
  await dialog.locator(`[data-reka-calendar-cell-trigger][data-value="${checkOut}"]:not([data-outside-view])`).click()
  const total = money(stayed.reduce((sum, night) => sum + night.price_minor!, 0))
  const totalRow = dialog.locator('dl > div').last()
  await expect(totalRow.locator('dt')).toHaveText('Total')
  await expect(totalRow.locator('dd')).toHaveText(total)
  await dialog.getByRole('button', { name: 'Reserve', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Full name' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Continue to pay', exact: true })).toBeEnabled()

  // Closed, the card reads the stay back; its dates reopen the calendar.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(card.getByText(`${total} Total`, { exact: true })).toBeVisible()
  await expect(card.getByText(dayLabel(checkIn.date), { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileQuoteTotal = page.getByText(`${total} Total`, { exact: true }).filter({ visible: true })
  await expect(mobileQuoteTotal).toBeVisible()
  await expect(mobileQuoteTotal.locator('..').getByText(`${dayLabel(checkIn.date)} – ${dayLabel(checkOut)}`, { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await card.getByRole('button', { name: new RegExp(`Check-in\\s*${dayLabel(checkIn.date)}`) }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(`[data-reka-calendar-cell-trigger][data-value="${checkIn.date}"]:not([data-outside-view])`)).toHaveAttribute('aria-pressed', 'true')
})

test('Pottery House enforces its published languages and localized catalog', async ({ page }) => {
  const localesResponse = await page.request.get(`${potteryHouseBaseURL}/api/public/locales`, { headers: potteryHouseExtraHeaders })
  expect(localesResponse.status(), await localesResponse.text()).toBe(200)
  const { locales } = await localesResponse.json()
  // Staging's copied Growth period expired; its Basic site publishes English
  // only. Production renewed Growth and published Thai. Choose the expected
  // fixture from the requested environment, never from the response itself.
  if (new URL(testBaseUrl()).origin === 'https://staging.krabiclaw.com') {
    expect(locales).toEqual([expect.objectContaining({ code: 'en', is_source: true, status: 'published' })])
    for (const path of ['/api/public/products?locale=th', '/api/public/experiences/pottery-wheel-class?locale=th']) {
      const response = await page.request.get(`${potteryHouseBaseURL}${path}`, { headers: potteryHouseExtraHeaders })
      expect(response.status(), await response.text()).toBe(404)
      expect(await response.json()).toMatchObject({ status: 404, message: 'Localized route was not found' })
    }
    const home = await page.goto(`${potteryHouseBaseURL}/th`, { waitUntil: 'load' })
    expect(home?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
    return
  }
  expect(locales).toContainEqual(expect.objectContaining({ code: 'th', is_source: false, status: 'published' }))

  const catalogResponse = await page.request.get(`${potteryHouseBaseURL}/api/public/products?locale=th`, { headers: potteryHouseExtraHeaders })
  expect(catalogResponse.status(), await catalogResponse.text()).toBe(200)
  expect((await catalogResponse.json()).products).toEqual([])
  const experienceResponse = await page.request.get(`${potteryHouseBaseURL}/api/public/experiences/pottery-wheel-class?locale=th`, { headers: potteryHouseExtraHeaders })
  expect(experienceResponse.status(), await experienceResponse.text()).toBe(200)
  const { product: wheel } = await experienceResponse.json() as { product: { id: string; slug: string; kind: string; name: string } }
  expect(wheel).toMatchObject({ id: 'exp-ph-wheel', slug: 'pottery-wheel-class', kind: 'experience', name: 'คลาสปั้นด้วยแป้นหมุน' })

  const home = await openTenantPage(page, `${potteryHouseBaseURL}/th`, potteryHouseExtraHeaders)
  expect(home?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
  await expect(page.getByRole('navigation', { name: 'การนำทางหลัก', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'ภาษา', exact: true })).toHaveValue('th')
  await expect(page.getByText(wheel.name, { exact: true }).first()).toBeVisible()

  const detail = await openTenantPage(page, `${potteryHouseBaseURL}/th/experiences/${wheel.slug}`, potteryHouseExtraHeaders)
  expect(detail?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
  await expect(page.getByRole('heading', { name: wheel.name, exact: true, level: 1 })).toBeVisible()
})

test.describe('NCLS representative journeys', () => {
  test.describe.configure({ mode: 'default' })

  test('header and footer carry the site\'s navigation', async ({ page }) => {
    await openTenantPage(page, `${blawbyBaseURL}/`, blawbyExtraHeaders)
    for (const label of ['Services', 'Pricing', 'About', 'Contact', 'Blog', 'Donate'])
      await expect(page.locator('header').getByRole('link', { name: label, exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 900 })
    await page.locator('header summary').click()
    await expect(page.locator('header details').getByRole('link', { name: 'Services', exact: true })).toBeVisible()
    for (const label of ['Family law', 'Request a Legal Consultation', 'About'])
      await expect(page.locator('footer').getByRole('link', { name: label, exact: true })).toBeVisible()
    // The bottom bar links the site's own published policies.
    for (const [label, path] of [['Privacy', '/policies/privacy'], ['Terms', '/policies/terms']] as const)
      await expect(page.locator('footer').getByRole('link', { name: label, exact: true })).toHaveAttribute('href', path)

    for (const [name, path] of [
      ['home', '/'],
      ['article', '/blog/when-you-disagree-with-the-schools-evaluation-your-right-to-an-independent-educational-evaluation'],
    ] as const) {
      const response = await openTenantPage(page, `${blawbyBaseURL}${path}`, blawbyExtraHeaders)
      expect(response?.status()).toBe(200)
      await waitForNuxtHydration(page)
      for (const width of [320, 375, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        const header = page.getByRole('banner')
        const logo = header.locator('[data-site-logo] img:visible')
        await expect(logo).toBeVisible()
        await expect.poll(() => logo.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
        const logoBounds = await logo.boundingBox()
        const action = header.locator('[data-tenant-button]')
        await expect(action).toBeVisible()
        const actionBounds = await action.boundingBox()
        expect(logoBounds).not.toBeNull()
        expect(actionBounds).not.toBeNull()
        expect(logoBounds!.width).toBeGreaterThan(0)
        expect(logoBounds!.x).toBeGreaterThanOrEqual(0)
        expect(logoBounds!.x + logoBounds!.width).toBeLessThanOrEqual(actionBounds!.x)
        expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(width)
        expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(width)
        if (width < 1024) {
          const menu = header.getByLabel('Toggle navigation', { exact: true })
          const navigation = menu.locator('..')
          await expect(menu).toBeVisible()
          const menuBounds = await menu.boundingBox()
          expect(menuBounds).not.toBeNull()
          expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(menuBounds!.x)
          expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(width)
          if (name === 'home') await menu.click()
          else await menu.press('Enter')
          await expect(navigation).toHaveJSProperty('open', true)
          if (name === 'home') await expect(navigation.getByRole('link', { name: 'Services', exact: true })).toBeVisible()
          else await expect(navigation.getByRole('button', { name: 'Search Blog', exact: true })).toBeVisible()
          expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(width)
          await menu.press('Enter')
          await expect(navigation).toHaveJSProperty('open', false)
        } else {
          const dimensions = await logo.evaluate(image => {
            if (!(image instanceof HTMLImageElement)) throw new Error('The tenant logo is not an image')
            const bounds = image.getBoundingClientRect()
            return { width: bounds.width, height: bounds.height, ratio: image.naturalWidth / image.naturalHeight }
          })
          expect(dimensions.height).toBe(64)
          expect(dimensions.width).toBeCloseTo(Math.min(224, dimensions.height * dimensions.ratio), 1)
        }
      }
    }
  })

  // One reader walking the site. Each route is a different page recipe, so the
  // traversal is the coverage; six separate fixtures were not.
  test('renders every route reachable from the header', async ({ page, request }) => {
    const journeys = [
      { path: '/pricing', text: /pricing|income|calculator/i },
      { path: '/blog/writing-your-own-will-how-it-works', text: /will|North Carolina/i },
      { path: '/contact', text: /contact|message/i },
      { path: '/schedule', text: /consultation|schedule/i },
      { path: '/blog', text: /blog|legal/i },
      { path: '/donate', text: /donate|support/i },
      // These three rendered a hero, a divider and nothing else for months. A
      // legal page with no body still matched /terms/i, because the word is in
      // the footer of every page on the site.
      { path: '/policies/privacy', text: /personal information/i },
      { path: '/policies/terms', text: /terms of service/i },
      { path: '/third-party-notices', text: /legal aid|inner banks/i },
    ]
    // Nine uncached server renders at 3–4 s each do not fit one page's 30 s budget; each route gets that budget.
    test.setTimeout(journeys.length * 30_000)
    for (const journey of journeys) {
      const response = await openTenantPage(page, `${blawbyBaseURL}${journey.path}`, blawbyExtraHeaders)
      expect(response?.status(), journey.path).toBe(200)
      await expect(page.locator('main'), journey.path).toContainText(journey.text)
      // The hero repeats the page's own title and the closing CTA is identical
      // on every page, so neither shows the page has anything to say. What tells
      // them apart is a section between the two.
      const body = page.locator('main [data-parity-section]'
        + ':not([data-parity-section="page-hero"])'
        + ':not([data-parity-section="consultation"])')
      expect(await body.count(), `${journey.path} renders no section of its own`).toBeGreaterThan(0)
      // And those sections have to say something. /policies/privacy kept a
      // callout holding 19 bytes, which is a section by every structural measure
      // and a blank page to the reader. The thinnest real page here carries ~870
      // characters, so 200 fails an empty body without tracking the copy.
      const bodyText = (await body.allInnerTexts()).join(' ').trim()
      expect(bodyText.length, `${journey.path} body sections are empty`).toBeGreaterThan(200)
    }
    const shellResponse = await request.get(`${blawbyBaseURL}/api/public/shell`, { headers: blawbyExtraHeaders })
    expect(shellResponse.status()).toBe(200)
    const shell = await shellResponse.json() as { locations: Array<{ id: string; slug: string; title: string }> }
    expect(shell.locations.length).toBeGreaterThan(0)
    const office = shell.locations[0]!
    const officePath = `/locations/${office.slug}`
    const pageview = page.waitForResponse(response => new URL(response.url()).pathname === '/api/analytics/track'
      && response.request().postDataJSON()?.eventType === 'pageview'
      && response.request().postDataJSON()?.pagePath === officePath)
    const response = await openTenantPage(page, `${blawbyBaseURL}${officePath}`, blawbyExtraHeaders)
    expect(response?.status()).toBe(200)
    await expect(page.locator('main')).toContainText(office.title)
    const tracked = await pageview
    expect(tracked.status(), await tracked.text()).toBe(200)
    expect(await tracked.json()).toMatchObject({ ok: true })
    await loginAs(request, testBaseUrl())
    const analytics = await mcpRequest(request, testBaseUrl(), { method: 'tools/call', toolName: 'query_organization_analytics', args: {
      organization_id: 'org-ncls-blawby', mode: 'events',
      sort: 'occurred_at_desc', limit: 200, filters: { kind: 'pageview', page_path: officePath, location_id: office.id },
    } })
    expect(analytics.status()).toBe(200)
    const recorded = mcpData<{ rows: Array<{ event_id: string; kind: string; location_id: string; page: { path: string } }> }>(await analytics.json())
    expect(recorded.rows).toContainEqual(expect.objectContaining({
      event_id: tracked.request().postDataJSON().eventId, kind: 'pageview', location_id: office.id,
      page: expect.objectContaining({ path: officePath }),
    }))
  })
})
