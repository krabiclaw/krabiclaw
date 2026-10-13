import { expect, test, type Page } from '@playwright/test'
import { marked } from 'marked'
import {
  blawbyBaseURL, blawbyExtraHeaders,
  openTenantPage, potteryHouseBaseURL, potteryHouseExtraHeaders, waitForNuxtHydration,
} from './helpers'
import { testBaseUrl } from './test-env'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import mcpCatalog from '../../server/utils/mcp-catalog-snapshots/tenant.json' with { type: 'json' }

// Two tenants stand in for the two shells this renderer produces: Pottery
// House on .tenant-layout and NCLS on .blawby-shell. Kikuzuki renders through
// the same Saya shell as Pottery and is exercised by tenant-client-navigation,
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
    shell: '.blawby-shell', identity: /North Carolina Legal Services/i,
    definingContent: /Access to Justice|affordable legal services/i,
    primaryLabel: /services|get started|consultation/i, detailPath: '/services/family',
    detailContent: /Family Law|child custody|divorce/i, themeVar: '--ui-bg',
    forbidden: [/Ember & Slice/i, /No services/i],
  },
]

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

test('Krabiclaw pricing retains its billing plans after hydration', async ({ page }) => {
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

for (const width of [390, 1440]) {
  test(`Krabiclaw MCP reference has usable anchors and contained tables at ${width}px`, async ({ page, request }, testInfo) => {
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
    if (width === 390) expect(horizontalScroll, 'Narrow tables must remain independently scrollable').not.toBeNull()
    if (horizontalScroll) expect(horizontalScroll).toEqual({ tableMoved: true, pageLeft: 0 })
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
    await page.screenshot({ path: testInfo.outputPath(`mcp-reference-${width}px.png`), animations: 'disabled' })
    await menuHeading.locator('xpath=following-sibling::table[1]').screenshot({ path: testInfo.outputPath(`mcp-reference-menu-table-${width}px.png`), animations: 'disabled' })
  })

  for (const { slug } of mcpCatalog.publicDocumentation) {
    test(`Krabiclaw workflow ${slug} renders its guidance and media at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const source = await page.request.get(`${testBaseUrl()}/api/public/blog/${slug}?collection=docs`)
      expect(source.status()).toBe(200)
      const { post } = await source.json() as { post: { title: string; content_blocks: Array<{ type: string; data: Record<string, unknown>; media: Array<{ alt_text: string; public_url: string }> }> } }
      const markdown = post.content_blocks.filter(block => block.type === 'markdown').map(block => String(block.data.markdown)).join('\n\n')
      const authored = await page.evaluate(html => {
        const document = new DOMParser().parseFromString(html, 'text/html')
        return {
          intro: document.querySelector('p')?.textContent ?? '',
          images: [...document.querySelectorAll('img')].map(image => ({
            alt: image.alt,
            caption: image.parentElement?.nextElementSibling?.tagName === 'P' ? image.parentElement.nextElementSibling.textContent ?? '' : '',
          })),
        }
      }, marked.parse(markdown, { async: false }))
      const images = [...authored.images, ...post.content_blocks.filter(block => block.type === 'image').map(block => ({
        alt: block.media[0]!.alt_text, caption: String(block.data.caption ?? ''),
      }))]
      expect(authored.intro.length, 'A workflow needs substantive opening guidance').toBeGreaterThan(60)
      const response = await openTenantPage(page, `${testBaseUrl()}/docs/${slug}`, {})
      expect(response?.status()).toBe(200)
      await waitForNuxtHydration(page)
      const article = page.locator('article.blog-article')
      await expect(article.getByRole('heading', { name: post.title, exact: true, level: 1 })).toBeVisible()
      await expect(article.locator('.prose').first()).toContainText(authored.intro)
      await expect(article.locator('a[href^="/docs/mcp-tool-reference"]').first()).toBeVisible()
      await expect(article.locator('figure img, .prose img')).toHaveCount(images.length)
      for (const image of images) {
        expect(image.alt.trim()).not.toBe('')
        const picture = article.getByRole('img', { name: image.alt, exact: true })
        await expect(picture).toBeVisible()
        await expect.poll(() => picture.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
        if (image.caption) await expect(article.getByText(image.caption, { exact: true })).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    })
  }

  test(`Krabiclaw policies render their own headers and body at ${width}px`, async ({ page }) => {
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
    }
    expect(errors).toEqual([])
  })
}

test('Krabiclaw social viewer keyboard navigation changes the visible media', async ({ page }) => {
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
  // The viewer opens on the card that was clicked; the first card puts the first picture at the top.
  await firstCard.click()
  const viewer = page.getByRole('dialog', { name: 'Media Lightbox' })
  await expect(viewer).toBeVisible()
  const pictures = viewer.locator('section')
  const mediaBounds = await pictures.first().locator('img:not([aria-hidden]), video').boundingBox()
  const captionBounds = await pictures.first().locator('p').boundingBox()
  expect(mediaBounds).not.toBeNull()
  expect(captionBounds).not.toBeNull()
  expect(captionBounds!.x >= mediaBounds!.x + mediaBounds!.width || captionBounds!.y >= mediaBounds!.y + mediaBounds!.height).toBe(true)
  expect(await pictures.count()).toBeGreaterThan(1)
  const close = viewer.getByRole('button', { name: 'Close', exact: true })
  await close.press('ArrowDown')
  await expect.poll(() => pictures.nth(1).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0)
  await expect.poll(() => pictures.nth(1).locator('img:not([aria-hidden]), video').evaluate(element => element instanceof HTMLVideoElement ? element.videoWidth : (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
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
  await trigger.click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()
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
  await viewer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(viewer).toHaveCount(0)
})

for (const tenant of tenants) {
  test(`${tenant.name} renders home and detail routes on desktop`, async ({ page }) => {
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
  })
}

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

  // What the navigation says, not how it lays out: whether it wraps or overflows
  // is what a browser at that width shows you in a second.
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
  })

  // One reader walking the site. Each route is a different page recipe, so the
  // traversal is the coverage; six separate fixtures were not.
  test('renders every route reachable from the header', async ({ page }) => {
    const journeys = [
      { path: '/pricing', text: /pricing|income|calculator/i },
      { path: '/article/writing-your-own-will-how-it-works', text: /will|North Carolina/i },
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
        + ':not([data-parity-section="shield-divider"])'
        + ':not([data-parity-section="consultation"])')
      expect(await body.count(), `${journey.path} renders no section of its own`).toBeGreaterThan(0)
      // And those sections have to say something. /policies/privacy kept a
      // callout holding 19 bytes, which is a section by every structural measure
      // and a blank page to the reader. The thinnest real page here carries ~870
      // characters, so 200 fails an empty body without tracking the copy.
      const bodyText = (await body.allInnerTexts()).join(' ').trim()
      expect(bodyText.length, `${journey.path} body sections are empty`).toBeGreaterThan(200)
    }
  })
})
