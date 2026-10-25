import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { dismissPreviewToolbar, openTenantPage, tenantBaseURL, tenantExtraHeaders, waitForNuxtHydration } from './helpers'
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

test('an article composes its first draft and preserves pending edits through conflicts and publication', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'Authoring writes require local D1.')
  await page.setViewportSize({ width: 900, height: 900 })
  let articleId: string | null = null
  let assetId: string | null = null
  const photoName = `creation-cover-${Date.now()}.avif`
  const createdTitle = `E2E Today article ${Date.now()}`
  const title = `${createdTitle} revised`
  const excerpt = 'An article prepared for a deliberate Facebook review.'
  const body = 'An authored article body for the Today action journey.'
  const articleCreates: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `${editor}/blog/posts`) articleCreates.push(new URL(request.url()).pathname)
  })
  try {
    expect((await page.goto(blogCreatePath(orgSlug)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const articlePanel = page.locator('#dashboard-panel-organization-blog-post')
    const canvasTitle = articlePanel.getByRole('textbox', { name: 'Post title', exact: true })
    const canvasBody = articlePanel.locator('.blog-article [contenteditable="true"]')
    const saveDraft = articlePanel.getByRole('button', { name: 'Save draft', exact: true })
    await expect(saveDraft).toBeDisabled()
    await canvasTitle.fill('Discard this unsaved article')
    await canvasBody.fill('This text is discarded when leaving the new article.')
    await articlePanel.getByTestId('dashboard-navbar-back').click()
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog`)
    expect(articleCreates).toEqual([])
    expect((await page.goto(blogCreatePath(orgSlug)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await expect(canvasTitle).toHaveValue('')
    await expect(canvasBody).toHaveText('')
    await expect(saveDraft).toBeDisabled()
    await canvasTitle.fill(createdTitle)
    await canvasBody.fill(body)
    await articlePanel.getByRole('button', { name: 'Add a cover photo', exact: true }).click()
    const initialCover = articlePanel.locator('[data-block-index="0"]')
    await initialCover.getByText('Click to browse', { exact: true }).click()
    const coverPicker = page.getByRole('dialog')
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/media/upload` && response.request().method() === 'POST')
    await coverPicker.locator('input[type="file"]').setInputFiles({ name: photoName, mimeType: 'image/avif', buffer: await sharp({ create: { width: 120, height: 80, channels: 3, background: '#1d4ed8' } }).avif().toBuffer() })
    const uploadResponse = await uploaded
    expect(uploadResponse.status(), await uploadResponse.text()).toBe(200)
    const photo = await uploadResponse.json() as { asset_id: string; public_url: string; kind: string; status: string }
    assetId = photo.asset_id
    expect(photo).toMatchObject({ kind: 'image', status: 'active' })
    await coverPicker.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(coverPicker).not.toBeVisible()
    expect(articleCreates).toEqual([])
    const created = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/blog/posts` && response.request().method() === 'POST')
    await saveDraft.click()
    const createResponse = await created
    expect(createResponse.status(), await createResponse.text()).toBe(200)
    articleId = (await createResponse.json() as { id: string }).id
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}`)

    const draftRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(draftRead.status()).toBe(200)
    const article = mcpData<{ post: { title: string; status: string; updated_at: string; content_blocks: Array<{ type: string; data: { markdown?: string }; media?: Array<{ asset_id: string; slot: string }> }> } }>(await draftRead.json()).post
    expect(article).toMatchObject({ title: createdTitle, status: 'draft' })
    expect(article.content_blocks.map(block => block.type)).toEqual(['image', 'markdown'])
    expect(article.content_blocks[0]!.media).toEqual([expect.objectContaining({ asset_id: assetId, slot: 'media' })])
    expect(article.content_blocks[1]!.data.markdown).toBe(body)
    expect(articleCreates).toEqual([`${editor}/blog/posts`])

    const saveArticle = articlePanel.getByRole('button', { name: 'Save', exact: true })
    const articleSettings = articlePanel.getByRole('button', { name: 'Article settings', exact: true })
    const translations = articlePanel.getByTestId('localize-resource')
    await expect(canvasTitle).toHaveValue(createdTitle)
    await expect(saveArticle).toBeDisabled()
    // Removing an authored cover edits the same canvas and retains its image
    // in the media library.
    await initialCover.focus()
    await initialCover.press('Delete')
    const removedCover = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/blog/${articleId}` && response.request().method() === 'PATCH')
    await saveArticle.click()
    expect((await removedCover).status()).toBe(200)
    await expect(articlePanel.getByRole('status')).toHaveText('Saved')
    await canvasTitle.fill(title)
    await expect(saveArticle).toBeEnabled()
    await canvasTitle.fill(createdTitle)
    await expect(saveArticle).toBeDisabled()
    await canvasTitle.fill(title)
    await expect(canvasBody).toHaveCount(1)
    await canvasBody.fill(body)
    await articleSettings.click()
    await page.getByRole('menuitem', { name: 'Excerpt', exact: true }).click()
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}/excerpt`)
    const excerptPanel = page.locator('#dashboard-panel-organization-blog-post-excerpt')
    await excerptPanel.getByRole('textbox', { name: 'Excerpt', exact: true }).fill('Discard this excerpt edit')
    await excerptPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}`)
    await expect(canvasTitle).toHaveValue(title)
    await expect(canvasBody).toHaveText(body)
    await expect(saveArticle).toBeEnabled()
    await articlePanel.getByRole('button', { name: 'Add a cover photo', exact: true }).click()
    const pendingCover = articlePanel.locator('[data-block-index="0"]')
    const pendingCaption = 'A caption waiting for its cover photo.'
    await pendingCover.getByPlaceholder('Caption', { exact: true }).fill(pendingCaption)

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
    await expect(articlePanel.getByRole('status')).toHaveText('Unsaved changes')
    await expect(pendingCover.getByPlaceholder('Caption', { exact: true })).toHaveValue(pendingCaption)
    const savedRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(savedRead.status()).toBe(200)
    const savedArticle = mcpData<{ post: { title: string; excerpt: string | null; status: string; updated_at: string; content_blocks: Array<{ type: string; data: { markdown?: string } }> } }>(await savedRead.json()).post
    expect(savedArticle).toMatchObject({ title, excerpt: null, status: 'draft' })
    expect(savedArticle.content_blocks.map(block => block.type)).toEqual(['markdown'])
    expect(savedArticle.content_blocks.filter(block => block.type === 'markdown').map(block => block.data.markdown)).toEqual([body])
    await pendingCover.focus()
    await pendingCover.press('Delete')
    await expect(articlePanel.getByRole('status')).toHaveText('Saved')
    await expect(saveArticle).toBeDisabled()
    const categoriesRead = await page.request.get(`${editor}/blog/categories`, { params: { collection: 'blog' } })
    expect(categoriesRead.status(), await categoriesRead.text()).toBe(200)
    const kitchen = (await categoriesRead.json() as { categories: Array<{ id: string; name: string }> }).categories.filter(category => category.name === 'Kitchen')
    expect(kitchen, 'The demo blog has one existing Kitchen category').toHaveLength(1)
    // Continue the author's real workflow: choose the blog's real category,
    // write its body, and publish explicitly.
    const update = await page.request.patch(`${editor}/blog/${articleId}`, { data: {
      excerpt, category_id: kitchen[0]!.id, expected_updated_at: savedArticle.updated_at,
      content_blocks: [{ type: 'markdown', data: { markdown: body, editor_mode: 'rich' } }],
    } })
    expect(update.status(), await update.text()).toBe(200)
    // This editor still holds the earlier revision. A failed save keeps its
    // metadata leaf open and cannot continue into navigation or publication.
    await articleSettings.click()
    await page.getByRole('menuitem', { name: 'Excerpt', exact: true }).click()
    const staleExcerpt = 'A stale excerpt that must not replace the saved article.'
    await excerptPanel.getByRole('textbox', { name: 'Excerpt', exact: true }).fill(staleExcerpt)
    const staleSaveResponse = page.waitForResponse(response => new URL(response.url()).pathname === articlePath && response.request().method() === 'PATCH')
    await excerptPanel.getByRole('button', { name: 'Save', exact: true }).click()
    const refusedSave = await staleSaveResponse
    expect(refusedSave.status(), await refusedSave.text()).toBe(409)
    expect(refusedSave.request().postDataJSON().expected_updated_at).toBe(savedArticle.updated_at)
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}/excerpt`)
    await expect(excerptPanel).toContainText('Content document was updated by another writer')
    await expect(excerptPanel.getByRole('textbox', { name: 'Excerpt', exact: true })).toHaveValue(staleExcerpt)
    await expect(excerptPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const refusedRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(refusedRead.status()).toBe(200)
    expect(mcpData<{ post: { title: string; excerpt: string; status: string } }>(await refusedRead.json()).post).toMatchObject({ title, excerpt, status: 'draft' })
    await page.reload()
    await waitForNuxtHydration(page)
    await expect(excerptPanel.getByRole('textbox', { name: 'Excerpt', exact: true })).toHaveValue(excerpt)
    await excerptPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await articlePanel.getByRole('button', { name: 'Add a cover photo', exact: true }).click()
    await pendingCover.getByPlaceholder('Caption', { exact: true }).fill(pendingCaption)
    await expect(articlePanel.getByRole('status')).toHaveText('Unsaved changes')
    await expect(saveArticle).toBeDisabled()
    await articleSettings.click()
    await page.getByRole('menuitem', { name: 'Visibility · Draft', exact: true }).click()
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}/publishing`)
    const publishingPanel = page.locator('#dashboard-panel-organization-blog-post-publishing')
    const publishResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${articlePath}/publish` && response.request().method() === 'POST')
    await publishingPanel.getByRole('button', { name: 'Publish', exact: true }).click()
    const published = await publishResponse
    expect(published.status(), await published.text()).toBe(200)
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/blog/${articleId}`)
    await expect(articlePanel.getByRole('status')).toHaveText('Unsaved changes')
    await expect(saveArticle).toBeDisabled()
    await expect(pendingCover.getByPlaceholder('Caption', { exact: true })).toHaveValue(pendingCaption)
    // Publication refreshes the canonical preview projection in this editor;
    // opening it immediately offers the public address without another reload.
    await articlePanel.getByTestId('article-preview').click()
    const articlePreview = page.getByRole('dialog', { name: 'Article preview', exact: true })
    await expect(articlePreview.getByTestId('preview-share')).toBeVisible()
    await expect(articlePreview.getByTestId('preview-private')).toHaveCount(0)
    const sourceRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: articleId } })
    expect(sourceRead.status()).toBe(200)
    const source = mcpData<{ post: { title: string; excerpt: string; status: string; public_path: string; category: { id: string; name: string } | null; content_blocks: Array<{ type: string; data: { markdown?: string } }> } }>(await sourceRead.json()).post
    expect(source).toMatchObject({ title, excerpt, status: 'published' })
    expect(source.content_blocks.map(block => block.type)).toEqual(['markdown'])
    expect(source.content_blocks.filter(block => block.type === 'markdown').map(block => block.data.markdown)).toEqual([body])
    expect(source.category).toMatchObject({ id: kitchen[0]!.id, name: 'Kitchen' })
    const contextRead = await page.request.get('/api/dashboard/context', { params: { org: orgSlug } })
    expect(contextRead.status()).toBe(200)
    const context = await contextRead.json() as { organization: { public_url: string } }
    const articleUrl = new URL(source.public_path, context.organization.public_url).toString()
    await expect(articlePreview.getByTestId('content-preview-frame')).toHaveAttribute('src', articleUrl)
    await articlePreview.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(articlePreview).toHaveCount(0)
    await pendingCover.focus()
    await pendingCover.press('Delete')
    await expect(articlePanel.getByRole('status')).toHaveText('Saved')
    await expect(saveArticle).toBeDisabled()
  } finally {
    if (articleId) {
      const removed = await page.request.delete(`${editor}/blog/${articleId}`)
      expect(removed.status(), await removed.text()).toBe(200)
    }
    if (assetId) {
      const removed = await page.request.delete(`${editor}/media/${assetId}`)
      expect(removed.status(), await removed.text()).toBe(200)
      expect(await removed.json()).toEqual({ deleted: true })
    }
  }
})

test('a prepared article photo post preserves concurrent media and publishes only after review', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'Authoring writes require local D1.')
  let articleId: string | null = null
  let postId: string | null = null
  let assetId: string | null = null
  let concurrentAssetId: string | null = null
  const title = `E2E Prepared article ${Date.now()}`
  const excerpt = 'An article prepared for a deliberate Facebook review.'
  const photoName = `post-creation-cover-${Date.now()}.avif`
  try {
    const categoriesRead = await page.request.get(`${editor}/blog/categories`, { params: { collection: 'blog' } })
    expect(categoriesRead.status(), await categoriesRead.text()).toBe(200)
    const kitchen = (await categoriesRead.json() as { categories: Array<{ id: string; name: string }> }).categories.filter(category => category.name === 'Kitchen')
    expect(kitchen, 'The source article uses the demo blog’s existing Kitchen category').toHaveLength(1)
    const sourceCreated = await page.request.post(`${editor}/blog/posts`, { data: {
      title, excerpt, collection: 'blog', category_id: kitchen[0]!.id,
      content_blocks: [{ type: 'markdown', data: { markdown: 'A published source article for the photo-post composition journey.', editor_mode: 'rich' } }],
      idempotency_key: `prepared-post-source-${crypto.randomUUID()}`,
    } })
    expect(sourceCreated.status(), await sourceCreated.text()).toBe(200)
    const source = await sourceCreated.json() as { id: string; post: { updated_at: string; public_path: string } }
    articleId = source.id
    const sourcePublished = await page.request.post(`${editor}/blog/${articleId}/publish`, { data: { expected_updated_at: source.post.updated_at } })
    expect(sourcePublished.status(), await sourcePublished.text()).toBe(200)
    const contextRead = await page.request.get('/api/dashboard/context', { params: { org: orgSlug } })
    expect(contextRead.status()).toBe(200)
    const context = await contextRead.json() as { organization: { public_url: string } }
    const articleUrl = new URL(source.post.public_path, context.organization.public_url).toString()
    const uploaded = await page.request.post(`${editor}/media/upload`, { multipart: { image: {
      name: photoName, mimeType: 'image/avif',
      buffer: await sharp({ create: { width: 120, height: 80, channels: 3, background: '#1d4ed8' } }).avif().toBuffer(),
    } } })
    expect(uploaded.status(), await uploaded.text()).toBe(200)
    const photo = await uploaded.json() as { asset_id: string; public_url: string; kind: string; status: string }
    assetId = photo.asset_id
    expect(photo).toMatchObject({ kind: 'image', status: 'active' })
    const postWrites: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(`${editor}/posts`)) postWrites.push(new URL(request.url()).pathname)
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    expect((await page.goto(articleFacebookPostPath(orgSlug, articleId)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const caption = page.locator('#dashboard-panel-post')
    await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(`${title}\n\n${excerpt}`)
    await caption.getByRole('textbox', { name: 'Caption', exact: true }).fill('Discard this unsaved caption')
    // Leaving the composer discards the unsaved composition; no record is
    // created just to attach its photo or review its destinations.
    await caption.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/posts?article_id=${articleId}&channel=facebook`)
    expect((await page.goto(articleFacebookPostPath(orgSlug, articleId)))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(`${title}\n\n${excerpt}`)
    await caption.getByText('Add a photo or video', { exact: true }).click()
    const postPicker = page.getByRole('dialog', { name: 'Select post media', exact: true })
    await postPicker.getByRole('button', { name: photoName, exact: true }).click()
    await postPicker.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(postPicker).not.toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toBeVisible()
    await expect(caption.getByRole('img', { name: 'Post photo', exact: true })).toHaveAttribute('src', photo.public_url)
    await expect(caption.getByRole('img', { name: 'Post photo', exact: true })).toBeVisible()
    await expect(caption.getByRole('region', { name: 'Post preview', exact: true, includeHidden: true })).toBeHidden()
    await caption.getByRole('button', { name: 'Save draft', exact: true }).scrollIntoViewIfNeeded()
    await expect(caption.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(caption.getByRole('region', { name: 'Post preview', exact: true }).locator('img')).toHaveAttribute('src', photo.public_url)
    const linkDestination = caption.getByRole('textbox', { name: 'Link destination', exact: true })
    await linkDestination.fill('javascript:alert(1)')
    await expect(caption).toContainText('call_to_action.url must use https, http or tel:')
    await expect(caption.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled()
    await expect(linkDestination).toBeEnabled()
    await linkDestination.fill(` ${articleUrl} `)
    await expect(caption.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled()
    expect(postWrites).toEqual([])
    const postCreated = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/posts` && response.request().method() === 'POST')
    await caption.getByRole('button', { name: 'Save draft', exact: true }).click()
    const postResponse = await postCreated
    expect(postResponse.status(), await postResponse.text()).toBe(201)
    postId = (await postResponse.json() as { post: { id: string } }).post.id
    await expect(page).toHaveURL(`/dashboard/${orgSlug}/website/posts/${postId}?channel=facebook`)
    await expect(caption.getByRole('heading', { name: 'Publish to', exact: true })).toBeVisible()
    const postRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: postId } })
    expect(postRead.status()).toBe(200)
    const post = mcpData<{ post: { title: string; body: string; status: string; slug: string; published_at: string | null; call_to_action: { label: string; url: string }; publications: unknown[]; media: Array<{ asset_id: string; slot: string }> } }>(await postRead.json()).post
    expect(post).toMatchObject({ title, body: `${title}\n\n${excerpt}`, status: 'draft', published_at: null, call_to_action: { label: 'Read article', url: articleUrl }, publications: [] })
    expect(post.media).toEqual([expect.objectContaining({ asset_id: assetId, slot: 'cover' })])
    expect(postWrites).toEqual([`${editor}/posts`])
    // Removing the cover must not erase a different photo saved by another
    // editor after this composer read its original cover.
    await caption.getByRole('button', { name: 'Remove photo', exact: true }).click()
    const concurrentUpload = await page.request.post(`${editor}/media/upload`, { multipart: { image: {
      name: `concurrent-${photoName}`, mimeType: 'image/avif',
      buffer: await sharp({ create: { width: 120, height: 80, channels: 3, background: '#15803d' } }).avif().toBuffer(),
    } } })
    expect(concurrentUpload.status(), await concurrentUpload.text()).toBe(200)
    const concurrentPhoto = await concurrentUpload.json() as { asset_id: string; public_url: string; kind: string; status: string }
    concurrentAssetId = concurrentPhoto.asset_id
    expect(concurrentPhoto).toMatchObject({ kind: 'image', status: 'active' })
    expect(concurrentAssetId).not.toBe(assetId)
    const replacedCover = await page.request.put(`${editor}/media/placements`, { data: { placement: { owner_type: 'content_document', owner_id: postId, slot: 'cover' }, asset_id: concurrentAssetId } })
    expect(replacedCover.status(), await replacedCover.text()).toBe(200)
    await caption.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect(caption).toContainText('The cover changed since it was read. Reload the post to review that change before saving.')
    await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(`${title}\n\n${excerpt}`)
    await expect(caption.getByText('Add a photo or video', { exact: true })).toBeVisible()
    await expect(caption.getByRole('button', { name: 'Remove photo', exact: true })).toHaveCount(0)
    const concurrentRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: postId } })
    expect(concurrentRead.status()).toBe(200)
    expect(mcpData<{ post: { body: string; media: Array<{ asset_id: string; slot: string }> } }>(await concurrentRead.json()).post)
      .toMatchObject({ body: `${title}\n\n${excerpt}`, media: [{ asset_id: concurrentAssetId, slot: 'cover' }] })
    await page.reload()
    await waitForNuxtHydration(page)
    await expect(caption.getByRole('img', { name: 'Post photo', exact: true })).toHaveAttribute('src', concurrentPhoto.public_url)
    const revisedCaption = `${title}\n\n${excerpt}\n\nA revised caption saved with the photo gallery.`
    await caption.getByRole('textbox', { name: 'Caption', exact: true }).fill(revisedCaption)
    await caption.getByRole('textbox', { name: 'Link destination', exact: true }).fill(` ${articleUrl} `)
    await caption.getByRole('button', { name: 'Remove photo', exact: true }).click()
    await caption.getByRole('button', { name: 'Add media', exact: true }).click()
    const galleryPicker = page.getByRole('dialog', { name: 'Select post media', exact: true })
    await galleryPicker.getByRole('button', { name: photoName, exact: true }).click()
    await galleryPicker.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(galleryPicker).not.toBeVisible()
    const postPath = `${editor}/posts/${postId}`
    const interceptPost = (url: URL) => url.pathname === postPath
    const captionPatches: Array<{ expected_updated_at: string; body: string; call_to_action: { label: string; url: string } }> = []
    page.on('request', request => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname === postPath) captionPatches.push(request.postDataJSON())
    })
    let droppedPatch = false
    await page.route(interceptPost, async route => {
      if (route.request().method() === 'PATCH' && !droppedPatch) {
        const applied = await route.fetch()
        expect(applied.status(), await applied.text()).toBe(200)
        droppedPatch = true
        await route.abort('failed')
      } else await route.continue()
    })
    try {
      await caption.getByRole('button', { name: 'Save draft', exact: true }).click()
      await expect.poll(() => droppedPatch).toBe(true)
      await expect(caption).toContainText('Post could not be completed')
      await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(revisedCaption)
      const appliedRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: postId } })
      expect(appliedRead.status()).toBe(200)
      const appliedPost = mcpData<{ post: { updated_at: string; body: string; call_to_action: { label: string; url: string }; media: Array<{ asset_id: string; slot: string }> } }>(await appliedRead.json()).post
      expect(appliedPost)
        .toMatchObject({ body: revisedCaption, call_to_action: { label: 'Read article', url: articleUrl }, media: [{ asset_id: concurrentAssetId, slot: 'cover' }] })
      const retryPatch = page.waitForResponse(response => new URL(response.url()).pathname === postPath && response.request().method() === 'PATCH')
      await caption.getByRole('button', { name: 'Save draft', exact: true }).click()
      const retryResponse = await retryPatch
      expect(retryResponse.status(), await retryResponse.text()).toBe(200)
      await expect.poll(async () => {
        const completedRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: postId } })
        expect(completedRead.status()).toBe(200)
        return mcpData<{ post: { body: string; call_to_action: { label: string; url: string }; media: Array<{ asset_id: string; slot: string }> } }>(await completedRead.json()).post
      }).toMatchObject({ body: revisedCaption, call_to_action: { label: 'Read article', url: articleUrl }, media: [{ asset_id: assetId, slot: 'gallery' }] })
      await expect(caption.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled()
      await expect(caption.getByText('Post could not be completed', { exact: true })).toHaveCount(0)
      expect(captionPatches.at(-1)).toMatchObject({ expected_updated_at: appliedPost.updated_at, body: revisedCaption, call_to_action: { label: 'Read article', url: articleUrl } })
    } finally { await page.unroute(interceptPost) }
    // Only the explicitly checked website is published. No external social
    // account is contacted by this local authoring journey.
    const facebookChoice = caption.getByRole('checkbox', { name: 'Publish to Facebook', exact: true })
    if (await facebookChoice.count()) await facebookChoice.uncheck()
    await caption.getByRole('checkbox', { name: 'Publish to Website', exact: true }).check()
    const publishedCaption = `${revisedCaption}\n\nReviewed with the latest gallery photo.`
    await caption.getByRole('textbox', { name: 'Caption', exact: true }).fill(publishedCaption)
    const attachedPhoto = await page.request.post(`${editor}/media/placements/attach`, { data: { placement: { owner_type: 'content_document', owner_id: postId, slot: 'gallery' }, asset_id: concurrentAssetId } })
    expect(attachedPhoto.status(), await attachedPhoto.text()).toBe(200)
    await caption.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(caption).toContainText('Photos or videos changed while saving. Review them before publishing.')
    const reviewRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: postId } })
    expect(reviewRead.status()).toBe(200)
    expect(mcpData<{ post: { status: string; body: string; media: Array<{ asset_id: string; slot: string }>; publications: unknown[] } }>(await reviewRead.json()).post)
      .toMatchObject({ status: 'draft', body: publishedCaption, media: [{ asset_id: assetId, slot: 'gallery' }, { asset_id: concurrentAssetId, slot: 'gallery' }], publications: [] })
    await expect(caption.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(publishedCaption)
    await expect(caption.locator('fieldset img')).toHaveCount(2)
    await expect(caption.locator('fieldset img').nth(1)).toHaveAttribute('src', concurrentPhoto.public_url)
    await expect(caption.locator('fieldset img').nth(1)).toBeVisible()
    await expect(caption.getByRole('checkbox', { name: 'Publish to Website', exact: true })).toBeChecked()
    const posted = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/posts/${postId}/publish` && response.request().method() === 'POST')
    await caption.getByRole('button', { name: 'Publish', exact: true }).click()
    const postedResponse = await posted
    expect(postedResponse.status(), await postedResponse.text()).toBe(200)
    expect(postedResponse.request().postDataJSON().targets).toEqual([{ channel: 'organization' }])
    expect((await postedResponse.json() as { outcomes: Array<{ channel: string; status: string }> }).outcomes).toEqual([expect.objectContaining({ channel: 'organization', status: 'published' })])
    const publishedRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: postId } })
    expect(publishedRead.status()).toBe(200)
    expect(mcpData<{ post: { status: string; body: string; media: Array<{ asset_id: string; slot: string }> } }>(await publishedRead.json()).post)
      .toMatchObject({ status: 'published', body: publishedCaption, media: [{ asset_id: assetId, slot: 'gallery' }, { asset_id: concurrentAssetId, slot: 'gallery' }] })
    const visitor = await page.context().newPage()
    try {
      const response = await openTenantPage(visitor, new URL(`/posts/${encodeURIComponent(post.slug)}`, tenantBaseURL).toString(), tenantExtraHeaders)
      expect(response?.status()).toBe(200)
      await expect(visitor.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible()
      await expect(visitor.getByText(publishedCaption, { exact: true })).toBeVisible()
      await expect(visitor.locator('article section img').filter({ visible: true }).first()).toHaveAttribute('src', photo.public_url)
      await visitor.getByRole('button', { name: 'Photos and video (2)', exact: true }).click()
      const publicGallery = visitor.getByRole('dialog')
      await publicGallery.getByRole('button', { name: 'Next photo or video', exact: true }).click()
      const publicSecondPhoto = publicGallery.locator('section').nth(1).locator('img:not([aria-hidden="true"])')
      await expect(publicSecondPhoto).toHaveAttribute('src', concurrentPhoto.public_url)
      await expect(publicSecondPhoto).toBeInViewport()
    } finally { await visitor.close() }
  } finally {
    if (postId) {
      const removed = await page.request.delete(`${editor}/posts/${postId}`)
      expect(removed.status(), await removed.text()).toBe(200)
    }
    if (articleId) {
      const removed = await page.request.delete(`${editor}/blog/${articleId}`)
      expect(removed.status(), await removed.text()).toBe(200)
    }
    for (const imageId of [assetId, concurrentAssetId].filter(Boolean)) {
      const removed = await page.request.delete(`${editor}/media/${imageId}`)
      expect(removed.status(), await removed.text()).toBe(200)
      expect(await removed.json()).toEqual({ deleted: true })
    }
  }
})

test('a new article publishes its composed body directly and retries publication without creating another article', async ({ page, baseURL }) => {
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
    const visitor = await page.context().newPage()
    try {
      const response = await openTenantPage(visitor, new URL(article.public_path, tenantBaseURL).toString(), tenantExtraHeaders)
      expect(response?.status()).toBe(200)
      await expect(visitor.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible()
      await expect(visitor.getByText(body, { exact: true })).toBeVisible()
    } finally { await visitor.close() }
  } finally {
    await page.unroute(interceptPublish)
    if (articleId) {
      const removed = await page.request.delete(`${editor}/blog/${articleId}`)
      expect(removed.status(), await removed.text()).toBe(200)
      expect((await page.request.get(`${editor}/blog/${articleId}`)).status()).toBe(404)
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
