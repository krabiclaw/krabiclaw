import { expect, test } from '@playwright/test'
import { blawbyBaseURL, blawbyExtraHeaders, openTenantPage } from './helpers'
import { testBaseUrl, tenantTestBaseUrl, tenantTestExtraHeaders } from './test-env'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'

// Tenant behaviour that writes content or reads local-only routing. Real
// customer content is checked read-only against deployed sites in tests/deployed.

test('unknown sites render an unbranded 404 while resolved tenant errors retain their identity', async ({ page }) => {
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

for (const tenant of [
  { name: 'Saya', organizationId: 'org-demo', baseURL: tenantTestBaseUrl(), headers: tenantTestExtraHeaders(), path: '/about', schemaType: 'Organization' },
  { name: 'Blawby', organizationId: 'org-ncls-blawby', baseURL: blawbyBaseURL, headers: blawbyExtraHeaders, path: '/about', schemaType: 'LegalService' },
  { name: 'Cedar Legal Demo', organizationId: '5WebMejsoVLyZLHC29wHH5GbQx1jlvCd', baseURL: testBaseUrl(), headers: { 'x-preview-tenant': 'cedar-legal' }, path: '/contact', ownerId: 'ivUlJc9BoyZeFszowpbUEjh1pugcDHiT', schemaType: 'ProfessionalService' },
]) {
  test(`${tenant.name} ${tenant.path} CMS-authored HowTo persists and accompanies the public page schema`, async ({ page, request, baseURL }) => {
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

test('a featured image alt text saved in the media library reaches the rendered page', async ({ page, request, baseURL }, testInfo) => {
  const tenant = { baseURL: blawbyBaseURL, headers: blawbyExtraHeaders }
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
