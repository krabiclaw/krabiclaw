import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { dismissPreviewToolbar, openTenantPage, tenantBaseURL, tenantExtraHeaders, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { Collection, Product } from '../../server/types/products'

const organizationId = 'org-demo'
const editor = `/api/editor/organizations/${organizationId}`
const catalog = '/dashboard/ember-slice-demo/products'

// A collection replacement must retain every member, including products that
// a location-filtered catalog does not return. This exercises the real editor
// controls and reads their persisted outcome through the organization catalog.
test('shared-section membership survives a location-filtered edit', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000)
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(baseURL!).hostname)
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  const products: Product[] = []
  const sections: Collection[] = []
  try {
    await loginAs(page.request, baseURL!, 'user-e2e-demo-owner')
    await dismissPreviewToolbar(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    const run = randomUUID()
    for (const label of ['Located dish', 'Unassigned dish']) {
      const response = await page.request.post(`${editor}/products`, {
        data: { kind: 'dish', name: `${label} ${run}`, idempotency_key: randomUUID() },
      })
      expect(response.status(), await response.text()).toBe(201)
      products.push((await response.json() as { product: Product }).product)
    }
    const [located, unassigned] = products as [Product, Product]
    const binding = await page.request.put(`${editor}/products/${located.id}/locations/loc-demo`, { data: { active: true, published: false } })
    expect(binding.status(), await binding.text()).toBe(200)
    for (const label of ['Source section', 'Target section']) {
      const response = await page.request.post(`${editor}/collections`, { data: { name: `${label} ${run}`, location_id: null } })
      expect(response.status(), await response.text()).toBe(201)
      sections.push((await response.json() as { collection: Collection }).collection)
    }
    const [source, target] = sections as [Collection, Collection]
    for (const [section, members] of [[source, [located.id, unassigned.id]], [target, [unassigned.id]]] as const) {
      const response = await page.request.put(`${editor}/collections/${section.id}/products`, { data: { product_ids: members } })
      expect(response.status(), await response.text()).toBe(200)
    }

    const scoped = await page.request.get(`${editor}/locations/loc-demo/products`)
    expect(scoped.status(), await scoped.text()).toBe(200)
    const scopedProducts = (await scoped.json() as { products: Product[] }).products
    expect(scopedProducts.filter(product => products.some(created => created.id === product.id)).map(product => product.id)).toEqual([located.id])

    const readMemberships = async () => {
      const response = await page.request.get(`${editor}/products`)
      expect(response.status(), await response.text()).toBe(200)
      const persisted = (await response.json() as { products: Product[] }).products
      expect(persisted.find(product => product.id === located.id)?.locations).toEqual([{ location_id: 'loc-demo', active: true, published: false }])
      expect(persisted.find(product => product.id === unassigned.id)?.locations).toEqual([])
      return [source, target].map(section => persisted.flatMap(product => product.collections
        .filter(membership => membership.collection_id === section.id)
        .map(membership => ({ id: product.id, order: membership.sort_order })))
        .sort((left, right) => left.order - right.order))
    }

    expect((await page.goto(`${catalog}/menu?location_id=loc-demo`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await expect(page.locator('#dashboard-panel-catalog-menu').getByRole('link', { name: source.name })).toHaveAttribute('href', `${catalog}/menu/${source.id}`)

    // Old shared links can still carry a location query. It may scope prices,
    // but it must never filter the membership this editor replaces.
    expect((await page.goto(`${catalog}/menu/${source.id}?location_id=loc-demo`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const panel = page.locator('#dashboard-panel-menu-section')
    const rows = panel.locator('span[data-testid^="product-"]')
    await expect(panel.getByTestId(`product-${located.id}`)).toContainText(located.name)
    await expect(panel.getByTestId(`product-${unassigned.id}`)).toContainText(unassigned.name)
    await panel.getByTestId('list-editor-toggle').click()
    await panel.getByRole('button', { name: `Move ${unassigned.name} up`, exact: true }).click()
    const reordered = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${source.id}/products` && response.request().method() === 'PUT')
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    expect((await reordered).status()).toBe(200)
    expect(await readMemberships()).toEqual([
      [{ id: unassigned.id, order: 0 }, { id: located.id, order: 1 }], [{ id: unassigned.id, order: 0 }],
    ])
    await expect(rows.nth(0)).toHaveAttribute('data-testid', `product-${unassigned.id}`)
    await expect(rows.nth(1)).toHaveAttribute('data-testid', `product-${located.id}`)

    await panel.getByTestId('list-editor-toggle').click()
    await panel.getByRole('checkbox', { name: `Select ${unassigned.name}`, exact: true }).check()
    const removed = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${source.id}/products` && response.request().method() === 'PUT')
    await panel.getByTestId('product-remove-from-section').click()
    expect((await removed).status()).toBe(200)
    expect(await readMemberships()).toEqual([[{ id: located.id, order: 0 }], [{ id: unassigned.id, order: 0 }]])
    await expect(panel.getByTestId(`product-${unassigned.id}`)).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()

    await panel.getByTestId('list-editor-toggle').click()
    await panel.getByRole('checkbox', { name: `Select ${located.name}`, exact: true }).check()
    await panel.getByTestId('product-move-open').click()
    const dialog = page.getByRole('dialog', { name: 'Move item', exact: true })
    await dialog.getByRole('radio', { name: target.name, exact: true }).check()
    const destinationSaved = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${target.id}/products` && response.request().method() === 'PUT')
    const sourceSaved = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${source.id}/products` && response.request().method() === 'PUT')
    await dialog.getByTestId('list-item-save').click()
    expect((await destinationSaved).status()).toBe(200)
    expect((await sourceSaved).status()).toBe(200)
    expect(await readMemberships()).toEqual([[], [{ id: unassigned.id, order: 0 }, { id: located.id, order: 1 }]])
    await expect(dialog).toBeHidden()
    await expect(panel.getByText('No items in this section yet', { exact: true })).toBeVisible()
  } finally {
    try {
      const paths = [...sections.map(section => `${editor}/collections/${section.id}`), ...products.map(product => `${editor}/products/${product.id}`)]
      const deleted = await Promise.allSettled(paths.map(path => page.request.delete(path)))
      const failures: string[] = []
      for (const [index, result] of deleted.entries()) {
        if (result.status === 'rejected') failures.push(`${paths[index]}: ${String(result.reason)}`)
        else if (result.value.status() !== 200) failures.push(`${paths[index]}: ${result.value.status()} ${await result.value.text()}`)
      }
      expect(failures, 'Every authored product and section must be deleted').toEqual([])
      const [productRead, sectionRead] = await Promise.all([page.request.get(`${editor}/products`), page.request.get(`${editor}/collections`)])
      expect(productRead.status(), await productRead.text()).toBe(200)
      expect(sectionRead.status(), await sectionRead.text()).toBe(200)
      const remainingProducts = (await productRead.json() as { products: Product[] }).products
      const remainingSections = (await sectionRead.json() as { collections: Collection[] }).collections
      expect(remainingProducts.filter(product => products.some(created => created.id === product.id))).toEqual([])
      expect(remainingSections.filter(section => sections.some(created => created.id === section.id))).toEqual([])
    } finally { await release() }
  }
})

// A section's own photo introduces it on the public menu and in its
// MenuSection structured data. The photo is set through the placement the
// section editor writes, read back through the collections list, and seen on
// the storefront; the section's previous photo is put back afterwards.
test('a section photo introduces its section on the public menu', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000)
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  let restore: { id: string; assetId: string | null } | null = null
  const setPhoto = async (collectionId: string, assetId: string | null) => {
    const response = await page.request.put(`${editor}/media/placements`, {
      data: { placement: { owner_type: 'collection', owner_id: collectionId, slot: 'image' }, asset_id: assetId },
    })
    expect(response.status(), await response.text()).toBe(200)
  }
  try {
    await loginAs(page.request, baseURL!, 'user-e2e-demo-owner')
    await openTenantPage(page, `${tenantBaseURL}/menu`, tenantExtraHeaders)
    const listed = await page.request.get(`${editor}/collections`)
    expect(listed.status(), await listed.text()).toBe(200)
    const collections = (await listed.json() as { collections: Collection[] }).collections
    let section: Collection | undefined
    for (const candidate of collections) {
      if (await page.getByRole('heading', { level: 2, name: candidate.name, exact: true }).count()) { section = candidate; break }
    }
    expect(section, 'The public menu shows one of the demo sections').toBeDefined()
    restore = { id: section!.id, assetId: section!.image?.asset_id ?? null }
    // One of the demo's own images, so the run stores nothing new.
    const assetId = section!.image?.asset_id === 'media-demo-burrata' ? 'media-demo-margherita' : 'media-demo-burrata'
    await setPhoto(section!.id, assetId)

    const reread = await page.request.get(`${editor}/collections`)
    expect(reread.status(), await reread.text()).toBe(200)
    const image = (await reread.json() as { collections: Collection[] }).collections.find(row => row.id === section!.id)?.image
    expect(image?.asset_id).toBe(assetId)
    expect(image?.public_url).toBeTruthy()

    await openTenantPage(page, `${tenantBaseURL}/menu`, tenantExtraHeaders)
    // The picture that introduces the section is the one set above its own heading, not a dish's.
    const intro = page.getByRole('heading', { level: 2, name: section!.name, exact: true }).locator('xpath=preceding-sibling::img')
    await expect(intro).toHaveCount(1)
    await intro.scrollIntoViewIfNeeded()
    await expect(intro).toBeVisible()
    await expect(intro).toHaveAttribute('src', image!.public_url)
    const menuSections: unknown[] = []
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collect)
      if (!value || typeof value !== 'object') return
      if ((value as { '@type'?: unknown })['@type'] === 'MenuSection') menuSections.push(value)
      Object.values(value).forEach(collect)
    }
    for (const text of await page.locator('script[type="application/ld+json"]').allTextContents()) collect(JSON.parse(text))
    expect(menuSections).toContainEqual(expect.objectContaining({ name: section!.name, image: image!.public_url }))
  } finally {
    try {
      if (restore) await setPhoto(restore.id, restore.assetId)
    } finally {
      await release()
    }
  }
})
