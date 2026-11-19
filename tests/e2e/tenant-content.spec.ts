import { expect, test } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, seededSiteURL, testBaseUrl } from './test-env'

// Tenant behaviour that writes content or reads local-only routing. Real
// customer content is checked read-only against deployed sites in tests/deployed.

test('unknown sites render an unbranded 404 while resolved tenant errors retain their identity', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const unknown = await openTenantPage(page, `${testBaseUrl()}/`, { 'x-preview-tenant': 'no-such-organization' })
  expect(unknown?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  await expect(page.getByText('Error 404', { exact: true })).toBeVisible()
  const practice = seededTenant('legal')
  expect(await page.locator('body').innerText()).not.toMatch(new RegExp(`Krabi[Cc]law|${seededTenant('restaurant').name}|${practice.name}`))
  await page.unrouteAll()
  const missing = await openTenantPage(page, `${seededSiteURL('legal')}/no-such-page`, seededSiteHeaders('legal'))
  expect(missing?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: practice.name, exact: true })).toBeVisible()
  const unsupported = await page.goto(`${seededSiteURL('legal')}/templates`)
  expect(unsupported?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('old public logo URLs redirect to the renamed PNG assets', async ({ request, baseURL }) => {
  for (const asset of ['logo', 'logo-192', 'maskable-192', 'maskable-512']) {
    const target = `/blawby-${asset}.png`
    const legacy = await request.get(`/krabi-claw-${asset}.png`, { maxRedirects: 0 })
    expect(legacy.status()).toBe(301)
    expect(new URL(legacy.headers().location!, baseURL).pathname).toBe(target)
    const image = await request.get(target)
    expect(image.status()).toBe(200)
    expect(image.headers()['content-type']).toContain('image/png')
    expect((await image.body()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  }
})

test('the platform publishes its localized homepage and includes its canonical URL in the sitemap', async ({ page, request, baseURL }) => {
  const translations = [
    ['ja', 'ウェブサイトを数分で公開'],
    ['zh-Hans', '几分钟内发布网站'],
    ['zh-Hant', '幾分鐘內發佈網站'],
  ] as const
  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.status()).toBe(200)
  const xml = await sitemap.text()
  for (const [locale, heading] of translations) {
    const response = await page.goto(`/${locale}/`)
    expect(response?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    const canonical = new URL(`/${locale}`, baseURL).href
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonical)
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute('href', new URL('/', baseURL).href)
    for (const [alternate] of translations) {
      await expect(page.locator(`link[rel="alternate"][hreflang="${alternate}"]`)).toHaveAttribute('href', new URL(`/${alternate}`, baseURL).href)
    }
    expect(xml).toContain(`<loc>${canonical}</loc>`)
  }
  expect(xml).not.toContain(`<loc>${new URL('/zz', baseURL).href}</loc>`)
  const unknown = await request.get('/zz/')
  expect(unknown.status()).toBe(404)
})

test('tenant blog search opens an article from its body and excludes another tenant', async ({ page, request }) => {
  const articleTitle = 'Preparing for your legal consultation'
  await openTenantPage(page, new URL('/blog', seededSiteURL('legal')).href, seededSiteHeaders('legal'))
  await waitForNuxtHydration(page)
  await expect(page.locator('link[rel=preconnect][href="https://media.blawby.com"]')).toHaveCount(1)
  await page.getByRole('button', { name: /search/i }).filter({ visible: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill('relevant documents')
  await dialog.getByRole('button', { name: new RegExp(articleTitle) }).click()
  await expect(page).toHaveURL(/\/blog\/preparing-for-your-legal-consultation/)
  await expect(page.getByRole('heading', { name: articleTitle, exact: true })).toBeVisible()

  const otherSite = await request.get('/api/public/search', {
    headers: seededSiteHeaders('restaurant'),
    params: { surface: 'tenant_blog', q: 'relevant documents' },
  })
  expect(otherSite.status(), await otherSite.text()).toBe(200)
  await expect(otherSite.json()).resolves.toMatchObject({ results: [] })
})

test('MCP publication makes a listed legal article without a cover public', async ({ request, playwright, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-ncls-owner')
  const tenant = seededTenant('legal')
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const response = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName, args: { ...args, organization_id: tenant.organizationId },
    })
    expect(response.status()).toBe(200)
    return response.json()
  }
  const { categories } = mcpData<{ categories: Array<{ id: string; name: string }> }>(await call('list_article_categories', { collection: 'blog' }))
  const category = categories.find(item => item.name === 'Client guides')
  expect(category).toBeDefined()
  const key = crypto.randomUUID()
  const title = `Documents for a legal consultation ${key}`
  const body = 'Bring copies of the letters you received from your school.'
  const draftArgs = {
    category_id: category!.id, title, idempotency_key: key, visibility: 'listed',
    content_blocks: [{ type: 'markdown', data: { markdown: body, editor_mode: 'rich' } }],
  }
  const draft = await call('create_blog_post', draftArgs)
  const { post } = mcpData<{ post: { id: string; updated_at: string; public_path: string; preview_url: string; public_url: null; cover: null } }>(draft)
  expect(post.cover).toBeNull()
  expect(post.public_url).toBeNull()
  expect(new URL(post.preview_url).searchParams.get('preview_token')).toBeTruthy()
  expect(draft.result.content[0].text).toContain(`[Preview article](<${post.preview_url}>)`)
  const guest = await playwright.request.newContext({ baseURL: seededSiteURL('legal'), extraHTTPHeaders: seededSiteHeaders('legal') })
  try {
    const initialIndex = await guest.get('/blog')
    expect(initialIndex.status()).toBe(200)
    expect(await initialIndex.text()).not.toContain(post.public_path)

    const stale = await call('publish_blog_post', { post_id: post.id, updated_at: '2000-01-01T00:00:00.000Z' })
    expect(stale.result.isError).toBe(true)
    expect(JSON.parse(stale.result.content[0].text)).toMatchObject({ status: 409 })
    expect((await guest.get(post.public_path)).status()).toBe(404)

    const receipt = await call('publish_blog_post', { post_id: post.id, updated_at: post.updated_at })
    const published = mcpData<{ changed: boolean; post: { public_url: string } }>(receipt)
    expect(published).toMatchObject({ changed: true, post: { id: post.id, status: 'published', published: true, visibility: 'listed' } })
    expect(new URL(published.post.public_url).pathname).toBe(post.public_path)
    expect(receipt.result.content[0].text).toContain(`[View article](<${published.post.public_url}>)`)
    const publicArticle = await guest.get(post.public_path)
    expect(publicArticle.status()).toBe(200)
    expect(await publicArticle.text()).toContain(`<p>${body}</p>`)
    const publicIndex = await guest.get('/blog')
    expect(publicIndex.status()).toBe(200)
    expect(await publicIndex.text()).toContain(`href="${post.public_path}"`)
    const replay = await call('create_blog_post', draftArgs)
    expect(mcpData(replay)).toMatchObject({ post: { id: post.id, status: 'published' } })
    expect(replay.result.content[0].text).toContain(`[View article](<${published.post.public_url}>)`)
  } finally {
    await guest.dispose()
  }
})

test('MCP post publication keeps the website link when a social destination is disconnected', async ({ request, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-ncls-owner')
  const tenant = seededTenant('legal')
  const body = 'Our Raleigh office is taking legal consultation requests.'
  const draft = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'create_post',
    args: { organization_id: tenant.organizationId, idempotency_key: crypto.randomUUID(), body },
  })
  expect(draft.status()).toBe(200)
  const draftResult = await draft.json()
  const { post } = mcpData<{ post: { id: string; updated_at: string; preview_url: string } }>(draftResult)
  expect(draftResult.result.content[0].text).toContain(`[Preview post](<${post.preview_url}>)`)

  const published = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'publish_post', args: {
      organization_id: tenant.organizationId, post_id: post.id, updated_at: post.updated_at,
      targets: [{ channel: 'organization' }, { channel: 'facebook', target_id: '1234', connection_revision: 'disconnected' }],
    },
  })
  expect(published.status()).toBe(200)
  const { result } = await published.json()
  expect(result.isError).toBe(true)
  const receipt = JSON.parse(result.content[0].text)
  expect(receipt.outcomes).toMatchObject([
    { channel: 'organization', status: 'published', public_url: expect.any(String) },
    { channel: 'facebook', status: 'skipped', code: 'not_connected' },
  ])
  const url = receipt.outcomes[0].public_url
  expect(result.content[1].text).toContain(`[View on Website](<${url}>)`)
  expect(result.content[1].text).not.toContain('[View on Facebook]')
  const publicPost = await request.get(new URL(url).pathname, { headers: seededSiteHeaders('legal') })
  expect(publicPost.status()).toBe(200)
  expect(await publicPost.text()).toContain(body)
})

