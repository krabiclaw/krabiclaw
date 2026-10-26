import { readFileSync } from 'node:fs'
import { devices, expect, test, type Page, type Request } from '@playwright/test'
import {
  blawbyBaseURL, blawbyExtraHeaders,
  openTenantPage, potteryHouseBaseURL, potteryHouseExtraHeaders, waitForNuxtHydration,
} from './helpers'
import { testBaseUrl, tenantTestBaseUrl, tenantTestExtraHeaders, kikuzukiTestBaseUrl } from './test-env'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import mcpCatalog from '../../server/utils/mcp-catalog-snapshots/tenant.json' with { type: 'json' }
import { environmentTenantAliasHostname } from '../../server/utils/tenant-hosts'
import { formatProductMoney, formatProductPriceRange, summarizeProductPrices } from '../../utils/product-money'
import type { PublicProductDetailPayload } from '../../server/utils/public-products'

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

// A shared renderer/theme release supplies its fresh, sourced public inventory.
// The file is release evidence, not a fixture or a list of pages inferred here.
// Staging intentionally publishes no sitemap; the operator maps the production
// sitemap and current native public inventory to the existing tenant aliases.
const inventoryFile = process.env.PLAYWRIGHT_TENANT_ROUTE_INVENTORY
if (inventoryFile) test.describe('published route inventory', () => {
  if (!process.env.PLAYWRIGHT_PREVIEW_URL) throw new Error('A published route inventory requires PLAYWRIGHT_PREVIEW_URL')
  // This exhaustive crawler must not generate thousands of customer analytics
  // events. Ordinary representative journeys retain their human browser agent.
  test.use({ userAgent: `${devices['Desktop Chrome']!.userAgent} KrabiClawRouteVerificationBot/1.0` })
  const platform = new URL(testBaseUrl())
  const targets = new Map([
    ['KrabiClaw', { origin: platform.origin, identity: /KrabiClaw/i, shell: '.platform-layout' }],
    ['Pottery House', { origin: new URL(potteryHouseBaseURL).origin, identity: /Pottery House/i, shell: '.tenant-layout' }],
    ['Kikuzuki', { origin: new URL(kikuzukiTestBaseUrl()).origin, identity: /Kikuzuki/i, shell: '.tenant-layout' }],
    ['NCLS', { origin: new URL(blawbyBaseURL).origin, identity: /North Carolina Legal Services/i, shell: '.tenant-layout' }],
  ])
  if (platform.hostname === 'staging.krabiclaw.com') targets.set('Saltleaf', {
    origin: `https://${environmentTenantAliasHostname(platform.hostname, 'saltleaf-stays-demo')}`,
    identity: /Saltleaf Stays/i,
    shell: '.tenant-layout',
  })
  const inventory: unknown = JSON.parse(readFileSync(inventoryFile, 'utf8'))
  if (!Array.isArray(inventory) || !inventory.length) throw new Error('The published route inventory must be a nonempty array')
  const seen = new Set<string>()
  const groups = new Map<string, URL[]>()
  for (const entry of inventory) {
    if (!entry || typeof entry !== 'object' || typeof entry.tenant !== 'string' || typeof entry.url !== 'string') {
      throw new Error('Every published route inventory entry requires tenant and url strings')
    }
    const target = targets.get(entry.tenant)
    const url = new URL(entry.url)
    if (!target || url.origin !== target.origin || url.username || url.password || url.hash) {
      throw new Error(`Published route inventory names an unsupported tenant destination: ${entry.tenant} ${entry.url}`)
    }
    if (seen.has(url.href)) throw new Error(`Duplicate published route inventory URL: ${url.href}`)
    seen.add(url.href)
    const urls = groups.get(entry.tenant) ?? []
    urls.push(url)
    groups.set(entry.tenant, urls)
  }

  const batches = [...groups].flatMap(([tenant, urls]) => Array.from(
    { length: Math.ceil(urls.length / 30) },
    (_, index) => ({ tenant, offset: index * 30, urls: urls.slice(index * 30, index * 30 + 30) }),
  ))
  for (const { tenant, offset, urls } of batches) {
    const target = targets.get(tenant)!
    for (const width of [1440, 780, 390]) {
      test(`published route inventory: ${tenant} at ${width}px, routes ${offset + 1}–${offset + urls.length}`, async ({ page, request }, testInfo) => {
        test.setTimeout(urls.length * 60_000 + 30_000)
        await page.setViewportSize({ width, height: 900 })
        const errors: string[] = []
        const failedRequests: Request[] = []
        const successfulResponses = new Map<string, number>()
        const requestRoutes = new WeakMap<Request, string>()
        const decodedVideos = new Map<string, { route: string; current_src: string; ready_state: number; video_width: number; video_height: number }>()
        page.on('request', request => requestRoutes.set(request, page.url()))
        const firstParty = (value: string) => {
          const host = new URL(value).hostname
          return host === new URL(target.origin).hostname || host === 'media.krabiclaw.com' || host === 'imagedelivery.net'
        }
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => {
          if (message.type() === 'error' && (!message.location().url || firstParty(message.location().url))) errors.push(message.text())
        })
        page.on('requestfailed', failed => {
          if (firstParty(failed.url())) failedRequests.push(failed)
        })
        page.on('response', response => {
          if (!firstParty(response.url())) return
          if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
          else if ([200, 206, 304].includes(response.status())) successfulResponses.set(response.url(), response.status())
        })

        const completed: string[] = []
        try {
          for (const [index, url] of urls.entries()) {
            await test.step(`${index + 1}/${urls.length} ${url.href}`, async () => {
              successfulResponses.clear()
              const response = await openTenantPage(page, url.href, {})
              expect(response?.status()).toBe(200)
              await expect(page).toHaveURL(url.href)
              // Help owns a standalone conversation viewport and its header;
              // it deliberately has neither the marketing shell nor footer.
              const supportConversation = tenant === 'KrabiClaw' && url.pathname === '/help'
              await expect(page.locator(supportConversation ? 'main' : target.shell)).toBeVisible()
              const locale = await page.locator('html').getAttribute('lang')
              expect(locale).toMatch(/\S/)
              const shellRead = await request.get(`${url.origin}/api/public/shell`, { params: { locale: locale! } })
              expect(shellRead.status(), await shellRead.text()).toBe(200)
              const shell = await shellRead.json() as { organization: { name: string } }
              expect(shell.organization.name).toMatch(/\S/)
              if (locale === 'en') expect(shell.organization.name).toMatch(target.identity)
              await expect(page.locator('header').first().getByRole('link', { name: shell.organization.name }).first()).toBeVisible()
              const main = page.locator('main')
              // A hero and a short post can intentionally have no heading. Their
              // actual document title and own visible copy remain the page premise.
              const title = await page.title()
              expect(title).toMatch(/\S/)
              const content = (await main.innerText()).trim()
              expect(content, 'The tenant route must render its own visible content').toMatch(/\S/)
              const excerpt = content.split(/\s+/).slice(0, 12).join(' ')
              expect(await page.content()).not.toContain('[object Object]')
              const path = url.pathname.replace(new RegExp(`^/${locale}(?=/|$)`), '') || '/'
              const locationProduct = /^\/locations\/([^/]+)\/(?:menu|products)\/([^/]+)$/.exec(path)
              const siteProduct = /^\/(experiences|stays)\/([^/]+)$/.exec(path)
              const cmsServicePage = /^\/services\/[^/]+$/.test(path)
              let detailPath: string | null = null
              const query = new URLSearchParams({ locale: locale! })
              if (url.searchParams.has('location_id')) query.set('location_id', url.searchParams.get('location_id')!)
              if (locationProduct) detailPath = `/api/public/locations/${locationProduct[1]}/products/${locationProduct[2]}`
              else if (siteProduct) detailPath = `/api/public/${siteProduct[1]}/${siteProduct[2]}`
              else if (cmsServicePage) {
                detailPath = '/api/public/pages/product'
                query.set('path', path)
              }
              let product: PublicProductDetailPayload | null = null
              let prices: string[] = []
              if (detailPath) {
                const source = await request.get(`${url.origin}${detailPath}?${query}`)
                expect(source.status(), await source.text()).toBe(200)
                product = await source.json() as PublicProductDetailPayload | null
                // A CMS practice-area page can have no Product binding; the native
                // page-product endpoint deliberately returns null for that case.
                if (!cmsServicePage) expect(product, 'The named public offering must exist independently of its rendered page').not.toBeNull()
                if (product) {
                  expect(product.product.name).toMatch(/\S/)
                  await expect(main).toContainText(product.product.name)
                  const selections = [{ currency: product.currency, location_id: product.location?.id ?? null, at: new Date().toISOString() }]
                  const variants = product.product.variants.filter(variant => variant.active)
                  const summary = summarizeProductPrices(variants, selections)
                  prices = (product.product.kind === 'dish'
                    ? variants.map(variant => formatProductPriceRange(summarizeProductPrices([variant], selections), locale!))
                    : [product.vertical === 'service' && variants.length === 1 && summary.lowest?.unit_amount === 0 ? 'Free' : formatProductMoney(summary.lowest)])
                    .filter((price): price is string => price !== null)
                  for (const price of prices) await expect(main).toContainText(price)
                  if (!prices.length && typeof product.product.details.pricing_note === 'string') await expect(main).toContainText(product.product.details.pricing_note)
                  if (product.product.description) await expect(main).toContainText(product.product.description.slice(0, 80))
                  const photos = [product.product.image, ...product.product.gallery].flatMap(media => media?.kind === 'image' ? [media.public_url, media.thumbnail_url].filter((value): value is string => Boolean(value)) : [])
                  if (photos.length) await expect.poll(() => main.locator('img:visible').evaluateAll((images, sources) => images.some(image => image instanceof HTMLImageElement && (sources.includes(image.currentSrc) || sources.includes(image.src))), photos), { message: 'The offering must show its own saved photograph' }).toBe(true)
                }
              }

              // Visit the complete document so native lazy media loads before checking
              // it and retaining the full-page composition. No fixed wait or mocked data.
              await page.evaluate(async () => {
                for (let top = 0; top < document.documentElement.scrollHeight; top += window.innerHeight) {
                  window.scrollTo(0, top)
                  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
                }
              })
              if (supportConversation) await expect(page.getByRole('textbox', { name: 'Ask ChowBot anything...' })).toBeVisible()
              else {
                await expect(page.locator('footer').last()).toBeVisible()
                await expect(page.locator('footer').last()).not.toBeEmpty()
              }
              await page.evaluate(async () => {
                const scrollers = [...document.querySelectorAll<HTMLElement>('*')]
                  .filter(element => element.scrollWidth > element.clientWidth && element.clientWidth > 0)
                  .map(element => ({ element, left: element.scrollLeft, top: element.scrollTop }))
                try {
                  for (const image of [...document.querySelectorAll('img')].filter(image => image.getClientRects().length
                    && [location.hostname, 'media.krabiclaw.com', 'imagedelivery.net'].includes(new URL(image.currentSrc || image.src).hostname))) {
                    // Native scrolling visits clipped horizontal carousel cards too;
                    // their intentional lazy loading is not a broken-image premise.
                    image.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
                    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
                    await image.decode()
                    if (image.naturalWidth === 0 || image.naturalHeight === 0) throw new Error(`The rendered image did not decode: ${image.currentSrc || image.src}`)
                  }
                } finally {
                  for (const { element, left, top } of scrollers) element.scrollTo({ left, top, behavior: 'instant' })
                }
              })
              for (const video of await page.locator('video:visible').all()) {
                await video.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
                // Native controlled videos deliberately preload nothing. Exercise
                // those controls; scoped previews retain their own autoplay owner.
                await video.evaluate(async element => {
                  const media = element as HTMLVideoElement
                  if (media.controls && media.paused) await media.play()
                })
                await expect.poll(() => video.evaluate(element => {
                  const media = element as HTMLVideoElement
                  return {
                    error: media.error?.message ?? null,
                    decoded: media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && media.videoWidth > 0 && media.videoHeight > 0,
                  }
                }), { message: 'The rendered video must decode its own current frame without a media error' }).toEqual({ error: null, decoded: true })
                const decoded = await video.evaluate(element => {
                  const media = element as HTMLVideoElement
                  return { route: location.href, current_src: media.currentSrc, ready_state: media.readyState, video_width: media.videoWidth, video_height: media.videoHeight }
                })
                if (successfulResponses.has(decoded.current_src)) decodedVideos.set(`${decoded.route}\n${decoded.current_src}`, decoded)
              }
              expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(width)
              await page.evaluate(() => window.scrollTo(0, 0))
              await expect(page).toHaveTitle(title)
              await expect.poll(async () => (await main.innerText()).trim().split(/\s+/).join(' ')).toContain(excerpt)
              if (product) await expect(main).toContainText(product.product.name)
              for (const price of prices) await expect(main).toContainText(price)
              const screenshot = testInfo.outputPath(`full-page-${String(index + 1).padStart(4, '0')}.png`)
              await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
              await testInfo.attach(`full-page ${index + 1} ${url.pathname}${url.search}`, { path: screenshot, contentType: 'image/png' })
              await expect(page).toHaveURL(url.href)
              const resolvedDuplicateCancellations = []
              while (failedRequests.length) {
                const failed = failedRequests.shift()!
                const error = failed.failure()?.errorText
                const resourceType = failed.resourceType()
                // Chromium may cancel an image duplicate, a video's poster
                // duplicate or a video byte range. A picture may also replace
                // its fallback with a selected source.
                // Require the selected resource to succeed and decode in its
                // rendered owner before accepting cancellation.
                const owner = failed.method() === 'GET' && error === 'net::ERR_ABORTED'
                  && (resourceType === 'image' || resourceType === 'other' || resourceType === 'media')
                  ? await page.evaluate(async ({ value, successful }) => {
                    const image = [...document.images].find(image => image.getClientRects().length
                      && (image.src === value || image.currentSrc === value) && successful.includes(image.currentSrc || image.src)
                      && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
                    if (image) {
                      await image.decode()
                      return { element: 'img', src: image.src, current_src: image.currentSrc, natural_width: image.naturalWidth, natural_height: image.naturalHeight }
                    }
                    const video = [...document.querySelectorAll('video')].find(video => video.getClientRects().length
                      && video.currentSrc === value && successful.includes(value)
                      && video.error === null && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
                      && video.videoWidth > 0 && video.videoHeight > 0)
                    if (video) return { element: 'video', poster: video.poster, current_src: video.currentSrc, ready_state: video.readyState, video_width: video.videoWidth, video_height: video.videoHeight, error: null }
                    // A poster is an image its rendered video owns; Chromium can
                    // cancel a second fetch of one this page already received.
                    const posterOwner = [...document.querySelectorAll('video')].find(video => video.getClientRects().length
                      && video.poster === value && successful.includes(value))
                    if (!posterOwner) return null
                    const poster = new Image()
                    poster.src = value
                    await poster.decode()
                    return poster.naturalWidth > 0 && poster.naturalHeight > 0
                      ? { element: 'video-poster', poster: value, current_src: posterOwner.currentSrc, natural_width: poster.naturalWidth, natural_height: poster.naturalHeight }
                      : null
                  }, { value: failed.url(), successful: [...successfulResponses.keys()] })
                  : null
                // Navigation cancels the departed document's outstanding byte
                // ranges. Accept only its exact resource already proven decoded;
                // a failure belonging to this page still needs its live owner.
                const sourceRoute = requestRoutes.get(failed)
                const departedOwner = failed.method() === 'GET' && error === 'net::ERR_ABORTED' && resourceType === 'media'
                  && sourceRoute !== url.href ? decodedVideos.get(`${sourceRoute}\n${failed.url()}`) : undefined
                if (owner || departedOwner) resolvedDuplicateCancellations.push({ url: failed.url(), resource_type: resourceType, error, successful_responses: Object.fromEntries(successfulResponses), decoded_owner: owner ?? departedOwner })
                else errors.push(`${failed.method()} ${failed.url()}: ${error}`)
              }
              if (resolvedDuplicateCancellations.length) await testInfo.attach(`resolved duplicate media cancellations ${index + 1} ${url.pathname}${url.search}`, {
                body: JSON.stringify({ route: url.href, cancellations: resolvedDuplicateCancellations }, null, 2),
                contentType: 'application/json',
              })
              expect(failedRequests.map(failed => `${failed.method()} ${failed.url()}: ${failed.failure()?.errorText}`), 'No observed request failure may remain unprocessed at the route boundary').toEqual([])
              expect(errors).toEqual([])
            }, { timeout: 60_000 })
            completed.push(url.href)
          }
        } finally {
          await testInfo.attach('completed-route-scope', {
            body: JSON.stringify({ tenant, width, planned_count: urls.length, completed_count: completed.length, planned_urls: urls.map(url => url.href), completed_urls: completed }, null, 2),
            contentType: 'application/json',
          })
        }
      })
    }
  }
})

