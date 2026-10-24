import { expect, test } from '@playwright/test'
import Ajv from 'ajv'
import { loginAs } from './helpers/auth'
import { openTenantPage, tenantBaseURL, tenantExtraHeaders, waitForNuxtHydration } from './helpers'
import { MCP_ORGANIZATION_ID, mcpRequest, mcpData } from './helpers/mcp'

// Split out of mcp.spec.ts (content/publishing tool tests) — see
// helpers/mcp.ts for why. This group covers post publishing, tenant blog
// tools, and the stateless discovery/list/error protocol flow.

test.describe('stateless MCP server', () => {
  test('separate language operations publish only authored translations and preserve source content', async ({ request, page, baseURL }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'Language writes use local D1 only.')
    test.setTimeout(120_000)
    await loginAs(request, baseURL!)
    const localesResponse = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'list_organization_locales', args: { organization_id: MCP_ORGANIZATION_ID },
    })
    expect(localesResponse.status()).toBe(200)
    type Language = { locale: string; status: 'published' | 'disabled'; is_source: boolean }
    const { locales } = mcpData<{ locales: Language[] }>(await localesResponse.json())
    const source = locales.find(saved => saved.is_source)
    expect(source).toMatchObject({ status: 'published' })
    const locale = ['vi', 'ja'].find(candidate => !locales.some(saved => saved.locale === candidate))!
    expect(locale, 'The paid fixture has an available language that has not been added').toBeTruthy()
    const response = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'get_product_catalog_localization', args: { organization_id: MCP_ORGANIZATION_ID, locale },
    })
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.error).toBeUndefined()
    expect(body.result?.isError).toBe(true)
    expect(body.result?.structuredContent).toBeUndefined()
    const action = JSON.parse(body.result.content[0].text) as { code: string; dashboard_url: string }
    expect(action.code).toBe('LANGUAGE_NOT_ENABLED')
    const destination = new URL(action.dashboard_url)
    expect(destination.pathname).toMatch(/^\/dashboard\/[^/]+\/website\/localization$/)

    const editor = `${baseURL}/api/editor/organizations/${MCP_ORGANIZATION_ID}`
    const pagesResponse = await request.get(`${editor}/pages`)
    expect(pagesResponse.status()).toBe(200)
    const sourcePages = (await pagesResponse.json() as { pages: Array<{ id: string; page_id: string; path: string }> }).pages
    const home = sourcePages.find(saved => saved.path === '/')
    expect(home, 'The existing fixture has an authored source homepage').toBeDefined()
    const dashboardPage = sourcePages.find(saved => saved.path === '/about')
    expect(dashboardPage, 'The existing fixture has an About page for dashboard authoring').toBeDefined()
    const sourceRead = await request.get(`${editor}/pages/${home!.id}`)
    expect(sourceRead.status()).toBe(200)
    const originalSource = await sourceRead.json()
    expect(originalSource.page.page_type).toBe('system')
    expect(originalSource.page.recipe, 'The existing source homepage has a template recipe to inherit').toBe('home')
    const dashboardSourceRead = await request.get(`${editor}/pages/${dashboardPage!.id}`)
    expect(dashboardSourceRead.status()).toBe(200)
    const dashboardSource = (await dashboardSourceRead.json()).page
    const publicSource = await page.request.get(`${tenantBaseURL}/api/public/pages`, { headers: tenantExtraHeaders, params: { path: '/' } })
    expect(publicSource.status()).toBe(200)
    const originalPublicSource = (await publicSource.json()).page
    const languagePath = `${editor}/locales/${locale}`
    const localizationPath = `${editor}/localization/content_document/${home!.page_id}/${locale}`
    const translatedTitle = locale === 'vi' ? 'Chào mừng đến Ember & Slice' : 'Ember & Sliceへようこそ'
    const translatedText = locale === 'vi' ? 'Khám phá thực đơn của Ember & Slice.' : 'Ember & Sliceのメニューをご覧ください。'
    try {
      const added = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'add_organization_language', args: { organization_id: MCP_ORGANIZATION_ID, locale },
      })
      expect(added.status()).toBe(200)
      const addedLanguages = mcpData<{ locales: Language[] }>(await added.json()).locales
      expect(addedLanguages).toContainEqual(expect.objectContaining({ locale, status: 'disabled', is_source: false }))
      const privateSettings = await request.get(`${editor}/locales`)
      expect(privateSettings.status()).toBe(200)
      const configuredLanguages = (await privateSettings.json()).languages as Array<{ locale: string; label: string; status: string }>
      expect(configuredLanguages).toContainEqual(expect.objectContaining({ locale, status: 'disabled' }))

      const premature = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_organization_language', args: { organization_id: MCP_ORGANIZATION_ID, locale },
      })
      expect(premature.status()).toBe(200)
      const prematureBody = await premature.json()
      expect(prematureBody.result?.isError).toBe(true)
      expect(prematureBody.result?.content?.[0]?.text).toContain('Translate the homepage before publishing this language')

      const translationArgs = {
        organization_id: MCP_ORGANIZATION_ID, page_id: home!.page_id, locale, path: '/', title: translatedTitle,
        blocks: [{ type: 'markdown', data: { markdown: translatedText, editor_mode: 'rich' } }],
      }
      for (const [change, message] of [
        [{ recipe: null }, 'A translated tenant-page variant must use the source page identity'],
        [{ sortOrder: originalSource.page.sort_order + 1 }, 'Set sortOrder on the source page, not a translation'],
      ] as const) {
        const refused = await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'create_site_page', args: { ...translationArgs, ...change },
        })
        expect(refused.status()).toBe(200)
        const refusal = await refused.json()
        expect(refusal.result?.isError).toBe(true)
        expect(refusal.result?.structuredContent).toBeUndefined()
        expect(JSON.parse(refusal.result.content[0].text)).toMatchObject({ status: 400, message })
        const editorRefusal = await request.post(`${editor}/pages`, { data: {
          pageId: home!.page_id, locale, path: '/', title: translatedTitle, blocks: translationArgs.blocks, ...change,
        } })
        expect(editorRefusal.status()).toBe(400)
        expect(await editorRefusal.text()).toContain(message)
        const absent = await request.get(localizationPath)
        expect(absent.status(), await absent.text()).toBe(404)
        const unchangedSource = await request.get(`${editor}/pages/${home!.id}`)
        expect(unchangedSource.status()).toBe(200)
        expect(await unchangedSource.json()).toEqual(originalSource)
      }
      await loginAs(page.request, baseURL!)
      const sourceHero = originalSource.page.blocks.find((block: { type: string }) => block.type === 'hero')
      expect(sourceHero, 'The existing homepage has a hero with a second button to translate').toBeDefined()
      expect(sourceHero.data.secondary_label).toBe('View menu')
      await page.goto(`${baseURL}/dashboard/ember-slice-demo/website/pages/${home!.id}?editMode=translations&locale=${locale}`)
      await waitForNuxtHydration(page)
      await expect(page.getByTestId(`localize-field-content:${sourceHero.id}:secondary_label`)).toHaveValue('')
      await page.getByRole('dialog', { name: `Translate ${originalSource.page.title}`, exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page).not.toHaveURL(/[?&]editMode=translations(?:&|$)/)
      const translation = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'create_site_page', args: translationArgs,
      })
      expect(translation.status(), await translation.text()).toBe(200)
      const created = mcpData<{ page: { id: string } }>(await translation.json()).page
      const editorTranslation = await request.get(`${editor}/pages/${created.id}`)
      expect(editorTranslation.status()).toBe(200)
      expect((await editorTranslation.json()).page).toMatchObject({
        page_id: home!.page_id, locale, path: '/', title: translatedTitle,
        page_type: originalSource.page.page_type, recipe: originalSource.page.recipe, sort_order: originalSource.page.sort_order,
        blocks: [expect.objectContaining({ type: 'markdown', data: { markdown: translatedText, editor_mode: 'rich' } })],
      })
      const translatedRead = await request.get(localizationPath)
      expect(translatedRead.status()).toBe(200)
      let authored = (await translatedRead.json()).localization
      expect(authored).toMatchObject({ root_id: home!.page_id, locale, title: translatedTitle, path: '/' })
      expect(authored.content_blocks).toContainEqual(expect.objectContaining({ type: 'markdown', data: { markdown: translatedText, editor_mode: 'rich' } }))
      const privateRoute = await page.request.get(`${tenantBaseURL}/${locale}`, { headers: tenantExtraHeaders, maxRedirects: 0 })
      expect(privateRoute.status()).toBe(404)

      for (const identity of [{ route_path: `/${locale}/moved-home` }, { values: { title: 'Must not be saved', slug: 'moved-home' } }]) {
        const moved = await request.put(localizationPath, { data: {
          values: { title: 'Must not be saved' }, expected_updated_at: authored.updated_at, ...identity,
        } })
        expect(moved.status(), await moved.text()).toBe(422)
        const unchanged = await request.get(localizationPath)
        expect(unchanged.status()).toBe(200)
        expect((await unchanged.json()).localization).toEqual(authored)
      }
      const renamed = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'put_resource_localization', args: {
          organization_id: MCP_ORGANIZATION_ID, resource_type: 'content_document', resource_id: home!.page_id,
          locale, expected_updated_at: authored.updated_at, values: { title: translatedTitle + ' · Updated' },
        },
      })
      expect(renamed.status()).toBe(200)
      expect(mcpData<{ localization: { path: string } }>(await renamed.json()).localization.path).toBe('/')
      const renamedRead = await request.get(localizationPath)
      expect(renamedRead.status()).toBe(200)
      const renamedLocalization = (await renamedRead.json()).localization
      expect(renamedLocalization).toMatchObject({ id: authored.id, path: '/', slug: authored.slug, title: translatedTitle + ' · Updated', content_blocks: authored.content_blocks })
      expect(renamedLocalization.updated_at).not.toBe(authored.updated_at)
      authored = renamedLocalization

      const published = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_organization_language', args: { organization_id: MCP_ORGANIZATION_ID, locale },
      })
      expect(published.status()).toBe(200)
      expect(mcpData<{ locales: Language[] }>(await published.json()).locales).toContainEqual(expect.objectContaining({ locale, status: 'published' }))
      const publishedSettings = await request.get(`${editor}/locales`)
      expect(publishedSettings.status()).toBe(200)
      expect((await publishedSettings.json()).languages).toContainEqual(expect.objectContaining({ locale, status: 'published' }))
      const publicTranslation = await page.request.get(`${tenantBaseURL}/api/public/pages`, { headers: tenantExtraHeaders, params: { path: '/', locale } })
      expect(publicTranslation.status(), await publicTranslation.text()).toBe(200)
      expect((await publicTranslation.json()).page).toMatchObject({
        id: authored.id, page_id: home!.page_id, locale, title: authored.title,
        blocks: [expect.objectContaining({ type: 'markdown', data: { markdown: translatedText, editor_mode: 'rich' } })],
      })
      const publicRoute = await openTenantPage(page, `${tenantBaseURL}/${locale}`, tenantExtraHeaders)
      expect(publicRoute?.status()).toBe(200)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await expect(page.getByText(translatedText, { exact: true })).toBeVisible()
      const untranslatedRoute = await page.request.get(`${tenantBaseURL}/${locale}${dashboardPage!.path}`, { headers: tenantExtraHeaders, maxRedirects: 0 })
      expect(untranslatedRoute.status()).toBe(404)
      // This built-in route owns its catalog, rather than an authored page.
      const emptyCatalog = await page.request.get(`${tenantBaseURL}/api/public/page`, {
        headers: tenantExtraHeaders, params: { page: 'experiences', datasets: 'products', locale },
      })
      expect(emptyCatalog.status(), await emptyCatalog.text()).toBe(200)
      expect((await emptyCatalog.json()).products).toEqual([])
      const emptyCatalogRoute = await page.request.get(`${tenantBaseURL}/${locale}/experiences`, { headers: tenantExtraHeaders, maxRedirects: 0 })
      expect(emptyCatalogRoute.status()).toBe(404)
      const disabledForAuthoring = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'disable_organization_language', args: { organization_id: MCP_ORGANIZATION_ID, locale },
      })
      expect(disabledForAuthoring.status()).toBe(200)
      expect(mcpData<{ locales: Language[] }>(await disabledForAuthoring.json()).locales).toContainEqual(expect.objectContaining({ locale, status: 'disabled' }))

      const dashboardPath = `${baseURL}/dashboard/ember-slice-demo/website/pages/${dashboardPage!.id}?editMode=translations&locale=${locale}`
      const dashboardTitle = locale === 'vi' ? 'Giới thiệu Ember & Slice' : 'Ember & Sliceについて'
      await page.goto(dashboardPath)
      await waitForNuxtHydration(page)
      const languagePicker = page.getByTestId('localize-language')
      await expect(languagePicker).toContainText(configuredLanguages.find(saved => saved.locale === locale)!.label)
      await languagePicker.click()
      await expect(page.getByRole('option', { name: source!.label, exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('localize-save')).toBeDisabled()
      await page.getByTestId('localize-field-title').fill(dashboardTitle)
      await expect(page.getByTestId('localize-save')).toBeEnabled()
      for (const field of await page.getByTestId(/^localize-field-content:/).all()) await field.fill(translatedText)
      const dashboardCreate = page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'POST' && url.origin === new URL(baseURL!).origin
          && url.pathname === `/api/editor/organizations/${MCP_ORGANIZATION_ID}/pages`
      })
      await page.getByTestId('localize-save').click()
      const dashboardCreatedResponse = await dashboardCreate
      expect(dashboardCreatedResponse.status(), await dashboardCreatedResponse.text()).toBe(201)
      await expect(page).not.toHaveURL(/[?&]editMode=translations(?:&|$)/)
      const dashboardCreated = (await dashboardCreatedResponse.json()).page
      const dashboardTranslationRead = await request.get(`${editor}/pages/${dashboardCreated.id}`)
      expect(dashboardTranslationRead.status()).toBe(200)
      expect((await dashboardTranslationRead.json()).page).toMatchObject({
        page_id: dashboardPage!.page_id, locale, path: '/about', title: dashboardTitle,
        page_type: dashboardSource.page_type, recipe: dashboardSource.recipe, sort_order: dashboardSource.sort_order,
      })
      await page.goto(dashboardPath)
      await waitForNuxtHydration(page)
      await expect(page.getByTestId('localize-field-title')).toHaveValue(dashboardTitle)
      const dashboardUpdatedTitle = `${dashboardTitle} · 2`
      await page.getByTestId('localize-field-title').fill(dashboardUpdatedTitle)
      const dashboardUpdate = page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'PATCH' && url.origin === new URL(baseURL!).origin
          && url.pathname === `/api/editor/organizations/${MCP_ORGANIZATION_ID}/pages/${dashboardCreated.id}`
      })
      await page.getByTestId('localize-save').click()
      const dashboardUpdatedResponse = await dashboardUpdate
      expect(dashboardUpdatedResponse.status(), await dashboardUpdatedResponse.text()).toBe(200)
      await expect(page).not.toHaveURL(/[?&]editMode=translations(?:&|$)/)
      const dashboardUpdatedRead = await request.get(`${editor}/pages/${dashboardCreated.id}`)
      expect(dashboardUpdatedRead.status()).toBe(200)
      expect((await dashboardUpdatedRead.json()).page).toMatchObject({
        id: dashboardCreated.id, title: dashboardUpdatedTitle,
        page_type: dashboardSource.page_type, recipe: dashboardSource.recipe, sort_order: dashboardSource.sort_order,
      })
      const dashboardSourceAfter = await request.get(`${editor}/pages/${dashboardPage!.id}`)
      expect(dashboardSourceAfter.status()).toBe(200)
      expect((await dashboardSourceAfter.json()).page).toEqual(dashboardSource)
      const privateDashboardRoute = await page.request.get(`${tenantBaseURL}/${locale}/about`, { headers: tenantExtraHeaders, maxRedirects: 0 })
      expect(privateDashboardRoute.status()).toBe(404)

      const republished = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_organization_language', args: { organization_id: MCP_ORGANIZATION_ID, locale },
      })
      expect(republished.status()).toBe(200)
      expect(mcpData<{ locales: Language[] }>(await republished.json()).locales).toContainEqual(expect.objectContaining({ locale, status: 'published' }))
      const publicDashboardTranslation = await page.request.get(`${tenantBaseURL}/api/public/pages`, { headers: tenantExtraHeaders, params: { path: '/about', locale } })
      expect(publicDashboardTranslation.status(), await publicDashboardTranslation.text()).toBe(200)
      expect((await publicDashboardTranslation.json()).page).toMatchObject({
        id: dashboardCreated.id, page_id: dashboardPage!.page_id, locale, path: '/about', title: dashboardUpdatedTitle,
      })
      const publicDashboardRoute = await openTenantPage(page, `${tenantBaseURL}/${locale}/about`, tenantExtraHeaders)
      expect(publicDashboardRoute?.status()).toBe(200)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await expect(page.getByText(translatedText, { exact: true }).first()).toBeVisible()

      const disabled = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'disable_organization_language', args: { organization_id: MCP_ORGANIZATION_ID, locale },
      })
      expect(disabled.status()).toBe(200)
      const disabledLanguages = mcpData<{ locales: Language[] }>(await disabled.json()).locales
      expect(disabledLanguages).toContainEqual(expect.objectContaining({ locale, status: 'disabled' }))
      expect(disabledLanguages.find(saved => saved.is_source)).toEqual(source)
      const disabledSettings = await request.get(`${editor}/locales`)
      expect(disabledSettings.status()).toBe(200)
      expect((await disabledSettings.json()).languages).toContainEqual(expect.objectContaining({ locale, status: 'disabled' }))
      const hiddenRoute = await page.request.get(`${tenantBaseURL}/${locale}`, { headers: tenantExtraHeaders, maxRedirects: 0 })
      expect(hiddenRoute.status()).toBe(404)
      const retained = await request.get(localizationPath)
      expect(retained.status()).toBe(200)
      expect((await retained.json()).localization).toEqual(authored)
      const sourceAfter = await request.get(`${editor}/pages/${home!.id}`)
      expect(sourceAfter.status()).toBe(200)
      expect(await sourceAfter.json()).toEqual(originalSource)
      const publicSourceAfter = await page.request.get(`${tenantBaseURL}/api/public/pages`, { headers: tenantExtraHeaders, params: { path: '/' } })
      expect(publicSourceAfter.status()).toBe(200)
      expect((await publicSourceAfter.json()).page).toMatchObject({
        id: originalPublicSource.id, page_id: originalPublicSource.page_id, locale: source!.locale, title: originalPublicSource.title,
      })
    } finally {
      const settings = await request.get(`${editor}/locales`)
      expect(settings.status(), await settings.text()).toBe(200)
      if ((await settings.json()).languages.some((saved: { locale: string }) => saved.locale === locale)) {
        const disable = await request.post(`${languagePath}/disable`)
        expect(disable.status(), await disable.text()).toBe(200)
        const cleanup = await request.delete(languagePath)
        expect(cleanup.status(), await cleanup.text()).toBe(200)
        expect(await cleanup.json()).toEqual({ deleted: true, locale })
        const restored = await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'list_organization_locales', args: { organization_id: MCP_ORGANIZATION_ID },
        })
        expect(restored.status()).toBe(200)
        expect(mcpData<{ locales: Language[] }>(await restored.json()).locales).toEqual(locales)
      }
    }
  })

  test('a post rejects fields that are not part of the contract', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!)
    const organizationId = MCP_ORGANIZATION_ID

    // Event and offer types are gone: their dates and terms are written in the body.
    const typed = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'create_post',
      args: { organization_id: organizationId, idempotency_key: `typed-${Date.now()}`, title: 'Typed post', body: 'Has a type.', post_type: 'event' },
    })
    expect(typed.status()).toBe(200)
    const typedBody = await typed.json()
    expect(typedBody.result?.isError).toBe(true)
    expect(typedBody.result?.content?.[0]?.text).toContain('post_type')

    const badAction = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'create_post',
      args: { organization_id: organizationId, idempotency_key: `cta-${Date.now()}`, body: 'Bad link.', call_to_action: { label: 'Book', url: 'javascript:alert(1)' } },
    })
    expect(badAction.status()).toBe(200)
    const badActionBody = await badAction.json()
    expect(badActionBody.result?.isError).toBe(true)
    expect(badActionBody.result?.content?.[0]?.text).toContain('call_to_action.url')
  })

  test('a draft is created once per key, publishes only to its named targets, and matches the public API', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!)
    const organizationId = MCP_ORGANIZATION_ID
    let createdPostId: string | undefined

    try {
      // The cover is one of the demo's own images: this is about publishing,
      // and uploading one would store a new image on every run.
      const imageAssetId = 'media-demo-burrata'

      const now = Date.now()
      const createArgs = {
        organization_id: organizationId,
        idempotency_key: `mcp-explicit-publication-${now}`,
        title: `MCP explicit publication ${now}`,
        body: 'Visible after explicit publication through MCP and the public API.',
        call_to_action: { label: 'Book a table', url: 'https://example.com/book' },
      }
      const create = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'create_post', args: createArgs })
      if (create.status() !== 200) console.error(await create.text())
      expect(create.status()).toBe(200)
      const created = mcpData<{ post: { id: string, slug: string }, replayed: boolean }>(await create.json())
      createdPostId = created.post.id
      expect(created.replayed).toBe(false)

      const replay = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'create_post', args: createArgs })
      expect(replay.status()).toBe(200)
      const replayed = mcpData<{ post: { id: string }, replayed: boolean }>(await replay.json())
      expect(replayed.replayed).toBe(true)
      expect(replayed.post.id).toBe(created.post.id)

      const placement = await mcpRequest(request, baseURL!, {
        method: 'tools/call',
        toolName: 'set_media',
        args: { organization_id: organizationId, placement: { owner_type: 'content_document', owner_id: created.post.id, slot: 'cover' }, asset_id: imageAssetId },
      })
      if (placement.status() !== 200) console.error(await placement.text())
      expect(placement.status()).toBe(200)
      const placementBody = await placement.json()
      expect(placementBody.result).toBeTruthy()
      expect(placementBody.result.isError).toBe(false)

      const read = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: created.post.id },
      })
      expect(read.status()).toBe(200)
      let draft = mcpData<{ post: { status: string; slug: string; updated_at: string; published_at: string | null; public_url: string | null; preview_url: string | null } }>(await read.json()).post
      expect(draft.status).toBe('draft')
      expect(draft.published_at).toBeNull()
      expect(draft.public_url).toBeNull()
      expect(draft.preview_url).toContain('preview_token=')
      expect((await request.get(`${tenantBaseURL}/api/public/posts/${encodeURIComponent(draft.slug)}`, { headers: tenantExtraHeaders })).status()).toBe(404)

      const postEditorPath = `${baseURL}/api/editor/organizations/${organizationId}/posts/${created.post.id}`
      const beforeRename = await request.get(postEditorPath)
      expect(beforeRename.status()).toBe(200)
      const originalDraft = (await beforeRename.json()).post
      const move = await request.patch(postEditorPath, { data: {
        expected_updated_at: draft.updated_at, title: 'Must not be saved', slug: 'another-post-address',
      } })
      expect(move.status()).toBe(400)
      expect((await move.json()).error).toBe('A post keeps its saved slug')
      const afterRefusedMove = await request.get(postEditorPath)
      expect(afterRefusedMove.status()).toBe(200)
      const unchangedDraft = (await afterRefusedMove.json()).post
      const { preview_url: originalDraftPreview, ...originalDraftFields } = originalDraft
      const { preview_url: unchangedDraftPreview, ...unchangedDraftFields } = unchangedDraft
      expect(unchangedDraftFields).toEqual(originalDraftFields)
      // Each read issues a fresh signed preview link. Its saved route remains
      // exact even though the short-lived credential can change.
      for (const previewUrl of [originalDraftPreview, unchangedDraftPreview]) {
        const preview = new URL(previewUrl, baseURL)
        expect(preview.pathname).toBe(originalDraft.public_path)
        expect(preview.searchParams.get('preview_token')).toBeTruthy()
      }
      const rename = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'update_post', args: {
          organization_id: organizationId, post_id: created.post.id, expected_updated_at: draft.updated_at,
          title: `Renamed short post ${now}`,
        },
      })
      expect(rename.status()).toBe(200)
      mcpData(await rename.json())
      const afterRename = await request.get(postEditorPath)
      expect(afterRename.status()).toBe(200)
      const renamedPost = (await afterRename.json()).post
      expect(renamedPost).toMatchObject({ title: `Renamed short post ${now}`, slug: created.post.slug, body: createArgs.body })
      expect(renamedPost.updated_at).not.toBe(draft.updated_at)
      draft = { ...draft, ...renamedPost }

      // Facebook is named with what get_social_connections reports; this
      // organization has no Page connected, so the outcome is exactly the
      // problem that read names, and the website still publishes.
      const connectionsRead = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_social_connections', args: { organization_id: organizationId } })
      expect(connectionsRead.status()).toBe(200)
      const facebook = mcpData<{ channels: Array<{ channel: string, connected: boolean, problems: Array<{ code: string }> }> }>(await connectionsRead.json())
        .channels.find(channel => channel.channel === 'facebook')!
      expect(facebook.connected).toBe(false)
      const facebookTarget = { channel: 'facebook', target_id: 'no-page-connected', connection_revision: 'none' }

      const publish = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_post',
        args: { organization_id: organizationId, post_id: created.post.id, expected_updated_at: draft.updated_at, targets: [{ channel: 'organization' }, facebookTarget] },
      })
      expect(publish.status()).toBe(200)
      const publishResult = (await publish.json()).result
      expect(publishResult.isError).toBe(true)
      expect(publishResult.structuredContent).toBeUndefined()
      const publishData = JSON.parse(publishResult.content[0].text) as { ok: boolean, updated_at: string, outcomes: Array<{ channel: string, status: string, code?: string }> }
      expect(publishData.ok).toBe(false)
      expect(publishData.outcomes.find(outcome => outcome.channel === 'organization')?.status).toBe('published')
      expect(publishData.outcomes.find(outcome => outcome.channel === 'facebook')).toMatchObject({ status: 'skipped', code: facebook.problems[0]!.code })

      const publishedRead = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: created.post.id },
      })
      const firstPost = mcpData<{ post: { status: string, slug: string, updated_at: string, published_at: string, publications: unknown[], media: Array<{ asset_id: string, slot: string }> } }>(await publishedRead.json()).post
      expect(firstPost.status).toBe('published')
      expect(firstPost.published_at).toEqual(expect.any(String))
      expect(firstPost.updated_at).toBe(publishData.updated_at)
      expect(firstPost.publications).toEqual([])
      expect(firstPost.media).toContainEqual(expect.objectContaining({ asset_id: imageAssetId, slot: 'cover' }))

      const publicRead = await request.get(`${tenantBaseURL}/api/public/posts/${encodeURIComponent(firstPost.slug)}`, { headers: tenantExtraHeaders })
      expect(publicRead.status()).toBe(200)
      const publicPost = (await publicRead.json() as { post: { id: string, call_to_action: { label: string, url: string } | null, media: Array<{ asset_id: string }> } }).post
      expect(publicPost.id).toBe(created.post.id)
      expect(publicPost.call_to_action).toEqual(createArgs.call_to_action)
      // Visitors get the media in order, cover first; which slot it came from is the editor's concern.
      expect(publicPost.media.map(item => item.asset_id)).toEqual([imageAssetId])

      // A repeat with the old revision returns the receipt and changes nothing.
      const repeat = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_post',
        args: { organization_id: organizationId, post_id: created.post.id, expected_updated_at: draft.updated_at, targets: [{ channel: 'organization' }] },
      })
      expect(repeat.status()).toBe(200)
      const repeatData = mcpData<{ ok: boolean, outcomes: Array<{ channel: string, status: string }> }>(await repeat.json())
      expect(repeatData.ok).toBe(true)
      expect(repeatData.outcomes).toEqual([expect.objectContaining({ channel: 'organization', status: 'already_published' })])
      const reread = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'get_post', args: { organization_id: organizationId, post_id: created.post.id },
      })
      const repeatedPost = mcpData<{ post: { published_at: string, updated_at: string } }>(await reread.json()).post
      expect(repeatedPost.published_at).toBe(firstPost.published_at)
      expect(repeatedPost.updated_at).toBe(firstPost.updated_at)
    } finally {
      if (createdPostId) {
        const cleanup = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'delete_post', args: { organization_id: organizationId, post_id: createdPostId } })
        expect(cleanup.status()).toBe(200)
        expect(mcpData<{ deleted: boolean }>(await cleanup.json()).deleted).toBe(true)
      }
    }
  })

  test('tenant blog tools preserve the canonical block document', async ({ request, page, baseURL }) => {
    await loginAs(request, baseURL!)
    const organizationId = MCP_ORGANIZATION_ID
    const discovery = await mcpRequest(request, baseURL!, { method: 'tools/list' })
    expect(discovery.status()).toBe(200)
    const catalog = await discovery.json() as { result: { tools: Array<{ name: string; outputSchema: object }> } }
    const blogTool = catalog.result.tools.find(tool => tool.name === 'get_blog_post')
    expect(blogTool).toBeDefined()
    const validateBlog = new Ajv({ strict: false, allErrors: true }).compile(blogTool!.outputSchema)
    let postId = ''
    let addedLocale = ''
    try {
      const categoryList = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'list_article_categories',
        args: { organization_id: organizationId, collection: 'blog' },
      })
      expect(categoryList.status()).toBe(200)
      const categories = mcpData<{ categories: Array<{ id: string; name: string }> }>(await categoryList.json()).categories
      const kitchenCategories = categories.filter(category => category.name === 'Kitchen')
      expect(kitchenCategories).toHaveLength(1)
      const categoryId = kitchenCategories[0]!.id
      expect(categoryId).toEqual(expect.any(String))

      const create = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'create_blog_post',
        args: {
          organization_id: organizationId,
          idempotency_key: `mcp-canonical-blog-${Date.now()}`,
          title: `MCP canonical blog ${Date.now()}`,
          category_id: categoryId,
          content_blocks: [
            { type: 'heading', level: 2, data: { text: 'Created through MCP' } },
            { type: 'markdown', data: { markdown: 'One shared **document**.', editor_mode: 'rich' } },
          ],
        },
      })
      if (create.status() !== 200) console.error(await create.text())
      expect(create.status()).toBe(200)
      const createBody = await create.json()
      const created = mcpData<{ post: { id: string; updated_at: string; content_blocks: Array<{ type: string }> } }>(createBody).post
      postId = created.id
      expect(created.updated_at).toEqual(expect.any(String))
      expect(created.content_blocks.map(block => block.type)).toEqual(['heading', 'markdown'])

      const get = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'get_blog_post',
        args: { organization_id: organizationId, post_id: postId },
      })
      expect(get.status()).toBe(200)
      const readData = mcpData<{ post: Record<string, unknown> & { updated_at: string; content_blocks: Array<{ type: string }> } }>(await get.json())
      expect(validateBlog(readData), JSON.stringify(validateBlog.errors)).toBe(true)
      const readPost = readData.post
      expect(readPost.status).toBe('draft')
      expect(readPost.published_at).toBeNull()
      expect(readPost.public_url).toBeNull()
      expect(readPost.preview_url).toContain('?preview_token=')
      expect(readPost.updated_at).toEqual(created.updated_at)
      expect(readPost.category).toMatchObject({ id: categoryId, name: 'Kitchen' })
      expect(readPost.content_blocks.map(block => block.type)).toEqual(['heading', 'markdown'])

      const update = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'update_blog_post',
        args: {
          organization_id: organizationId,
          post_id: postId,
          expected_updated_at: readPost.updated_at,
          title: 'Renamed canonical article',
          content_blocks: [
            { type: 'heading', level: 2, data: { text: 'Edited through MCP' } },
            { type: 'markdown', data: { markdown: 'Still one shared **document**.', editor_mode: 'rich' } },
            { type: 'faq', data: { source: 'page_qa' } },
          ],
        },
      })
      expect(update.status()).toBe(200)
      const updatedPost = mcpData<{ post: { updated_at: string; content_blocks: Array<{ type: string }> } }>(await update.json()).post
      expect(updatedPost.updated_at).toEqual(expect.any(String))
      expect(updatedPost.updated_at).not.toBe(readPost.updated_at)

      const updatedRead = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'get_blog_post', args: { organization_id: organizationId, post_id: postId },
      })
      expect(updatedRead.status()).toBe(200)
      const updatedReadPost = mcpData<{ post: { status: string; public_url: string | null; content_blocks: Array<{ type: string; data: Record<string, unknown> }> } }>(await updatedRead.json()).post
      expect(updatedReadPost.content_blocks.map(block => block.type)).toEqual(['heading', 'markdown', 'faq'])
      expect(updatedReadPost.content_blocks[0]?.data.text).toBe('Edited through MCP')
      expect(updatedReadPost.status).toBe('draft')
      expect(updatedReadPost.public_url).toBeNull()
      const editorRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/blog/${postId}`)
      expect(editorRead.status()).toBe(200)
      const editorPost = (await editorRead.json() as { post: { body: string; title: string; slug: string; updated_at: string; public_path: string; preview_url: string } }).post
      expect(editorPost.body).toContain('Edited through MCP')
      expect(editorPost.body).toContain('Still one shared **document**.')
      expect(editorPost.title).toBe('Renamed canonical article')
      expect(editorPost.slug).toBe(readPost.slug)
      const rejectedMove = await request.patch(`${baseURL}/api/editor/organizations/${organizationId}/blog/${postId}`, { data: {
        title: 'Must not be saved', slug: 'another-article-address', expected_updated_at: editorPost.updated_at,
      } })
      expect(rejectedMove.status()).toBe(400)
      expect((await rejectedMove.json()).error).toBe('An article keeps its saved slug')
      const unchangedArticle = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/blog/${postId}`)
      expect(unchangedArticle.status()).toBe(200)
      const unchangedArticlePost = (await unchangedArticle.json()).post
      const { preview_url: originalArticlePreview, ...originalArticleFields } = editorPost
      const { preview_url: unchangedArticlePreview, ...unchangedArticleFields } = unchangedArticlePost
      expect(unchangedArticleFields).toEqual(originalArticleFields)
      for (const previewUrl of [originalArticlePreview, unchangedArticlePreview]) {
        const preview = new URL(previewUrl, baseURL)
        expect(preview.pathname).toBe(editorPost.public_path)
        expect(preview.searchParams.get('preview_token')).toBeTruthy()
      }

      const editor = `${baseURL}/api/editor/organizations/${organizationId}`
      const languageSettingsResponse = await request.get(`${editor}/locales`)
      expect(languageSettingsResponse.status()).toBe(200)
      const languageSettings = await languageSettingsResponse.json() as { languages: Array<{ locale: string }>; available_catalogs: Array<{ locale: string }> }
      const language = languageSettings.available_catalogs.find(candidate => !languageSettings.languages.some(saved => saved.locale === candidate.locale))
      expect(language, 'The paid fixture has a language available for private article authoring').toBeDefined()
      addedLocale = language!.locale
      const added = await request.post(`${editor}/locales/${addedLocale}/add`)
      expect(added.status(), await added.text()).toBe(200)
      expect((await added.json()).language).toMatchObject({ locale: addedLocale, status: 'disabled' })
      const savedLanguagesResponse = await request.get(`${editor}/locales`)
      expect(savedLanguagesResponse.status()).toBe(200)
      const savedLanguages = await savedLanguagesResponse.json() as { languages: Array<{ locale: string; status: string }> }
      expect(savedLanguages.languages.find(language => language.locale === addedLocale)).toMatchObject({ locale: addedLocale, status: 'disabled' })
      const translatedBlocks = [
        { type: 'heading', level: 2, data: { text: 'Translated article heading' } },
        { type: 'markdown', data: { markdown: 'Translated **article** body.', editor_mode: 'rich' } },
        { type: 'faq', data: { source: 'page_qa' } },
      ]
      const translation = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'put_resource_localization', args: {
        organization_id: organizationId, resource_type: 'content_document', resource_id: postId, locale: addedLocale,
        values: { title: 'Translated article title', summary: 'Translated article excerpt', seo_keywords: 'Preserved translated keywords', metadata: {} },
        content_blocks: translatedBlocks,
      } })
      expect(translation.status(), await translation.text()).toBe(200)
      const authoredTranslation = mcpData<{ localization: { title: string; summary: string; updated_at: string; path: string; slug: string; seo_keywords: string; metadata: Record<string, unknown> } }>(await translation.json()).localization
      expect(authoredTranslation).toMatchObject({ title: 'Translated article title', summary: 'Translated article excerpt', seo_keywords: 'Preserved translated keywords', metadata: {} })
      await loginAs(page.request, baseURL!)
      expect(readPost.admin_edit_url).toEqual(expect.any(String))
      const translationEditor = new URL(String(readPost.admin_edit_url), baseURL)
      translationEditor.searchParams.set('editMode', 'translations')
      translationEditor.searchParams.set('locale', addedLocale)
      await page.goto(translationEditor.toString())
      await waitForNuxtHydration(page)
      await expect(page.getByTestId('localize-field-title')).toHaveValue(authoredTranslation.title)
      await expect(page.getByTestId('localize-field-summary')).toHaveValue(authoredTranslation.summary)
      await page.getByTestId('localize-field-title').fill('')
      await page.getByTestId('localize-field-summary').fill('')
      const localizationPath = `/api/editor/organizations/${organizationId}/localization/content_document/${postId}/${addedLocale}`
      const cleared = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === localizationPath),
        page.getByTestId('localize-save').click(),
      ]).then(([response]) => response)
      expect(cleared.status(), await cleared.text()).toBe(200)
      const clearedWrite = cleared.request().postDataJSON()
      expect(clearedWrite.values).toEqual({ title: null, summary: null, seo_keywords: authoredTranslation.seo_keywords, metadata: authoredTranslation.metadata })
      expect(clearedWrite.expected_updated_at).toBe(authoredTranslation.updated_at)
      const clearedRead = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_resource_localization', args: {
        organization_id: organizationId, resource_type: 'content_document', resource_id: postId, locale: addedLocale,
      } })
      expect(clearedRead.status()).toBe(200)
      const clearedTranslation = mcpData<{ localization: { title: string | null; summary: string | null; updated_at: string; path: string; slug: string; seo_keywords: string; metadata: Record<string, unknown>; content_blocks: Array<{ type: string; data: Record<string, unknown> }> } }>(await clearedRead.json()).localization
      expect(clearedTranslation).toMatchObject({ title: null, summary: null, path: authoredTranslation.path, slug: authoredTranslation.slug, seo_keywords: authoredTranslation.seo_keywords, metadata: authoredTranslation.metadata })
      expect(clearedTranslation.metadata).toEqual(authoredTranslation.metadata)
      expect(clearedTranslation.updated_at).not.toBe(authoredTranslation.updated_at)
      expect(clearedTranslation.content_blocks.map(({ type, data }) => ({ type, data }))).toEqual(translatedBlocks.map(({ type, data }) => ({ type, data })))

      // Articles publish now or stay drafts: there is no scheduling.
      const schedule = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_blog_post',
        args: { organization_id: organizationId, post_id: postId, expected_updated_at: updatedPost.updated_at, scheduled_for: '2099-01-01T00:00:00.000Z' },
      })
      const scheduleBody = await schedule.json()
      expect(scheduleBody.result?.isError).toBe(true)
      expect(scheduleBody.result?.content?.[0]?.text).toContain('scheduled_for')
      const publish = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_blog_post',
        args: { organization_id: organizationId, post_id: postId, expected_updated_at: updatedPost.updated_at },
      })
      const published = mcpData<{ post: { status: string; updated_at: string; public_url: string; published_at: string } }>(await publish.json()).post
      expect(published.status).toBe('published')
      expect(published.public_url).toEqual(expect.any(String))
      expect(published.published_at).toEqual(expect.any(String))
      const republish = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'publish_blog_post',
        args: { organization_id: organizationId, post_id: postId, expected_updated_at: published.updated_at },
      })
      const republished = mcpData<{ post: { updated_at: string; published_at: string } }>(await republish.json()).post
      expect(republished.published_at).toBe(published.published_at)
      expect(republished.updated_at).toBe(published.updated_at)
      const unlist = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'update_blog_post',
        args: { organization_id: organizationId, post_id: postId, expected_updated_at: published.updated_at, visibility: 'unlisted' },
      })
      const unlisted = mcpData<{ post: { status: string; visibility: string; public_url: string; published_at: string } }>(await unlist.json()).post
      expect(unlisted.status).toBe('published')
      expect(unlisted.visibility).toBe('unlisted')
      expect(unlisted.public_url).toBe(published.public_url)
      expect(unlisted.published_at).toBe(published.published_at)
    } finally {
      if (postId) {
        const cleanup = await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'delete_blog_post', args: { organization_id: organizationId, post_id: postId },
        })
        expect(cleanup.status()).toBe(200)
      }
      if (addedLocale) {
        const cleanupLanguage = await request.delete(`${baseURL}/api/editor/organizations/${organizationId}/locales/${addedLocale}`)
        expect(cleanupLanguage.status(), await cleanupLanguage.text()).toBe(200)
        expect(await cleanupLanguage.json()).toEqual({ deleted: true, locale: addedLocale })
        const languagesAfterCleanup = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/locales`)
        expect(languagesAfterCleanup.status(), await languagesAfterCleanup.text()).toBe(200)
        const cleanedLanguages = await languagesAfterCleanup.json() as { languages: Array<{ locale: string }> }
        expect(cleanedLanguages.languages.map(language => language.locale)).not.toContain(addedLocale)
      }
    }
  })

  test('requires auth and handles stateless discovery/list/error flow without initialize', async ({ request, baseURL }) => {
    const unauthenticated = await mcpRequest(request, baseURL!, { method: 'server/discover' })
    expect(unauthenticated.status()).toBe(401)

    await loginAs(request, baseURL!)

    // server/discover is a pre-handshake shortcut some clients use before the
    // spec's own initialize -> version-mismatch -> retry negotiation.
    // @modelcontextprotocol/server only wires it up for servers that speak
    // the modern (2026-07-28+) protocol era; this server intentionally only
    // serves the legacy eras (see server/api/mcp.ts), so it falls
    // through to the same -32601 fallback as any other unregistered method
    // rather than answering a bespoke, partial handshake.
    const discover = await mcpRequest(request, baseURL!, { method: 'server/discover', id: 'discover-1' })
    expect(discover.status()).toBe(200)
    const discoverBody = await discover.json() as { id: string; error: { code: number } }
    expect(discoverBody.id).toBe('discover-1')
    expect(discoverBody.error.code).toBe(-32601)

    const toolsList = await mcpRequest(request, baseURL!, { method: 'tools/list', id: 'list-no-site' })
    expect(toolsList.status()).toBe(200)
    const listBody = await toolsList.json() as { result: { tools: Array<{ name: string }> } }
    // Without organization_id, all non-gated tools must be discoverable so AI clients (e.g. ChatGPT) see
    // the full capability set on first connection. Security gates enforce at execution time, not
    // at discovery.
    const allToolNames = listBody.result.tools.map(tool => tool.name)
    expect(allToolNames).toEqual(expect.arrayContaining([
      'list_organizations',
      'get_organization', 'list_locations', 'list_location_products', 'list_posts', 'get_organization_media_assets',
      'list_site_pages', 'list_products', 'list_collections', 'list_guest_conversations',
    ]))
    const invalid = await mcpRequest(request, baseURL!, { method: 'bad/method', id: 'bad-method' })
    expect(invalid.status()).toBe(200)
    const invalidBody = await invalid.json() as { id: string; error: { code: number; message: string } }
    expect(invalidBody.id).toBe('bad-method')
    expect(invalidBody.error.code).toBe(-32601)
    expect(invalidBody.error.message).toContain('Method not found')
  })

})