test('MCP site-page saves and product publication link to the guest page or the editor', async ({ request, playwright, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-ncls-owner')
  const tenant = seededTenant('legal')
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const response = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName, args: { organization_id: tenant.organizationId, ...args },
    })
    expect(response.status()).toBe(200)
    return response.json()
  }
  type SavedPage = { id: string; page_id: string; blocks: Array<{ id: string }>; path: string; page_type: string; recipe: string | null; sort_order: number; updated_at: string; admin_edit_url: string; public_url: string | null }
  const suffix = crypto.randomUUID()
  const title = `Education consultation ${suffix}`
  const path = `/services/education-${suffix}`
  const paragraphs = (markdown: string) => [{ type: 'markdown', data: { markdown, editor_mode: 'rich' } }]
  const guest = await playwright.request.newContext({ baseURL: seededSiteURL('legal'), extraHTTPHeaders: seededSiteHeaders('legal') })
  try {
    const created = await call('create_site_page', {
      path: `/office-information-${suffix}`, title: 'Office information',
      blocks: paragraphs('The Raleigh office is open for consultations.'),
    })
    const { page: officePage } = mcpData<{ page: SavedPage }>(created)
    expect(new URL(officePage.public_url!).pathname).toBe(officePage.path)
    expect(created.result.content[0].text).toContain(`[View page](<${officePage.public_url}>)`)
    const office = await guest.get(new URL(officePage.public_url!).pathname)
    expect(office.status()).toBe(200)
    expect(await office.text()).toContain('>The Raleigh office is open for consultations.</')

    await call('add_organization_language', { locale: 'es' })
    const translation = await call('create_site_page', {
      page_id: officePage.page_id, locale: 'es', path: `/informacion-oficina-${suffix}`,
      title: 'Información de la oficina', blocks: paragraphs('La oficina de Raleigh ofrece consultas.'),
    })
    const { page: translatedPage } = mcpData<{ page: SavedPage }>(translation)
    expect(translatedPage.public_url).toBeNull()
    const translationEditor = new URL(translatedPage.admin_edit_url, baseURL).href
    expect(translation.result.content[0].text).toContain(`[Edit page](<${translationEditor}>)`)
    expect((await request.get(translationEditor, { maxRedirects: 0 })).status()).toBe(200)
    expect((await guest.get(`/es${translatedPage.path}`)).status()).toBe(404)

    const { product } = mcpData<{ product: { id: string; page: { id: string } } }>(await call('create_product', {
      idempotency_key: suffix, kind: 'service', name: title, active: true,
      order_url: 'https://scheduler.example/harbor-legal-aid',
      variants: [{ name: 'Consultation', prices: [{ unit_amount: 0, currency: 'USD' }] }],
      page: { path, title, blocks: [] },
    }))
    const { page: draft } = mcpData<{ page: SavedPage }>(await call('get_site_page', { variant_id: product.page.id }))
    const save = { variant_id: draft.id, path, title, page_type: draft.page_type, recipe: draft.recipe, sort_order: draft.sort_order }
    const edited = await call('update_site_page', {
      ...save, updated_at: draft.updated_at, blocks: paragraphs('Bring the school notices to your consultation.'),
    })
    const { page: saved } = mcpData<{ page: SavedPage }>(edited)
    expect(saved.public_url).toBeNull()
    const pageEditor = new URL(saved.admin_edit_url, baseURL).href
    expect(edited.result.content[0].text).toContain(`[Edit page](<${pageEditor}>)`)
    expect((await request.get(pageEditor, { maxRedirects: 0 })).status()).toBe(200)
    expect((await guest.get(path)).status()).toBe(404)

    const published = await call('set_product_publication', { product_id: product.id, published: true })
    const live = mcpData<{ public_url: string; published: boolean }>(published)
    expect(live.published).toBe(true)
    expect(new URL(live.public_url).pathname).toBe(path)
    expect(published.result.content[0].text).toContain(`[View product](<${live.public_url}>)`)
    const publicPage = await guest.get(new URL(live.public_url).pathname)
    expect(publicPage.status()).toBe(200)
    expect(await publicPage.text()).toContain('>Bring the school notices to your consultation.</')

    const editedLive = await call('update_site_page', {
      ...save, updated_at: saved.updated_at, removed_block_ids: saved.blocks.map(block => block.id),
      blocks: paragraphs('Bring the school notices and evaluations to your consultation.'),
    })
    const { page: updated } = mcpData<{ page: SavedPage }>(editedLive)
    expect(updated.public_url).toBe(live.public_url)
    expect(editedLive.result.content[0].text).toContain(`[View page](<${live.public_url}>)`)
    const updatedPublicPage = await guest.get(new URL(updated.public_url!).pathname)
    expect(updatedPublicPage.status()).toBe(200)
    expect(await updatedPublicPage.text()).toContain('>Bring the school notices and evaluations to your consultation.</')

    const withheld = await call('set_product_publication', { product_id: product.id, published: false })
    const privateProduct = mcpData<{ admin_edit_url: string }>(withheld)
    expect(privateProduct).toMatchObject({ published: false, public_url: null, public_urls: {} })
    expect(withheld.result.content[0].text).toContain(`[Edit product](<${privateProduct.admin_edit_url}>)`)
    expect((await request.get(privateProduct.admin_edit_url, { maxRedirects: 0 })).status()).toBe(200)
    expect((await guest.get(path)).status()).toBe(404)
  } finally {
    await guest.dispose()
  }
})