test('unknown sites render an unbranded 404 while resolved tenant errors retain their identity', async ({ page }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'The local tenant header exercises an unresolved host without changing deployed DNS.')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const unknown = await openTenantPage(page, `${testBaseUrl()}/`, { 'x-preview-tenant': 'no-such-organization' })
  expect(unknown?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  await expect(page.getByText('Error 404', { exact: true })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/Krabi[Cc]law|Ember & Slice|North Carolina Legal Services/)
  await page.unrouteAll()
  const missing = await openTenantPage(page, `${blawbyBaseURL}/no-such-page`, blawbyExtraHeaders)
  expect(missing?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'North Carolina Legal Services', exact: true })).toBeVisible()
  const unsupported = await page.goto(`${blawbyBaseURL}/templates`)
  expect(unsupported?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('Blawby authored contact sections retain their forms and selected locations', async ({ page, request }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'The local production copy carries these existing contact pages.')
  // Two generated contact pages, and Cedar's, re-authored in the CMS with its own titles and a divider.
  const generated = (documentId: string) => ({ types: ['hero', 'location_grid', 'contact_form'], locations: { id: `block-contact-locations-${documentId}`, title: 'Our locations', description: 'Contact' }, formId: `block-contact-form-${documentId}` })
  for (const tenant of [
    { slug: 'krabiclaw-review-legal', documentId: 'ade2018e-693d-4b0e-8025-daf3143abb8a', locationIds: ['loc-554dde4c-3dcf-406f-ab9d-82038dd1b70c'], ...generated('ade2018e-693d-4b0e-8025-daf3143abb8a') },
    { slug: 'krabiclaw-onboarding-check', documentId: '8780bc6a-6e90-4db6-aac3-2cb1048fbe28', locationIds: ['e151c459-0437-477a-a27e-bb360128b43d', 'loc-5b52502a-0a3e-4410-b14c-d3662f74ae43'], ...generated('8780bc6a-6e90-4db6-aac3-2cb1048fbe28') },
    { slug: 'cedar-legal', documentId: 'cd961dbe-9250-4878-b05b-b7fe1e95591d', locationIds: ['loc-abce1341-c462-4e8d-ab8c-f4f6657f07cf'], types: ['hero', 'divider', 'location_grid', 'contact_form'], locations: { id: 'ce64db84-0b72-41e2-a87b-2090c29103d7', title: 'Office Location & Contact Info', description: undefined }, formId: 'a0970094-2071-42a4-8605-2b1ab88b3dcd' },
  ]) {
    const headers = { 'x-preview-tenant': tenant.slug }
    const response = await request.get(`${testBaseUrl()}/api/public/pages`, { headers, params: { path: '/contact' } })
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
    const rendered = await openTenantPage(page, `${testBaseUrl()}/contact`, headers)
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

for (const tenant of [
  { name: 'Saya', organizationId: 'org-demo', baseURL: tenantTestBaseUrl(), headers: tenantTestExtraHeaders(), path: '/about', schemaType: 'Organization' },
  { name: 'Blawby', organizationId: 'org-ncls-blawby', baseURL: blawbyBaseURL, headers: blawbyExtraHeaders, path: '/about', schemaType: 'LegalService' },
  { name: 'Cedar Legal Demo', organizationId: '5WebMejsoVLyZLHC29wHH5GbQx1jlvCd', baseURL: testBaseUrl(), headers: { 'x-preview-tenant': 'cedar-legal' }, path: '/contact', ownerId: 'ivUlJc9BoyZeFszowpbUEjh1pugcDHiT', schemaType: 'ProfessionalService' },
]) {
  test(`${tenant.name} ${tenant.path} CMS-authored HowTo persists and accompanies the public page schema`, async ({ page, request, baseURL }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'Content writes use local D1 only.')
    await loginAs(request, baseURL!)
    let impersonated = false
    try {
      if ('ownerId' in tenant) {
        const impersonation = await request.post(`${baseURL}/api/auth/admin/impersonate-user`, { headers: authRequestHeaders(baseURL!), data: { userId: tenant.ownerId } })
        expect(impersonation.status(), await impersonation.text()).toBe(200)
        impersonated = true
        expect(await impersonation.json()).toMatchObject({ user: { id: tenant.ownerId } })
      }
      const inventory = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'list_site_pages', args: { organization_id: tenant.organizationId, locale: 'en' } })
      expect(inventory.status()).toBe(200)
      const about = mcpData<{ pages: Array<{ id: string; path: string }> }>(await inventory.json()).pages.find(item => item.path === tenant.path)
      expect(about, 'the existing authored page must be available').toBeDefined()
      const before = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_site_page', args: { organization_id: tenant.organizationId, variant_id: about!.id } })
      expect(before.status()).toBe(200)
      const original = mcpData<{ page: { document: { id: string }; blocks: Array<{ id: string; type: string }> } }>(await before.json()).page
      // Cedar's contact page as authored in its CMS: the office list and the form the HowTo is added beside.
      if ('ownerId' in tenant) expect(original.blocks.map(block => block.type)).toEqual(['hero', 'divider', 'location_grid', 'contact_form'])
      const title = `Plan your visit ${crypto.randomUUID()}`
      const steps = [{ name: 'Choose a time', text: 'Contact our team to choose a time for your visit.' }, { name: 'Prepare for your visit', text: 'Read the information our team sends before you arrive.' }]
      const added: Array<{ id: string; updated_at: string }> = []
      try {
        for (const blockTitle of [title, null]) {
          const written = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'append_content_block', args: { organization_id: tenant.organizationId, document_id: original.document.id, type: 'how_to', data: { title: blockTitle, steps } } })
          expect(written.status()).toBe(200)
          const changed = mcpData<{ blocks: Array<{ id: string; updated_at: string }> }>(await written.json()).blocks
          expect(changed).toHaveLength(1)
          added.push(changed[0]!)
        }
        const publicPage = await page.request.get(`${tenant.baseURL}/api/public/pages`, { headers: tenant.headers, params: { path: tenant.path } })
        expect(publicPage.status(), await publicPage.text()).toBe(200)
        expect(await publicPage.json()).toMatchObject({ page: { blocks: expect.arrayContaining(added.map((block, index) => expect.objectContaining({ id: block.id, type: 'how_to', data: { title: index ? null : title, steps } }))) } })
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        const rendered = await openTenantPage(page, `${tenant.baseURL}${tenant.path}`, tenant.headers)
        expect(rendered?.status()).toBe(200)
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
        if ('ownerId' in tenant) await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(1)
        for (const step of steps) await expect(page.locator('main').getByText(step.text, { exact: true })).toHaveCount(2)
        const nodes = await page.locator('script[type="application/ld+json"]').evaluateAll(elements => elements.flatMap(element => {
          const schema = JSON.parse(element.textContent!)
          return schema['@graph'] ?? [schema]
        })) as Array<Record<string, unknown>>
        const howTo = nodes.filter(node => node['@type'] === 'HowTo' && added.some(block => String(node['@id']).endsWith(`#howto-${block.id}`)))
        expect(howTo).toHaveLength(2)
        expect(howTo.find(node => String(node['@id']).endsWith(`#howto-${added[0]!.id}`))?.name).toBe(title)
        expect(howTo.find(node => String(node['@id']).endsWith(`#howto-${added[1]!.id}`))?.name).toBe(await page.title())
        const canonical = await page.locator('link[rel="canonical"]').getAttribute('href')
        for (const node of howTo) {
          expect(node.step).toEqual(steps.map((step, index) => expect.objectContaining({ '@type': 'HowToStep', position: index + 1, ...step })))
          expect(String(node['@id']).startsWith(`${canonical}#`)).toBe(true)
        }
        expect(new Set(howTo.map(node => node['@id'])).size).toBe(2)
        expect(nodes.some(node => (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).includes(tenant.schemaType))).toBe(true)
        expect(errors).toEqual([])
      } finally {
        for (const block of added) {
          const current = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_site_page', args: { organization_id: tenant.organizationId, variant_id: about!.id } })
          expect(current.status()).toBe(200)
          const stored = mcpData<{ page: { blocks: Array<{ id: string; updated_at: string }> } }>(await current.json()).page.blocks.find(item => item.id === block.id)
          expect(stored).toBeDefined()
          const removed = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'delete_content_block', args: { organization_id: tenant.organizationId, block_id: block.id, expected_updated_at: stored!.updated_at } })
          expect(removed.status()).toBe(200)
          expect(mcpData<{ blocks: unknown[] }>(await removed.json()).blocks).toEqual([])
        }
        const restored = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_site_page', args: { organization_id: tenant.organizationId, variant_id: about!.id } })
        expect(restored.status()).toBe(200)
        expect(mcpData<{ page: { blocks: Array<{ id: string }> } }>(await restored.json()).page.blocks.map(block => block.id)).toEqual(original.blocks.map(block => block.id))
      }
    } finally {
      if (impersonated) {
        const stopped = await request.post(`${baseURL}/api/auth/admin/stop-impersonating`, { headers: authRequestHeaders(baseURL!), data: {} })
        expect(stopped.status(), await stopped.text()).toBe(200)
      }
    }
  })
}

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

