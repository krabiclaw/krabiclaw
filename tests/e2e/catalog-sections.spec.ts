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
    const run = randomUUID().slice(0, 8)
    for (const label of ['Pumpkin udon', 'Miso mushrooms']) {
      const response = await page.request.post(`${editor}/products`, {
        data: { kind: 'dish', name: `${label} ${run}`, idempotency_key: randomUUID() },
      })
      expect(response.status(), await response.text()).toBe(201)
      products.push((await response.json() as { product: Product }).product)
    }
    const [located, unassigned] = products as [Product, Product]
    const binding = await page.request.put(`${editor}/products/${located.id}/locations/loc-demo`, { data: { active: true, published: false } })
    expect(binding.status(), await binding.text()).toBe(200)
    const locationsRead = await page.request.get('/api/dashboard/locations', { params: { org: 'ember-slice-demo', organization: 'true' } })
    expect(locationsRead.status(), await locationsRead.text()).toBe(200)
    const location = (await locationsRead.json() as { locations: Array<{ id: string; title: string; slug: string }> }).locations.find(location => location.id === 'loc-demo')
    expect(location).toBeDefined()
    for (const [label, locationId] of [['Spring specials', null], ['House favourites', null], ['Evening menu', 'loc-demo']] as const) {
      const response = await page.request.post(`${editor}/collections`, { data: { name: `${label} ${run}`, location_id: locationId } })
      expect(response.status(), await response.text()).toBe(201)
      sections.push((await response.json() as { collection: Collection }).collection)
    }
    const [source, sharedTarget, target] = sections as [Collection, Collection, Collection]
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

    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`${catalog}/menu?location_id=missing-location`)
    await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
    await expect(page.getByTestId('menu-scope-shared')).toHaveCount(0)
    expect(pageErrors).toEqual([])

    expect((await page.goto(`${catalog}/menu?location_id=loc-demo`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await expect(page.locator('#dashboard-panel-catalog-menu').getByRole('link', { name: source.name })).toHaveAttribute('href', `${catalog}/menu/${source.id}?kind=dish`)

    // Section order belongs to its explicit scope. Moving a shared section
    // stays a draft until Done and leaves the location's own section alone.
    expect((await page.goto(`${catalog}/menu`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const menu = page.locator('#dashboard-panel-catalog-menu')
    const beforeOrder = await page.request.get(`${editor}/collections`)
    expect(beforeOrder.status(), await beforeOrder.text()).toBe(200)
    const beforeSections = (await beforeOrder.json() as { collections: Collection[] }).collections
    const sharedBefore = beforeSections.filter(section => section.location_id === null).map(section => section.id)
    const visibleSectionRows = menu.getByTestId('menu-scope-shared').locator('span[data-testid^="collection-"]')
    const visibleBefore = await visibleSectionRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')!.slice('collection-'.length)))
    expect(visibleBefore).toContain(source.id)
    expect(visibleBefore).toContain(sharedTarget.id)
    expect(visibleBefore).toEqual(sharedBefore.filter(id => visibleBefore.includes(id)))
    const targetVisibleIndex = visibleBefore.indexOf(sharedTarget.id)
    const direction = targetVisibleIndex > 0 ? 'up' : 'down'
    const neighbourId = visibleBefore[targetVisibleIndex + (direction === 'up' ? -1 : 1)]!
    expect(neighbourId).toBeDefined()
    const targetIndex = sharedBefore.indexOf(sharedTarget.id)
    const neighbourIndex = sharedBefore.indexOf(neighbourId)
    const sharedAfter = [...sharedBefore]
    sharedAfter[targetIndex] = neighbourId
    sharedAfter[neighbourIndex] = sharedTarget.id
    await menu.getByTestId('list-editor-toggle').click()
    await menu.getByRole('button', { name: `Move ${sharedTarget.name} ${direction}`, exact: true }).click()
    const unsavedOrder = await page.request.get(`${editor}/collections`)
    expect(unsavedOrder.status(), await unsavedOrder.text()).toBe(200)
    expect((await unsavedOrder.json() as { collections: Collection[] }).collections).toEqual(beforeSections)

    // Another editor commits after this draft was read. Even the same desired
    // order cannot silently replace that newer snapshot.
    const concurrentOrder = await page.request.put(`${editor}/collections/order`, { data: { collection_ids: sharedAfter, expected_collection_ids: sharedBefore, location_id: null } })
    expect(concurrentOrder.status(), await concurrentOrder.text()).toBe(200)
    const concurrentOrderRead = await page.request.get(`${editor}/collections`)
    expect(concurrentOrderRead.status(), await concurrentOrderRead.text()).toBe(200)
    const concurrentSections = (await concurrentOrderRead.json() as { collections: Collection[] }).collections
    expect(concurrentSections.filter(section => section.location_id === null).map(section => section.id)).toEqual(sharedAfter)
    const staleOrderSaved = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/order` && response.request().method() === 'PUT')
    await menu.getByRole('button', { name: 'Done', exact: true }).click()
    const staleOrderResponse = await staleOrderSaved
    expect(staleOrderResponse.status(), await staleOrderResponse.text()).toBe(409)
    expect(staleOrderResponse.request().postDataJSON()).toEqual({ collection_ids: sharedAfter, expected_collection_ids: sharedBefore, location_id: null })
    expect(await staleOrderResponse.json()).toMatchObject({ data: { code: 'COLLECTION_ORDER_CHANGED', field: 'expected_collection_ids' } })
    const refusedOrderRead = await page.request.get(`${editor}/collections`)
    expect(refusedOrderRead.status(), await refusedOrderRead.text()).toBe(200)
    expect((await refusedOrderRead.json() as { collections: Collection[] }).collections).toEqual(concurrentSections)
    await expect(menu).toContainText('The section order changed while you were editing.')
    await expect(menu.getByTestId('list-editor-toggle')).toBeDisabled()
    await page.getByRole('navigation', { name: 'Dashboard', exact: true }).getByRole('link', { name: 'Catalog', exact: true }).click()
    await expect(page).toHaveURL(`${catalog}/menu`)
    await menu.getByRole('button', { name: 'Use current order', exact: true }).click()
    await expect(menu.getByRole('button', { name: 'Use current order', exact: true })).toHaveCount(0)
    await expect(menu.getByTestId('list-editor-toggle')).toBeEnabled()
    expect(await visibleSectionRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')!.slice('collection-'.length)))).toEqual(sharedAfter.filter(id => visibleBefore.includes(id)))
    await menu.getByTestId('list-editor-toggle').click()
    await menu.getByRole('button', { name: `Move ${sharedTarget.name} ${direction === 'up' ? 'down' : 'up'}`, exact: true }).click()
    const recoveredDraftRead = await page.request.get(`${editor}/collections`)
    expect(recoveredDraftRead.status(), await recoveredDraftRead.text()).toBe(200)
    expect((await recoveredDraftRead.json() as { collections: Collection[] }).collections).toEqual(concurrentSections)
    const sectionOrderSaved = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/order` && response.request().method() === 'PUT')
    await menu.getByRole('button', { name: 'Done', exact: true }).click()
    const sectionOrderResponse = await sectionOrderSaved
    expect(sectionOrderResponse.status(), await sectionOrderResponse.text()).toBe(200)
    expect(sectionOrderResponse.request().postDataJSON()).toEqual({ collection_ids: sharedBefore, expected_collection_ids: sharedAfter, location_id: null })
    const savedOrder = await page.request.get(`${editor}/collections`)
    expect(savedOrder.status(), await savedOrder.text()).toBe(200)
    const savedSections = (await savedOrder.json() as { collections: Collection[] }).collections
    expect(savedSections.filter(section => section.location_id === null).map(section => section.id)).toEqual(sharedBefore)
    expect(savedSections.filter(section => section.location_id === 'loc-demo')).toEqual(beforeSections.filter(section => section.location_id === 'loc-demo'))

    // Menu supplies its dish context explicitly. A location may scope prices,
    // but it must never filter the membership this editor replaces.
    expect((await page.goto(`${catalog}/menu/${source.id}?location_id=loc-demo&kind=dish`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const panel = page.locator('#dashboard-panel-menu-section')
    const rows = panel.locator('span[data-testid^="product-"]')
    await expect(panel.getByTestId(`product-${located.id}`)).toContainText(located.name)
    await expect(panel.getByTestId(`product-${unassigned.id}`)).toContainText(unassigned.name)
    await panel.getByTestId('list-editor-toggle').click()
    await panel.getByRole('button', { name: `Move ${unassigned.name} up`, exact: true }).click()
    expect(await readMemberships()).toEqual([
      [{ id: located.id, order: 0 }, { id: unassigned.id, order: 1 }], [{ id: unassigned.id, order: 0 }],
    ])
    const reordered = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${source.id}/products` && response.request().method() === 'PUT')
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    const reorderedResponse = await reordered
    expect(reorderedResponse.status(), await reorderedResponse.text()).toBe(200)
    expect(reorderedResponse.request().postDataJSON()).toEqual({ product_ids: [unassigned.id, located.id], expected_product_ids: [located.id, unassigned.id] })
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

    // Adding a catalog dish changes section membership only after the commit;
    // it does not make an unassigned dish available at this location.
    await panel.getByRole('button', { name: 'Add dish', exact: true }).click()
    const addDialog = page.getByRole('dialog', { name: 'Add dishes', exact: true })
    await addDialog.getByRole('textbox', { name: 'Search dishes', exact: true }).fill(unassigned.name)
    await addDialog.getByRole('checkbox', { name: unassigned.name, exact: true }).check()
    expect(await readMemberships()).toEqual([[{ id: located.id, order: 0 }], [{ id: unassigned.id, order: 0 }]])
    await addDialog.getByRole('button', { name: 'Close Add dishes', exact: true }).click()
    await expect(addDialog).toBeHidden()
    expect(await readMemberships()).toEqual([[{ id: located.id, order: 0 }], [{ id: unassigned.id, order: 0 }]])
    await panel.getByRole('button', { name: 'Add dish', exact: true }).click()
    await addDialog.getByRole('textbox', { name: 'Search dishes', exact: true }).fill(unassigned.name)
    await addDialog.getByRole('checkbox', { name: unassigned.name, exact: true }).check()
    const added = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${source.id}/products` && response.request().method() === 'PUT')
    await addDialog.getByRole('button', { name: 'Add', exact: true }).click()
    const addedResponse = await added
    expect(addedResponse.status(), await addedResponse.text()).toBe(200)
    expect(addedResponse.request().postDataJSON()).toEqual({ product_ids: [located.id, unassigned.id], expected_product_ids: [located.id] })
    expect(await readMemberships()).toEqual([[{ id: located.id, order: 0 }, { id: unassigned.id, order: 1 }], [{ id: unassigned.id, order: 0 }]])
    await expect(addDialog).toBeHidden()
    await expect(panel.getByTestId(`product-${located.id}`)).toContainText('Not listed')
    await expect(panel.getByTestId(`product-${unassigned.id}`)).toContainText('No photo')

    await panel.getByTestId('list-editor-toggle').click()
    await panel.getByRole('checkbox', { name: `Select ${located.name}`, exact: true }).check()
    await panel.getByTestId('product-move-open').click()
    const dialog = page.getByRole('dialog', { name: 'Move item', exact: true })
    await dialog.getByText(target.name, { exact: true }).click()
    await expect(dialog.getByRole('radio', { name: `${target.name} ${location!.title}`, exact: true })).toBeChecked()
    const concurrentTarget = await page.request.put(`${editor}/collections/${target.id}/products`, { data: { product_ids: [], expected_product_ids: [unassigned.id] } })
    expect(concurrentTarget.status(), await concurrentTarget.text()).toBe(200)
    const moveWrites: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'PUT' && path.startsWith(`${editor}/collections/`) && path.endsWith('/products')) moveWrites.push(path)
    })
    const staleMove = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${source.id}/products` && response.request().method() === 'PUT')
    await dialog.getByTestId('list-item-save').click()
    const staleMoveResponse = await staleMove
    expect(staleMoveResponse.status(), await staleMoveResponse.text()).toBe(409)
    expect(await staleMoveResponse.json()).toMatchObject({ data: { code: 'COLLECTION_PRODUCTS_CHANGED', field: 'expected_product_ids', collection_id: target.id } })
    expect(staleMoveResponse.request().postDataJSON()).toEqual({ product_ids: [unassigned.id], expected_product_ids: [located.id, unassigned.id], move_to: { collection_id: target.id, expected_product_ids: [unassigned.id] } })
    expect(await readMemberships()).toEqual([[{ id: located.id, order: 0 }, { id: unassigned.id, order: 1 }], []])
    await expect(dialog).toContainText('The section membership or order changed while you were editing.')
    await expect(dialog.getByRole('radio', { name: `${target.name} ${location!.title}`, exact: true })).toBeChecked()
    await dialog.getByRole('button', { name: 'Use current items', exact: true }).click()
    await expect(dialog).toBeHidden()
    await panel.getByTestId('list-editor-toggle').click()
    await panel.getByRole('checkbox', { name: `Select ${located.name}`, exact: true }).check()
    await panel.getByTestId('product-move-open').click()
    await dialog.getByText(target.name, { exact: true }).click()
    const sourceSaved = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${source.id}/products` && response.request().method() === 'PUT')
    await dialog.getByTestId('list-item-save').click()
    const sourceSavedResponse = await sourceSaved
    expect(sourceSavedResponse.status(), await sourceSavedResponse.text()).toBe(200)
    expect(sourceSavedResponse.request().postDataJSON()).toEqual({ product_ids: [unassigned.id], expected_product_ids: [located.id, unassigned.id], move_to: { collection_id: target.id, expected_product_ids: [] } })
    expect(moveWrites).toEqual([`${editor}/collections/${source.id}/products`, `${editor}/collections/${source.id}/products`])
    expect(await readMemberships()).toEqual([[{ id: unassigned.id, order: 0 }], [{ id: located.id, order: 0 }]])
    await expect(dialog).toBeHidden()
    await expect(panel.getByTestId(`product-${located.id}`)).toHaveCount(0)
    await expect(panel.getByTestId(`product-${unassigned.id}`)).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    expect((await page.goto(`${catalog}/menu/${target.id}?location_id=loc-demo&kind=dish`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await expect(panel.getByTestId(`product-${located.id}`)).toBeVisible()
    await expect(panel.getByTestId('editor-card-name')).toContainText(target.name)

    // The dish's plural membership editor uses the same section operation;
    // removing one membership retains its other section and location offering.
    await page.setViewportSize({ width: 1440, height: 900 })
    await panel.getByTestId(`product-${located.id}`).click()
    const membershipCard = page.locator('#dashboard-panel-product').getByTestId('editor-card-collections')
    await expect(membershipCard).toHaveAttribute('href', `${catalog}/${located.id}/collections?location_id=loc-demo&kind=dish`)
    await membershipCard.click()
    const memberships = page.locator('#dashboard-panel-product-collections')
    await expect(memberships.getByRole('link', { name: target.name })).toHaveAttribute('href', `${catalog}/menu/${target.id}?location_id=loc-demo&kind=dish`)

    // Entering the same dish without Menu context must not narrow the target
    // collection's chooser to dishes solely because this member is a dish.
    expect((await page.goto(`${catalog}/${located.id}/collections`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await expect(memberships.getByRole('link', { name: target.name })).toHaveAttribute('href', `${catalog}/menu/${target.id}?location_id=loc-demo`)
    await memberships.getByRole('link', { name: target.name }).click()
    await expect(page).toHaveURL(`${catalog}/menu/${target.id}?location_id=loc-demo`)
    await panel.getByRole('button', { name: 'Add item', exact: true }).click()
    const generalChooser = page.getByRole('dialog', { name: 'Add items', exact: true })
    await expect(generalChooser.getByRole('textbox', { name: 'Search items', exact: true })).toBeVisible()
    await generalChooser.getByRole('button', { name: 'Close Add items', exact: true }).click()
    expect((await page.goto(`${catalog}/${located.id}/collections`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    await memberships.getByRole('button', { name: 'Add to section', exact: true }).click()
    const addMembership = page.getByRole('dialog', { name: 'Add to section', exact: true })
    await addMembership.getByText(sharedTarget.name, { exact: true }).click()
    await expect(addMembership.getByRole('radio', { name: `${sharedTarget.name} Shared by every location`, exact: true })).toBeChecked()
    const membershipAdded = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${sharedTarget.id}/products` && response.request().method() === 'PUT')
    await addMembership.getByRole('button', { name: 'Add', exact: true }).click()
    const membershipAddedResponse = await membershipAdded
    expect(membershipAddedResponse.status(), await membershipAddedResponse.text()).toBe(200)
    expect(membershipAddedResponse.request().postDataJSON()).toEqual({ product_ids: [located.id], expected_product_ids: [] })
    const multipleRead = await page.request.get(`${editor}/products/${located.id}`)
    expect(multipleRead.status(), await multipleRead.text()).toBe(200)
    const multiple = (await multipleRead.json() as { product: Product }).product
    expect(multiple.collections.map(membership => membership.collection_id).sort()).toEqual([sharedTarget.id, target.id].sort())
    expect(multiple.locations).toEqual([{ location_id: 'loc-demo', active: true, published: false }])
    await expect(addMembership).toBeHidden()
    const membershipRemoved = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/collections/${sharedTarget.id}/products` && response.request().method() === 'PUT')
    await memberships.getByRole('button', { name: `Remove from ${sharedTarget.name}`, exact: true }).click()
    const membershipRemovedResponse = await membershipRemoved
    expect(membershipRemovedResponse.status(), await membershipRemovedResponse.text()).toBe(200)
    expect(membershipRemovedResponse.request().postDataJSON()).toEqual({ product_ids: [], expected_product_ids: [located.id] })
    const singleRead = await page.request.get(`${editor}/products/${located.id}`)
    expect(singleRead.status(), await singleRead.text()).toBe(200)
    const single = (await singleRead.json() as { product: Product }).product
    expect(single.collections).toEqual([{ collection_id: target.id, sort_order: 0 }])
    expect(single.locations).toEqual(multiple.locations)
    expect(await readMemberships()).toEqual([[{ id: unassigned.id, order: 0 }], [{ id: located.id, order: 0 }]])

    // An unscoped View requires the owner to choose a saved location, even
    // when this dish is assigned to only one. The preview reads saved content.
    const view = page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true })
    await expect(view).toHaveAttribute('href', `${catalog}/${located.id}/collections?editMode=preview&previewViewport=desktop`)
    await view.click()
    const preview = page.getByRole('dialog', { name: 'Dish preview', exact: true })
    await expect(preview.getByRole('heading', { name: 'Choose a location to preview', exact: true })).toBeVisible()
    await expect(preview.locator('iframe')).toHaveCount(0)
    const locationChoice = preview.getByRole('link', { name: location!.title })
    await expect(preview.getByRole('link')).toHaveCount(1)
    await locationChoice.click()
    await expect(page).toHaveURL(`${catalog}/${located.id}/collections?editMode=preview&previewViewport=desktop&preview_location_id=${location!.id}`)
    const previewURL = new URL(page.url())
    expect(previewURL.pathname).toBe(`${catalog}/${located.id}/collections`)
    expect(Object.fromEntries(previewURL.searchParams)).toEqual({ editMode: 'preview', previewViewport: 'desktop', preview_location_id: location!.id })
    const iframe = preview.locator('iframe[title="Dish preview"]')
    await expect(iframe).toBeVisible()
    const savedPreviewURL = new URL((await iframe.getAttribute('src'))!)
    expect(savedPreviewURL.pathname).toBe(`/locations/${location!.slug}/menu/${located.slug}`)
    expect(savedPreviewURL.searchParams.get('preview_token')).toBeTruthy()
    const guest = page.frameLocator('iframe[title="Dish preview"]')
    await expect(guest.getByRole('heading', { name: located.name, level: 1, exact: true })).toBeVisible()
    await preview.getByRole('tab', { name: 'Mobile view', exact: true }).click()
    await expect(page).toHaveURL(`${catalog}/${located.id}/collections?editMode=preview&previewViewport=mobile&preview_location_id=${location!.id}`)
    await expect(preview.getByRole('tab', { name: 'Mobile view', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(new URL(page.url()).searchParams.get('previewViewport')).toBe('mobile')
    await expect(iframe).toHaveCSS('max-width', '390px')
    await expect(guest.getByRole('heading', { name: located.name, level: 1, exact: true })).toBeVisible()
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(preview).toBeHidden()
    await expect(page).toHaveURL(`${catalog}/${located.id}/collections`)
    await expect(view).toBeFocused()
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
