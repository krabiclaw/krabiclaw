import { expect, test } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { articleFacebookPostPath, blogCreatePath, insightsPath } from '../../server/utils/dashboard-links'
import { addLocalDays } from '../../utils/timezone'

const orgSlug = 'ember-slice-demo'
const organizationId = 'org-demo'
const editor = `/api/editor/organizations/${organizationId}`

test.beforeEach(async ({ page, baseURL }) => {
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-demo-owner')
})

test('an article created from a direct action prepares a Facebook draft without publishing it', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'Authoring writes require local D1.')
  await page.setViewportSize({ width: 900, height: 900 })
  let articleId: string | null = null
  let postId: string | null = null
  const createdTitle = `E2E Today article ${Date.now()}`
  const title = `${createdTitle} revised`
  const excerpt = 'An article prepared for a deliberate Facebook review.'
  try {
    expect((await page.goto(blogCreatePath(orgSlug)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const headline = page.locator('#dashboard-panel-organization-blog-new-headline')
    await expect(headline.getByRole('button', { name: 'Create article', exact: true })).toBeDisabled()
    await headline.getByRole('textbox', { name: 'Headline*', exact: true }).fill(createdTitle)
    const created = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/blog/posts` && response.request().method() === 'POST')
    await headline.getByRole('button', { name: 'Create article', exact: true }).click()
    const createResponse = await created
    expect(createResponse.status(), await createResponse.text()).toBe(200)
    articleId = (await createResponse.json() as { id: string }).id
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}`)

    const draftRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(draftRead.status()).toBe(200)
    const article = mcpData<{ post: { title: string; status: string; updated_at: string } }>(await draftRead.json()).post
    expect(article).toMatchObject({ title: createdTitle, status: 'draft' })

    const articlePanel = page.locator('#dashboard-panel-organization-blog-post')
    const canvasTitle = articlePanel.getByRole('textbox', { name: 'Post title', exact: true })
    const saveArticle = articlePanel.getByRole('button', { name: 'Save', exact: true })
    const articleSettings = articlePanel.getByRole('button', { name: 'Article settings', exact: true })
    const translations = articlePanel.getByTestId('localize-resource')
    await expect(canvasTitle).toHaveValue(createdTitle)
    await expect(saveArticle).toBeDisabled()
    await canvasTitle.fill(title)
    await expect(saveArticle).toBeEnabled()
    await canvasTitle.fill(createdTitle)
    await expect(saveArticle).toBeDisabled()
    await canvasTitle.fill(title)

    const articlePath = `${editor}/blog/${articleId}`
    const interceptArticle = (url: URL) => url.pathname === articlePath
    let releaseWrite: (() => void) | undefined
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve })
    await page.route(interceptArticle, async route => {
      if (route.request().method() === 'PATCH') await writeReleased
      await route.continue()
    })
    const saveRequested = page.waitForRequest(request => new URL(request.url()).pathname === articlePath && request.method() === 'PATCH')
    const saveResponse = page.waitForResponse(response => new URL(response.url()).pathname === articlePath && response.request().method() === 'PATCH')
    let requestStarted = false
    try {
      await saveArticle.click()
      await saveRequested
      requestStarted = true
      await expect(saveArticle).toBeDisabled()
      await expect(articleSettings).toBeDisabled()
      await expect(translations).toHaveAttribute('aria-disabled', 'true')
    } finally {
      releaseWrite?.()
      if (requestStarted) await saveResponse
      await page.unroute(interceptArticle)
    }
    const saved = await saveResponse
    expect(saved.status(), await saved.text()).toBe(200)
    await expect(articleSettings).toBeEnabled()
    await expect(translations).not.toHaveAttribute('aria-disabled', 'true')
    await expect(saveArticle).toBeDisabled()
    const savedRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(savedRead.status()).toBe(200)
    const savedArticle = mcpData<{ post: { title: string; status: string; updated_at: string } }>(await savedRead.json()).post
    expect(savedArticle).toMatchObject({ title, status: 'draft' })
    const categoriesRead = await page.request.get(`${editor}/blog/categories`, { params: { collection: 'blog' } })
    expect(categoriesRead.status(), await categoriesRead.text()).toBe(200)
    const kitchen = (await categoriesRead.json() as { categories: Array<{ id: string; name: string }> }).categories.filter(category => category.name === 'Kitchen')
    expect(kitchen, 'The demo blog has one existing Kitchen category').toHaveLength(1)
    // Continue the author's real workflow: choose the blog's real category,
    // write its body, and publish explicitly before preparing a social post.
    const update = await page.request.patch(`${editor}/blog/${articleId}`, { data: {
      excerpt, category_id: kitchen[0]!.id, expected_updated_at: savedArticle.updated_at,
      content_blocks: [{ type: 'markdown', data: { markdown: 'An authored article body for the Today action journey.', editor_mode: 'rich' } }],
    } })
    expect(update.status(), await update.text()).toBe(200)
    const updated = (await update.json() as { post: { updated_at: string } }).post
    const published = await page.request.post(`${editor}/blog/${articleId}/publish`, { data: { expected_updated_at: updated.updated_at } })
    expect(published.status(), await published.text()).toBe(200)

    const sourceRead = await page.request.get(`${editor}/blog/${articleId}`)
    expect(sourceRead.status()).toBe(200)
    const source = (await sourceRead.json() as { post: { status: string; public_path: string; category: { id: string; name: string } | null } }).post
    expect(source.status).toBe('published')
    expect(source.category).toMatchObject({ id: kitchen[0]!.id, name: 'Kitchen' })
    const contextRead = await page.request.get('/api/dashboard/context', { params: { org: orgSlug } })
    expect(contextRead.status()).toBe(200)
    const context = await contextRead.json() as { organization: { public_url: string } }
    const articleUrl = new URL(source.public_path, context.organization.public_url).toString()
    const postWrites: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(`${editor}/posts`)) postWrites.push(new URL(request.url()).pathname)
    })
    expect((await page.goto(articleFacebookPostPath(orgSlug, articleId)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const caption = page.locator('#dashboard-panel-post-body')
    await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(`${title}\n\n${excerpt}`)
    await caption.getByRole('textbox', { name: 'Caption', exact: true }).fill('Discard this unsaved caption')
    // Cancelling a step leaves the making and discards its draft; the action opens it fresh.
    await caption.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/posts?article_id=${articleId}&channel=facebook`)
    expect((await page.goto(articleFacebookPostPath(orgSlug, articleId)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(`${title}\n\n${excerpt}`)
    expect(postWrites).toEqual([])
    const postCreated = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/posts` && response.request().method() === 'POST')
    await caption.getByRole('button', { name: 'Create post', exact: true }).click()
    const postResponse = await postCreated
    expect(postResponse.status(), await postResponse.text()).toBe(201)
    postId = (await postResponse.json() as { post: { id: string } }).post.id
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/posts/${postId}/publishing?channel=facebook`)
    await expect(page.locator('#dashboard-panel-post-publishing')).toBeVisible()
    const postRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: postId } })
    expect(postRead.status()).toBe(200)
    const post = mcpData<{ post: { title: string; body: string; status: string; published_at: string | null; call_to_action: { label: string; url: string }; publications: unknown[] } }>(await postRead.json()).post
    expect(post).toMatchObject({ title, body: `${title}\n\n${excerpt}`, status: 'draft', published_at: null, call_to_action: { label: 'Read article', url: articleUrl }, publications: [] })
    expect(postWrites).toEqual([`${editor}/posts`])
  } finally {
    if (postId) {
      const removed = await page.request.delete(`${editor}/posts/${postId}`)
      expect(removed.status(), await removed.text()).toBe(200)
    }
    if (articleId) {
      const removed = await page.request.delete(`${editor}/blog/${articleId}`)
      expect(removed.status(), await removed.text()).toBe(200)
    }
  }
})

test('Insights reads a linked report period and preserves preset changes in its URL', async ({ page }) => {
  const range = { startDate: '2026-09-01', endDate: '2026-09-07' }
  const linkedPath = insightsPath(orgSlug, range)
  const isReport = (response: import('@playwright/test').Response) => new URL(response.url()).pathname === '/api/dashboard/analytics'
  expect((await page.goto(linkedPath))?.status()).toBe(200)
  await waitForNuxtHydration(page)
  const reportPeriod = page.getByTestId('insights-period').locator('time')
  await expect(reportPeriod.nth(0)).toHaveAttribute('datetime', range.startDate)
  await expect(reportPeriod.nth(1)).toHaveAttribute('datetime', range.endDate)
  const linkedUrl = new URL(page.url())
  const first = await page.request.get('/api/dashboard/analytics', { params: { org: orgSlug, startDate: linkedUrl.searchParams.get('startDate')!, endDate: linkedUrl.searchParams.get('endDate')! } })
  expect(first.status(), await first.text()).toBe(200)
  expect((await first.json() as { report: { period: typeof range } }).report.period).toMatchObject(range)
  await expect(page.getByText('Traffic trend', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '7d', exact: true })).toHaveAttribute('aria-pressed', 'false')

  await page.reload()
  await waitForNuxtHydration(page)
  await expect(reportPeriod.nth(0)).toHaveAttribute('datetime', range.startDate)
  await expect(reportPeriod.nth(1)).toHaveAttribute('datetime', range.endDate)
  const presetReport = page.waitForResponse(isReport)
  await page.getByRole('button', { name: '7d', exact: true }).click()
  const preset = await presetReport
  expect(preset.status(), await preset.text()).toBe(200)
  const period = (await preset.json() as { report: { period: typeof range } }).report.period
  expect(period.startDate).toBe(addLocalDays(period.endDate, -6))
  await expect(page).toHaveURL(insightsPath(orgSlug, { startDate: period.startDate, endDate: period.endDate }))
  await expect(page.getByRole('button', { name: '7d', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