test('KrabiClaw pricing retains its billing plans after hydration', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('krabiclaw-theme', 'light'))
  const baseURL = testBaseUrl()
  const response = await openTenantPage(page, `${baseURL}/pricing`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('heading', { name: 'Basic', exact: true })).toBeVisible()
  const billing = await page.request.get(`${baseURL}/api/billing/plans`)
  expect(billing.status()).toBe(200)
  const plans = await billing.json() as Array<{ id: string; name: string }>
  const paid = plans.find(plan => plan.id === 'growth')
  expect(paid).toBeDefined()
  await expect(page.getByRole('heading', { name: paid!.name, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get Growth', exact: true })).toHaveAttribute('href', '/signup?plan=growth&redirect=%2Fapi%2Fpost-login%3Fplan%3Dgrowth')
})

// The docs renderer at a phone width: overflow and table scrolling fail there first.
{
  const width = 390
  test(`KrabiClaw MCP reference has usable anchors and contained tables at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 })
    const baseURL = testBaseUrl()
    let referenceURL = `${baseURL}/docs/mcp-tool-reference`
    // Local PR data can carry the real unpublished article. Its signed CMS
    // preview exercises the renderer without publishing or creating test state.
    // Deployed qualification always exercises the anonymous public route.
    if (!process.env.PLAYWRIGHT_PREVIEW_URL) {
      await loginAs(request, baseURL)
      const read = await mcpRequest(request, baseURL, {
        method: 'tools/call', toolName: 'get_blog_post',
        args: { organization_id: 'platform', post_id: 'mcp-tool-reference' },
      })
      expect(read.status()).toBe(200)
      const { post } = mcpData<{ post: { collection: string; status: string; public_url: string | null; preview_url: string | null } }>(await read.json())
      expect(post.collection).toBe('docs')
      const destination = post.status === 'draft' ? post.preview_url : post.public_url
      if (post.status !== 'draft') expect(post.status).toBe('published')
      expect(destination).toBeTruthy()
      const returned = new URL(destination!)
      expect(returned.pathname).toBe('/docs/mcp-tool-reference')
      if (post.status === 'draft') expect(returned.searchParams.get('preview_token')).toBeTruthy()
      // Copied organizations retain their canonical public hostname. Only the
      // transport host changes; the returned draft route and token stay intact.
      referenceURL = new URL(`${returned.pathname}${returned.search}`, baseURL).href
    }
    const response = await openTenantPage(page, referenceURL, {})
    expect(response?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const article = page.locator('article.blog-article')
    await expect(article.getByRole('heading', { name: 'MCP tool reference', exact: true, level: 1 })).toBeVisible()
    // The catalog guard checks this canonical snapshot against the registry.
    await expect(article).toContainText(`Tools: ${mcpCatalog.tools.length}.`)
    await expect(article).toContainText(`Reference fingerprint: ${mcpCatalog.documentationFingerprint}`)
    const toolNames = mcpCatalog.tools.map(tool => tool.name).sort()
    expect((await article.locator('h3 code').allTextContents()).sort()).toEqual(toolNames)
    const anchorFailures = await article.evaluate((element, names) => {
      const ids = [...element.querySelectorAll('[id]')].map(target => target.id)
      const failures = names.filter(name => ids.filter(id => id === name).length !== 1)
      for (const link of element.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
        const id = decodeURIComponent(link.hash.slice(1))
        if (!id || !element.contains(document.getElementById(id))) failures.push(link.getAttribute('href')!)
      }
      return failures
    }, toolNames)
    expect(anchorFailures, 'Every tool and nested-shape link must resolve inside the rendered article').toEqual([])
    expect(await page.evaluate(() => window.innerWidth)).toBe(width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const tables = article.locator('table')
    expect(await tables.count()).toBeGreaterThan(0)
    const tableFailures = await tables.evaluateAll(elements => elements.flatMap((table, index) => {
      const bounds = table.getBoundingClientRect()
      const failures: string[] = []
      if (Math.floor(bounds.left) < 0 || Math.ceil(bounds.right) > window.innerWidth) failures.push(`table ${index} escapes the viewport`)
      for (const cell of table.querySelectorAll('th, td:first-child code')) {
        const text = document.createRange()
        text.selectNodeContents(cell)
        if (text.getClientRects().length !== 1) failures.push(`table ${index} wraps identifier/header: ${cell.textContent}`)
      }
      for (const code of table.querySelectorAll('code')) {
        if (getComputedStyle(code, '::before').content !== 'none' || getComputedStyle(code, '::after').content !== 'none') {
          failures.push(`table ${index} adds decorative code characters`)
        }
      }
      return failures
    }))
    expect(tableFailures).toEqual([])
    const horizontalScroll = await tables.evaluateAll(elements => {
      const table = elements.find(element => element.scrollWidth > element.clientWidth)
      if (!table) return null
      table.scrollLeft = table.scrollWidth
      const result = { tableMoved: table.scrollLeft > 0, pageLeft: window.scrollX }
      table.scrollLeft = 0
      return result
    })
    expect(horizontalScroll, 'Narrow tables must remain independently scrollable').not.toBeNull()
    expect(horizontalScroll).toEqual({ tableMoved: true, pageLeft: 0 })
    for (const name of [toolNames[0]!, toolNames.at(-1)!]) {
      await article.locator(`a[href="#${name}"]`).first().click()
      expect(new URL(page.url()).hash).toBe(`#${name}`)
      const heading = article.locator('h3').filter({ hasText: new RegExp(` — ${name}$`) })
      await expect(heading).toBeVisible()
      const headerBottom = await page.locator('header').first().evaluate(element => Math.ceil(element.getBoundingClientRect().bottom))
      await expect.poll(() => heading.evaluate(element => Math.floor(element.getBoundingClientRect().top)), 'Tool anchors must land below the sticky site header').toBeGreaterThanOrEqual(headerBottom)
    }
    const menuHeading = article.locator('h3').filter({ hasText: / — update_menu$/ })
    await menuHeading.evaluate(element => element.scrollIntoView({ block: 'start' }))
  })

  test(`KrabiClaw policies render their own headers and body at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    for (const policy of [
      { path: '/policies/privacy', title: 'Privacy Policy', body: 'This Privacy Policy explains how we collect, use, disclose, retain, and protect Personal Data' },
      { path: '/policies/terms', title: 'Terms of Service', body: 'A contract for the sale or provision of a merchant\'s products or services is directly between the merchant and its customer.' },
    ]) {
      const response = await openTenantPage(page, `${testBaseUrl()}${policy.path}`, {})
      expect(response?.status()).toBe(200)
      await waitForNuxtHydration(page)
      await expect(page.getByRole('heading', { name: policy.title, exact: true, level: 1 })).toBeVisible()
      await expect(page.locator('main')).toContainText(policy.body)
      await expect(page.locator('.kc-parallax-hero')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth), policy.path).toBeLessThanOrEqual(width)
    }
    expect(errors).toEqual([])
  })
}

test('KrabiClaw social viewer keyboard navigation changes the visible media', async ({ page }) => {
  const response = await openTenantPage(page, `${testBaseUrl()}/`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  const cards = page.locator('[data-social-posts=block] [data-social-post]')
  const mark = /^Posted on (Facebook|Instagram)$/
  // A website-only post carries no channel mark; the newest post may be one
  // (production, 2026-10-06). The first card published to a channel carries
  // its account name in an unlinked mark, not the channel's own name.
  const firstCard = cards.first()
  const socialCard = cards.filter({ has: page.getByLabel(mark) }).first()
  // A post published to both channels carries both marks, each with its account name.
  const channelMarks = socialCard.getByLabel(mark)
  await expect(channelMarks.first()).toBeVisible()
  for (const channelMark of await channelMarks.all()) await expect(channelMark).toHaveText(/\S/)
  await expect(socialCard.locator('time, a')).toHaveCount(0)
  await expect(firstCard.locator('time, a')).toHaveCount(0)
  // Select the first card through the carousel.
  await page.locator('[data-social-posts=block]').getByRole('tab', { name: 'Go to slide 1', exact: true }).click()
  // The viewer opens on the card that was clicked; the first card puts the first picture at the top.
  await firstCard.click()
  const viewer = page.getByRole('dialog', { name: 'Photos and videos', exact: true })
  await expect(viewer).toBeVisible()
  const pictures = viewer.locator('section')
  const mediaBounds = await pictures.first().locator('img:not([aria-hidden]), video').boundingBox()
  const captionBounds = await pictures.first().locator('p').boundingBox()
  expect(mediaBounds).not.toBeNull()
  expect(captionBounds).not.toBeNull()
  expect(captionBounds!.x >= mediaBounds!.x + mediaBounds!.width || captionBounds!.y >= mediaBounds!.y + mediaBounds!.height).toBe(true)
  expect(await pictures.count()).toBeGreaterThan(1)
  const close = viewer.getByRole('button', { name: 'Close photos and videos', exact: true })
  await close.press('ArrowDown')
  await expect.poll(() => pictures.nth(1).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0)
  const visibleMedia = pictures.nth(1).locator('img:not([aria-hidden]), video')
  if (await visibleMedia.evaluate(element => element instanceof HTMLVideoElement)) {
    await expect(visibleMedia).toHaveJSProperty('controls', true)
    const initialTime = await visibleMedia.evaluate(element => (element as HTMLVideoElement).currentTime)
    await visibleMedia.press('Space')
    await expect(visibleMedia).toHaveJSProperty('paused', false)
    await expect.poll(() => visibleMedia.evaluate((element, start) => {
      const video = element as HTMLVideoElement
      return video.currentTime > start && !video.paused ? 'playing' : {
        time: video.currentTime, paused: video.paused, readyState: video.readyState,
        networkState: video.networkState, error: video.error?.message ?? null, src: video.currentSrc,
      }
    }, initialTime)).toBe('playing')
  }
  await expect.poll(() => visibleMedia.evaluate(element => element instanceof HTMLVideoElement ? element.videoWidth : (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await close.press('ArrowUp')
  await expect.poll(() => pictures.nth(0).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0)
  await close.click()
  await expect(viewer).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const homeCards = page.locator('[data-social-posts=block] [data-social-post]')
  const first = await homeCards.nth(0).boundingBox()
  const second = await homeCards.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(second!.y).toBe(first!.y)
  expect(second!.x).toBeGreaterThan(first!.x + first!.width)
  await openTenantPage(page, `${testBaseUrl()}/posts`, {})
  await waitForNuxtHydration(page)
  const feedCards = page.locator('[data-social-posts=feed] [data-social-post]')
  const top = await feedCards.nth(0).boundingBox()
  const next = await feedCards.nth(1).boundingBox()
  expect(top).not.toBeNull()
  expect(next).not.toBeNull()
  expect(next!.x).toBe(top!.x)
  expect(next!.y).toBeGreaterThan(top!.y + top!.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

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
  test(`${tenant.name} renders home and detail routes on desktop`, async ({ page, request, baseURL }, testInfo) => {
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

    // Only the local production copy is editable; deployed rendering stays read-only.
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

    if (tenant.name !== 'North Carolina Legal Services' || process.env.PLAYWRIGHT_PREVIEW_URL) return
    const organizationId = 'org-ncls-blawby'
    const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, organizationId)
    type FeaturedImage = { asset_id: string; slot: string; public_url: string; alt_text: string | null }
    type AuthoredPage = { page: { blocks: Array<{ id: string; type: string; media: FeaturedImage[] }> } }
    try {
      await loginAs(request, baseURL!, 'user-e2e-ncls-owner')
      const source = await request.get(`${tenant.baseURL}/api/public/pages`, { headers: tenant.headers, params: { path: '/' } })
      expect(source.status(), await source.text()).toBe(200)
      const cta = (await source.json() as AuthoredPage).page.blocks.find(block => ['cta', 'contact_cta'].includes(block.type) && block.media.some(media => media.slot === 'featured'))
      expect(cta, 'The saved home page has an authored featured CTA image').toBeDefined()
      const featured = cta!.media.find(media => media.slot === 'featured')!
      const mediaPath = `${baseURL}/api/editor/organizations/${organizationId}/media`
      const asset = await request.get(mediaPath, { params: { id: featured.asset_id } })
      expect(asset.status(), await asset.text()).toBe(200)
      const original = (await asset.json() as { media: Array<{ id: string; kind: string; alt_text: string | null; public_url: string }> }).media
      expect(original).toHaveLength(1)
      expect(original[0]).toMatchObject({ id: featured.asset_id, kind: 'image', public_url: featured.public_url, alt_text: featured.alt_text })
      const authoredAlt = 'CMS-authored featured image description'
      const picture = page.locator(`main [data-parity-section="consultation"] img[src=${JSON.stringify(featured.public_url)}]`)
      try {
        const written = await request.patch(`${mediaPath}/${featured.asset_id}`, { data: { alt_text: authoredAlt } })
        expect(written.status(), await written.text()).toBe(200)
        expect(await written.json()).toEqual({ updated: true })
        const stored = await request.get(mediaPath, { params: { id: featured.asset_id } })
        expect(stored.status(), await stored.text()).toBe(200)
        expect((await stored.json()).media).toEqual([expect.objectContaining({ id: featured.asset_id, alt_text: authoredAlt })])
        const publicRead = await request.get(`${tenant.baseURL}/api/public/pages`, { headers: tenant.headers, params: { path: '/' } })
        expect(publicRead.status(), await publicRead.text()).toBe(200)
        expect((await publicRead.json() as AuthoredPage).page.blocks.find(block => block.id === cta!.id)?.media).toContainEqual(expect.objectContaining({ asset_id: featured.asset_id, slot: 'featured', public_url: featured.public_url, alt_text: authoredAlt }))
        const rendered = await openTenantPage(page, `${tenant.baseURL}/`, tenant.headers)
        expect(rendered?.status()).toBe(200)
        await picture.scrollIntoViewIfNeeded()
        await expect(picture).toBeVisible()
        await expect(picture).toHaveAttribute('src', featured.public_url)
        await expect(picture).toHaveAttribute('alt', authoredAlt)
        await expect.poll(() => picture.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      } finally {
        const restored = await request.patch(`${mediaPath}/${featured.asset_id}`, { data: { alt_text: original[0]!.alt_text } })
        expect(restored.status(), await restored.text()).toBe(200)
        expect(await restored.json()).toEqual({ updated: true })
        const assetRead = await request.get(mediaPath, { params: { id: featured.asset_id } })
        expect(assetRead.status(), await assetRead.text()).toBe(200)
        expect((await assetRead.json()).media).toEqual([expect.objectContaining({ id: featured.asset_id, alt_text: original[0]!.alt_text })])
        const publicRead = await request.get(`${tenant.baseURL}/api/public/pages`, { headers: tenant.headers, params: { path: '/' } })
        expect(publicRead.status(), await publicRead.text()).toBe(200)
        expect((await publicRead.json() as AuthoredPage).page.blocks.find(block => block.id === cta!.id)?.media).toContainEqual(expect.objectContaining({ asset_id: featured.asset_id, slot: 'featured', alt_text: original[0]!.alt_text }))
        const rendered = await page.reload({ waitUntil: 'load' })
        expect(rendered?.status()).toBe(200)
        await expect(picture).toHaveAttribute('src', featured.public_url)
        await expect(picture).toHaveAttribute('alt', original[0]!.alt_text ?? '')
      }
    } finally {
      await releaseTenantMutationLock()
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
  type Night = { date: string; available: boolean; price_minor: number | null; min_stay_arrival: number; min_stay_through: number | null; max_stay: number | null; closed_to_arrival: boolean; closed_to_departure: boolean }
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
    let minimum = arrival.min_stay_arrival
    for (let end = start; end < nights.length - 1; end++) {
      if (!nights[end]!.available) break
      minimum = Math.max(minimum, nights[end]!.min_stay_through ?? 1)
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
  await dialog.getByRole('button', { name: dayLabel(checkIn.date), exact: true }).click()
  await expect(dialog).toContainText('Select checkout date')
  // A checkout short of the minimum is not offered.
  if (minimum > 1) {
    const arrivalHint = checkIn.min_stay_arrival > 1 ? ` · ${checkIn.min_stay_arrival}-night minimum` : ''
    await expect(dialog.getByRole('button', { name: `${dayLabel(stayed[1]!.date)}${arrivalHint}`, exact: true })).toBeDisabled()
  }
  await dialog.getByRole('button', { name: new RegExp(`^${dayLabel(checkOut)}`) }).click()
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
  await expect(dialog.getByRole('button', { name: dayLabel(checkIn.date), exact: true })).toHaveAttribute('aria-pressed', 'true')
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
    await loginAs(request, testBaseUrl(), process.env.PLAYWRIGHT_PREVIEW_URL ? undefined : 'user-e2e-ncls-owner')
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