test('dashboard search opens the signed-in business’s record', async ({ page, baseURL }) => {
  const tenant = seededTenant('legal')
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
  await page.goto(`/dashboard/${tenant.slug}/menu`)
  await waitForNuxtHydration(page)
  await page.getByTestId('dashboard-search').click()
  const dialog = page.getByRole('dialog', { name: 'Search' })
  await dialog.getByPlaceholder('Search…').fill('Preparing for your legal consultation')
  const result = dialog.getByText('Preparing for your legal consultation', { exact: true })
  await expect(result).toBeVisible()
  await result.click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${tenant.slug}/website/blog/`))

  const otherSite = await page.request.get('/api/dashboard/search', {
    params: { org: seededTenant('restaurant').slug, q: 'seasonal dishes' },
  })
  expect(otherSite.status(), await otherSite.text()).toBe(404)
})

test('Blawby Support uses Blawby’s domain setup guidance to answer a paraphrased question', async ({ page }) => {
  test.slow()
  await page.goto('/help')
  await waitForNuxtHydration(page)
  await page.getByPlaceholder('Ask Blawby Support…').fill('What DNS records do I need to point my domain at my site?')
  const response = page.waitForResponse(result => result.url().endsWith('/api/public/help/agent'))
  await page.getByRole('button', { name: 'Send message' }).click()
  const answer = await response
  expect(answer.status(), await answer.text()).toBe(200)
  const body = await answer.json()
  expect(body.citations).toEqual(expect.arrayContaining([expect.objectContaining({
    id: 'faq:custom-domain',
    snippet: expect.stringContaining('add the DNS records Blawby provides'),
  })]))
  expect(body.reply).toMatch(/DNS/i)
  await expect(page.locator('.prose').filter({ hasText: /DNS/i })).toBeVisible()
})

test('Blawby Support sends an escalated chat to the platform inbox', async ({ page, browser, baseURL }) => {
  test.slow()
  const message = 'I cannot access my account and would like to open a support case.'
  await page.goto('/help')
  await waitForNuxtHydration(page)
  await expect(page.getByRole('heading', { name: 'Blawby Support', exact: true })).toBeVisible()
  await expect(page.getByText(/Hi, I’m Blawby Support/)).toBeVisible()
  await page.getByPlaceholder('Ask Blawby Support…').fill(message)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByRole('button', { name: 'Create support case', exact: true }).click()

  const form = page.getByRole('dialog', { name: 'Support case' })
  await expect(form.getByRole('textbox', { name: 'Topic' })).not.toHaveValue('')
  await expect(form.getByRole('textbox', { name: 'Message' })).toHaveValue(new RegExp(message.replace(/\./g, '\\.')))
  await form.getByRole('textbox', { name: 'Name' }).fill('Support Journey')
  await form.getByRole('textbox', { name: 'Email' }).fill('support-journey@playwright.example')
  await form.getByRole('checkbox', { name: /I consent/ }).check()

  const submission = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/contact' && response.request().method() === 'POST')
  await form.getByRole('button', { name: 'Send support request' }).click()
  const sent = await submission
  expect(sent.status(), await sent.text()).toBe(201)
  const { conversation_id } = await sent.json() as { conversation_id: string }
  await expect(page.getByText('Thanks. Your support request is on its way and the team will follow up by email.')).toBeVisible()

  const owner = await browser.newContext()
  try {
    await loginAs(owner.request, baseURL!)
    const inbox = await owner.newPage()
    await openTenantPage(inbox, new URL(`/dashboard/platform/messages/${conversation_id}`, baseURL).href, {})
    await expect(inbox.locator('[data-message]').first()).toContainText(message)
  } finally {
    await owner.close()
  }
})
