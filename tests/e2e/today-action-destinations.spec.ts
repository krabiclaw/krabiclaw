import { expect, test } from '@playwright/test'
import { dismissPreviewToolbar, openTenantPage, waitForNuxtHydration } from './helpers'
import { seededSiteHeaders, seededSiteURL } from './test-env'
import { seededTenant } from './seed/manifest'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { blogCreatePath } from '../../server/utils/dashboard-links'

const orgSlug = 'ember-slice-demo'
let organizationId: string
let editor: string

test.beforeEach(async ({ page, baseURL }) => {
  organizationId = seededTenant('restaurant').organizationId
  editor = `/api/editor/organizations/${organizationId}`
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-demo-owner')
})

test('a new article publishes its composed body directly and retries publication without creating another article', async ({ page, browser, baseURL }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'Authoring writes require local D1.')
  await page.setViewportSize({ width: 1440, height: 900 })
  const title = `E2E Direct article ${Date.now()}`
  const body = 'The author wrote this complete article before choosing Publish.'
  let articleId: string | null = null
  const creates: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `${editor}/blog/posts`) creates.push(new URL(request.url()).pathname)
  })
  const interceptPublish = (url: URL) => url.pathname.startsWith(`${editor}/blog/`) && url.pathname.endsWith('/publish')
  try {
    const categoriesRead = await page.request.get(`${editor}/blog/categories`, { params: { collection: 'blog' } })
    expect(categoriesRead.status(), await categoriesRead.text()).toBe(200)
    const kitchen = (await categoriesRead.json() as { categories: Array<{ id: string; name: string }> }).categories.filter(category => category.name === 'Kitchen')
    expect(kitchen, 'The demo has its existing Kitchen category').toHaveLength(1)
    expect((await page.goto(blogCreatePath(orgSlug)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const canvas = page.locator('#dashboard-panel-organization-blog-post')
    const publish = canvas.getByRole('button', { name: 'Publish', exact: true })
    await expect(publish).toBeDisabled()
    await canvas.getByRole('textbox', { name: 'Post title', exact: true }).fill(title)
    await canvas.getByRole('combobox', { name: 'Category', exact: true }).click()
    await page.getByRole('option', { name: 'Kitchen', exact: true }).click()
    await canvas.getByRole('button', { name: 'Add a cover photo', exact: true }).click()
    const pendingImage = canvas.locator('[data-block-index="0"]')
    await expect(pendingImage.getByText('Click to browse', { exact: true })).toBeVisible()
    await expect(publish).toBeDisabled()
    await pendingImage.focus()
    await pendingImage.press('Delete')
    await canvas.locator('.blog-article [contenteditable="true"]').fill(body)
    const categoriesPopup = page.waitForEvent('popup')
    await canvas.getByRole('link', { name: 'Manage categories (opens in a new tab)', exact: true }).click()
    const categoriesPage = await categoriesPopup
    await expect(categoriesPage).toHaveURL(`/dashboard/${orgSlug}/website/blog/categories?collection=blog`)
    await waitForNuxtHydration(categoriesPage)
    await categoriesPage.close()
    await page.bringToFront()
    await expect(canvas.getByRole('textbox', { name: 'Post title', exact: true })).toHaveValue(title)
    await expect(canvas.locator('.blog-article [contenteditable="true"]')).toHaveText(body)
    await expect(canvas.getByRole('combobox', { name: 'Category', exact: true })).toContainText('Kitchen')
    expect(creates).toEqual([])
    let refused = false
    await page.route(interceptPublish, async route => {
      if (!refused && route.request().method() === 'POST') {
        refused = true
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Article publication failed for retry verification' }) })
      } else await route.continue()
    })
    const created = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/blog/posts` && response.request().method() === 'POST')
    await publish.click()
    const createResponse = await created
    expect(createResponse.status(), await createResponse.text()).toBe(200)
    articleId = (await createResponse.json() as { id: string }).id
    await expect(canvas.getByRole('alert')).toHaveText('Article publication failed for retry verification')
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/new`)
    const draftRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(draftRead.status()).toBe(200)
    expect(mcpData<{ post: { title: string; status: string; content_blocks: Array<{ type: string; data: { markdown: string } }> } }>(await draftRead.json()).post)
      .toMatchObject({ title, status: 'draft', content_blocks: [{ type: 'markdown', data: { markdown: body } }] })
    const published = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/blog/${articleId}/publish` && response.request().method() === 'POST')
    await publish.click()
    const publishResponse = await published
    expect(publishResponse.status(), await publishResponse.text()).toBe(200)
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}`)
    expect(creates).toEqual([`${editor}/blog/posts`])
    const read = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(read.status()).toBe(200)
    const article = mcpData<{ post: { title: string; status: string; public_path: string; category: { id: string; name: string }; content_blocks: Array<{ type: string; data: { markdown: string } }> } }>(await read.json()).post
    expect(article).toMatchObject({ title, status: 'published', category: { id: kitchen[0]!.id, name: kitchen[0]!.name }, content_blocks: [{ type: 'markdown', data: { markdown: body } }] })
    const listRead = await page.request.get(`${editor}/blog/posts`, { params: { collection: 'blog' } })
    expect(listRead.status(), await listRead.text()).toBe(200)
    expect((await listRead.json() as { posts: Array<{ id: string; title: string }> }).posts.filter(post => post.title === title).map(post => post.id)).toEqual([articleId])
    // An anonymous visitor, with no owner session, reads the published article.
    const anonymous = await browser.newContext()
    try {
      const visitor = await anonymous.newPage()
      const response = await openTenantPage(visitor, new URL(article.public_path, seededSiteURL('restaurant')).toString(), seededSiteHeaders('restaurant'))
      expect(response?.status()).toBe(200)
      await expect(visitor.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible()
      await expect(visitor.locator('main')).toContainText(body)
      await expect(visitor.getByText(body, { exact: true })).toBeVisible()
    } finally { await anonymous.close() }
  } finally {
    await page.unroute(interceptPublish)
    if (articleId) {
      const removed = await page.request.delete(`${editor}/blog/${articleId}`)
      expect(removed.status(), await removed.text()).toBe(200)
      expect((await page.request.get(`${editor}/blog/${articleId}`)).status()).toBe(404)
    }
  }
})
