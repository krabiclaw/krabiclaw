import { expect, test, type Page } from '@playwright/test'
import { marked } from 'marked'
import {
  blawbyBaseURL, blawbyExtraHeaders,
  openTenantPage, potteryHouseBaseURL, potteryHouseExtraHeaders, waitForNuxtHydration,
} from './helpers'
import { testBaseUrl, tenantTestBaseUrl, tenantTestExtraHeaders } from './test-env'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import mcpCatalog from '../../server/utils/mcp-catalog-snapshots/tenant.json' with { type: 'json' }
import { environmentTenantAliasHostname } from '../../server/utils/tenant-hosts'

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
  for (const tenant of [
    { slug: 'krabiclaw-review-legal', documentId: 'ade2018e-693d-4b0e-8025-daf3143abb8a', locationIds: ['loc-554dde4c-3dcf-406f-ab9d-82038dd1b70c'] },
    { slug: 'krabiclaw-onboarding-check', documentId: '8780bc6a-6e90-4db6-aac3-2cb1048fbe28', locationIds: ['e151c459-0437-477a-a27e-bb360128b43d', 'loc-5b52502a-0a3e-4410-b14c-d3662f74ae43'] },
    { slug: 'cedar-legal-demo', documentId: 'cd961dbe-9250-4878-b05b-b7fe1e95591d', locationIds: ['loc-abce1341-c462-4e8d-ab8c-f4f6657f07cf'] },
  ]) {
    const headers = { 'x-preview-tenant': tenant.slug }
    const response = await request.get(`${testBaseUrl()}/api/public/blawby/document`, { headers, params: { recipe: 'contact' } })
    expect(response.status(), await response.text()).toBe(200)
    const document = await response.json() as { route: { page: { id: string; blocks: Array<{ id: string; type: string; data: { title?: string; description?: string; location_ids?: string[]; items?: Array<{ id: string }> } }> } } }
    expect(document.route.page.id).toBe(tenant.documentId)
    expect(document.route.page.blocks.map(block => block.type)).toEqual(['hero', 'location_grid', 'contact_form'])
    expect(document.route.page.blocks[1]).toMatchObject({ id: `block-contact-locations-${tenant.documentId}`, data: { title: 'Our locations', description: 'Contact', location_ids: tenant.locationIds } })
    expect(document.route.page.blocks[1]!.data.items!.map(item => item.id)).toEqual(tenant.locationIds)
    expect(document.route.page.blocks[2]!.id).toBe(`block-contact-form-${tenant.documentId}`)
    await page.unrouteAll()
    const rendered = await openTenantPage(page, `${testBaseUrl()}/contact`, headers)
    expect(rendered?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Our locations', exact: true })).toBeVisible()
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
  ...['/about', '/contact', '/schedule'].map(path => ({ name: 'Blawby', organizationId: 'org-ncls-blawby', baseURL: blawbyBaseURL, headers: blawbyExtraHeaders, path, schemaType: 'LegalService' })),
  { name: 'Cedar Legal Demo', organizationId: '5WebMejsoVLyZLHC29wHH5GbQx1jlvCd', baseURL: testBaseUrl(), headers: { 'x-preview-tenant': 'cedar-legal-demo' }, path: '/contact', ownerId: 'ivUlJc9BoyZeFszowpbUEjh1pugcDHiT', schemaType: 'ProfessionalService' },
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
      if ('ownerId' in tenant) expect(original.blocks.map(block => block.type)).toEqual(['hero', 'location_grid', 'contact_form'])
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

for (const width of [390, 1440]) {
  test(`KrabiClaw MCP reference has usable anchors and contained tables at ${width}px`, async ({ page, request }, testInfo) => {
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
    test(`KrabiClaw workflow ${slug} renders its guidance and media at ${width}px`, async ({ page }) => {
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
  // Autoplay may advance during page load; select the first card through the carousel.
  await page.locator('[data-social-posts=block]').getByRole('tab', { name: 'Go to slide 1', exact: true }).click()
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

// A listed place to stay on staging, Stripe test mode ready: the booking card
// opens the dialog and walks a guest to the contact step. Nothing is submitted.
// Its pressed "Check availability" once flipped the dialog's checkbox shut.
const STAGING_STAY = { tenant: 'saltleaf-stays-demo', path: '/stays/saltleaf-ocean-avenue-studio', slug: 'saltleaf-ocean-avenue-studio' }

test('a guest opens a stay\'s booking dialog, picks nights the calendar allows and reaches the contact step', async ({ page }) => {
  const platform = new URL(testBaseUrl())
  test.skip(platform.hostname !== 'staging.krabiclaw.com', 'The listed stay with online payments exists on staging only')
  const baseURL = `https://${environmentTenantAliasHostname(platform.hostname, STAGING_STAY.tenant)}`
  type Night = { date: string; available: boolean; price_minor: number | null; min_stay_arrival: number; min_stay_through: number | null; max_stay: number | null; closed_to_arrival: boolean; closed_to_departure: boolean }
  const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const to = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10)
  const read = await page.request.get(`${baseURL}/api/public/products/${STAGING_STAY.slug}/nights?from=${from}&to=${to}`)
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
  expect(chosen, 'the staging stay has no bookable nights in the next 120 days').not.toBeNull()
  const dayLabel = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
  const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: home.currency }).format(minor / 100)

  await page.setViewportSize({ width: 1440, height: 900 })
  expect((await openTenantPage(page, `${baseURL}${STAGING_STAY.path}`, {}))?.status()).toBe(200)
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
  if (minimum > 1) await expect(dialog.getByRole('button', { name: dayLabel(stayed[1]!.date), exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: new RegExp(`^${dayLabel(checkOut)}`) }).click()
  const total = money(stayed.reduce((sum, night) => sum + night.price_minor!, 0))
  const totalRow = dialog.locator('dl > div').last()
  await expect(totalRow.locator('dt')).toHaveText('Total')
  await expect(totalRow.locator('dd')).toHaveText(total)
  await dialog.getByRole('button', { name: 'Reserve', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Full name' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Confirm and pay', exact: true })).toBeEnabled()

  // Closed, the card reads the stay back; its dates reopen the calendar.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(card.getByText(dayLabel(checkIn.date), { exact: true })).toBeVisible()
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
