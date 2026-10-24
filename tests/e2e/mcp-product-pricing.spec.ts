import { expect, request as playwrightRequest, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { MCP_ORGANIZATION_ID, mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { Collection, Product } from '../../server/types/products'

// The large-batch spec asserts the demo tenant's whole catalogue under this
// lock, so every test that adds a Product to it takes the same lock.
let releaseTenantMutationLock: (() => Promise<void>) | undefined
test.beforeEach(async ({ request: _request }, testInfo) => {
  releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, MCP_ORGANIZATION_ID)
})
test.afterEach(async () => {
  await releaseTenantMutationLock?.()
})

/**
 * What a customer buys is a variant, and a price belongs to a variant.
 *
 * This is the transport-level proof of that: the deployed MCP surface takes
 * prices nested under variants, refuses a Product whose variant carries no
 * price it can quote, and never invents an amount to stand in for one.
 */
test('deployed MCP transport prices variants, and refuses to invent a missing amount', async ({ request, baseURL, browser }, testInfo) => {

  await loginAs(request, baseURL!)
  const toolsResponse = await mcpRequest(request, baseURL!, { method: 'tools/list' })
  expect(await toolsResponse.json()).toMatchObject({
    result: {
      tools: expect.arrayContaining([expect.objectContaining({
        name: 'create_product',
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({ variants: expect.any(Object) }),
        }),
      })]),
    },
  })
  const organizationId = MCP_ORGANIZATION_ID
  const locationId = 'loc-demo'
  const runId = randomUUID()
  const smallSku = `MCP-SALMON-6-${runId}`
  const largeSku = `MCP-SALMON-12-${runId}`

  // An owner can begin an experience before its booking facts are known.
  // The independent editor read must show a private draft with no invented setup.
  const experienceName = `MCP Sushi Workshop Draft ${runId}`
  const cleanupRequest = await playwrightRequest.newContext({ baseURL, storageState: await request.storageState() })
  let draftId: string | undefined
  try {
    const createDraft = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'create_product',
      args: { organization_id: organizationId, kind: 'experience', name: experienceName, idempotency_key: `pricing-experience-draft-${runId}` },
    })
    expect(createDraft.status()).toBe(200)
    const draft = mcpData<{ product: Product & { admin_edit_url: string | null } }>(await createDraft.json()).product
    draftId = draft.id
    const draftPath = `${baseURL}/api/editor/organizations/${organizationId}/products/${draftId}`
    const draftRead = await request.get(draftPath)
    expect(draftRead.status()).toBe(200)
    const savedDraft = await draftRead.json() as { product: Product; public_url: string | null }
    expect(savedDraft.product).toMatchObject({ id: draftId, name: experienceName, kind: 'experience', booking: null, stay: null, order_url: null })
    expect(savedDraft.product.publications).toEqual([{ organization_id: organizationId, published: false }])
    expect(savedDraft.product.variants).toHaveLength(1)
    expect(savedDraft.product.variants[0]!.prices).toEqual([])
    expect(savedDraft.public_url).toBeNull()
    expect(savedDraft.product.collections).toEqual([])

    // An omitted empty card must retain an entrance for the first membership.
    // Use an existing collection and preserve its complete saved membership.
    const collectionsRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/collections`)
    expect(collectionsRead.status()).toBe(200)
    const collection = (await collectionsRead.json() as { collections: Collection[] }).collections.find(collection => collection.location_id === null)
    expect(collection).toBeDefined()
    const catalogRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products`)
    expect(catalogRead.status()).toBe(200)
    const catalog = (await catalogRead.json() as { products: Product[] }).products
    const members = catalog.flatMap(product => product.collections.filter(membership => membership.collection_id === collection!.id).map(membership => ({ id: product.id, order: membership.sort_order }))).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)).map(product => product.id)
    expect(draft.admin_edit_url).toMatch(/^\/dashboard\//)
    const draftContext = await browser.newContext({ storageState: await request.storageState() })
    try {
      const page = await draftContext.newPage()
      await page.setViewportSize({ width: 1440, height: 900 })
      expect((await page.goto(`${baseURL}${draft.admin_edit_url}`))?.status()).toBe(200)
      await waitForNuxtHydration(page)
      const editor = page.locator('#dashboard-panel-product')
      await expect(editor.getByTestId('editor-card-collections')).toHaveCount(0)
      await editor.getByRole('button', { name: 'Add detail', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Collections', exact: true }).click()
      const memberships = page.locator('#dashboard-panel-product-collections')
      await expect(memberships.getByText('Not in a collection.', { exact: true })).toBeVisible()
      await memberships.getByRole('button', { name: 'Add to collection', exact: true }).click()
      const chooser = page.getByRole('dialog', { name: 'Add to collection', exact: true })
      await chooser.getByText(collection!.name, { exact: true }).click()
      const added = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/collections/${collection!.id}/products`)
      await chooser.getByRole('button', { name: 'Add', exact: true }).click()
      const addedResponse = await added
      expect(addedResponse.status(), await addedResponse.text()).toBe(200)
      expect(addedResponse.request().postDataJSON()).toEqual({ product_ids: [...members, draftId], expected_product_ids: members })
      await expect(chooser).toBeHidden()
      await expect(editor.getByTestId('editor-card-collections')).toContainText(collection!.name)
      const savedMembership = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'get_product', args: { organization_id: organizationId, product_id: draftId },
      })
      expect(savedMembership.status()).toBe(200)
      expect(mcpData<{ product: Product }>(await savedMembership.json()).product.collections).toEqual([{ collection_id: collection!.id, sort_order: members.length }])
      const retainedRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products`)
      expect(retainedRead.status()).toBe(200)
      const retained = (await retainedRead.json() as { products: Product[] }).products
      expect(retained.flatMap(product => product.collections.filter(membership => membership.collection_id === collection!.id).map(membership => ({ id: product.id, order: membership.sort_order }))).sort((left, right) => left.order - right.order).map(product => product.id)).toEqual([...members, draftId])
    } finally {
      await draftContext.close()
    }
  } finally {
    try {
      if (draftId) {
        const deleteDraft = await mcpRequest(cleanupRequest, baseURL!, {
          method: 'tools/call', toolName: 'delete_product', args: { organization_id: organizationId, product_id: draftId },
        })
        expect(deleteDraft.status()).toBe(200)
        expect(mcpData<{ deleted: boolean }>(await deleteDraft.json()).deleted).toBe(true)
        const deletedDraft = await cleanupRequest.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${draftId}`)
        expect(deletedDraft.status()).toBe(404)
      }
    } finally {
      await cleanupRequest.dispose()
    }
  }

  const create = await mcpRequest(request, baseURL!, {
    method: 'tools/call',
    toolName: 'create_product',
    args: { kind: 'dish',
      organization_id: organizationId,
      idempotency_key: `pricing-salmon-${runId}`,
      name: `MCP Pricing Salmon Roll ${runId}`,
      description: 'Fresh salmon with rice', unit_label: 'portion', metadata: { kitchen: 'sushi' },
      variants: [
        { name: 'Six pieces', sku: smallSku, prices: [{ unit_amount: 500, currency: 'USD', tax_behavior: 'inclusive' }, { unit_amount: 400, currency: 'GBP' }] },
        { name: 'Twelve pieces', sku: largeSku, sort_order: 4, prices: [{ unit_amount: 900, currency: 'USD' }] },
      ],
    },
  })
  expect(create.status()).toBe(200)
  const created = mcpData<{ product: Product }>(await create.json()).product
  expect(created.options).toEqual([])
  expect(created.variants.map(variant => variant.name).sort()).toEqual(['Six pieces', 'Twelve pieces'].sort())
  expect(created.variants.map(variant => variant.sku).sort()).toEqual([smallSku, largeSku].sort())
  expect(created.variants.flatMap(variant => variant.prices).map(price => price.unit_amount).sort()).toEqual([400, 500, 900])

  const beforeResponse = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
  expect(beforeResponse.status()).toBe(200)
  let before = (await beforeResponse.json() as { product: Product }).product
  expect(before.id).toBe(created.id)
  // Dishes have prices and options, but no booking editor at either depth.
  // Dashboard documents serve the app shell; its route guard shows the refusal.
  const organizationsRead = await request.get(`${baseURL}/api/organizations`)
  expect(organizationsRead.status()).toBe(200)
  const { organizations } = await organizationsRead.json() as { organizations: Array<{ id: string; slug: string }> }
  const dashboardOrganization = organizations.find(organization => organization.id === organizationId)
  expect(dashboardOrganization?.slug, 'The targeted organization has its saved dashboard slug').toMatch(/\S/)
  const bookingContext = await browser.newContext({ storageState: await request.storageState() })
  try {
    const bookingPage = await bookingContext.newPage()
    await bookingPage.setViewportSize({ width: 1440, height: 900 })
    const productPath = `/dashboard/${encodeURIComponent(dashboardOrganization!.slug)}/products/${created.id}`
    const editorPath = `/api/editor/organizations/${organizationId}/products/${created.id}`
    await bookingPage.goto(`${baseURL}${productPath}/price`)
    const pricing = bookingPage.locator('#dashboard-panel-product-pricing')
    await expect(pricing.getByRole('link', { name: 'Six pieces', exact: false })).toBeVisible()
    await expect(pricing.getByRole('link', { name: 'Twelve pieces', exact: false })).toBeVisible()

    // Opening a blank choice cannot collapse named versions or write anything.
    await pricing.getByRole('button', { name: 'Add a choice', exact: true }).click()
    const choice = bookingPage.locator('#dashboard-panel-product-option')
    await expect(choice.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('')
    await expect(choice.getByRole('combobox', { name: 'Six pieces', exact: true })).toBeVisible()
    await expect(choice.getByRole('combobox', { name: 'Twelve pieces', exact: true })).toBeVisible()
    await choice.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(bookingPage).toHaveURL(`${baseURL}${productPath}/price`)
    const cancelled = await request.get(`${baseURL}${editorPath}`)
    expect(cancelled.status()).toBe(200)
    expect((await cancelled.json() as { product: Product }).product).toEqual(before)

    // Values differ from the saved names: the host must map them explicitly.
    await pricing.getByRole('button', { name: 'Add a choice', exact: true }).click()
    await choice.getByRole('textbox', { name: 'Name', exact: true }).fill('Portion')
    const values = choice.getByRole('textbox', { name: 'Choices', exact: true })
    await values.fill('Small portion')
    await values.press('Enter')
    await values.fill('Large portion')
    await values.press('Enter')
    await expect(choice.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await choice.getByRole('combobox', { name: 'Six pieces', exact: true }).click()
    await bookingPage.getByRole('option', { name: 'Small portion', exact: true }).click()
    await choice.getByRole('combobox', { name: 'Twelve pieces', exact: true }).click()
    await bookingPage.getByRole('option', { name: 'Small portion', exact: true }).click()
    await expect(choice.getByText('Choose a different combination for each priced choice.', { exact: true })).toBeVisible()
    await expect(choice.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await choice.getByRole('combobox', { name: 'Twelve pieces', exact: true }).click()
    await bookingPage.getByRole('option', { name: 'Large portion', exact: true }).click()
    const mapWrite = bookingPage.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === editorPath)
    await choice.getByRole('button', { name: 'Save', exact: true }).click()
    const mappedResponse = await mapWrite
    expect(mappedResponse.status(), await mappedResponse.text()).toBe(200)
    await expect(bookingPage).toHaveURL(`${baseURL}${productPath}/price`)
    const mappedRead = await request.get(`${baseURL}${editorPath}`)
    expect(mappedRead.status()).toBe(200)
    const mapped = (await mappedRead.json() as { product: Product }).product
    expect(mapped.options).toHaveLength(1)
    const portion = mapped.options[0]!
    expect(portion.name).toBe('Portion')
    expect(portion.values.map(value => value.value)).toEqual(['Small portion', 'Large portion'])
    for (const previous of before.variants) {
      const saved = mapped.variants.find(variant => variant.id === previous.id)!
      const selected = portion.values.find(value => value.value === (previous.name === 'Six pieces' ? 'Small portion' : 'Large portion'))!
      expect(saved.option_values).toEqual({ [portion.id]: selected.id })
      expect({ ...saved, option_values: previous.option_values }).toEqual(previous)
    }
    expect({ ...mapped, options: before.options, variants: before.variants, updated_at: before.updated_at, updated_by: before.updated_by }).toEqual(before)
    before = mapped
    await bookingPage.screenshot({ path: testInfo.outputPath('shared-pricing-desktop.png'), fullPage: true, animations: 'disabled' })
    await bookingPage.setViewportSize({ width: 390, height: 844 })
    await expect(pricing.getByRole('link', { name: 'Six pieces', exact: false })).toBeVisible()
    await bookingPage.screenshot({ path: testInfo.outputPath('shared-pricing-mobile.png'), fullPage: true, animations: 'disabled' })
    await bookingPage.setViewportSize({ width: 1440, height: 900 })

    // A pending new dimension belongs to the shared pricing draft. Opening an
    // existing choice and changing its values cannot rebuild away saved IDs.
    await pricing.getByRole('button', { name: 'Add a choice', exact: true }).click()
    await choice.getByRole('textbox', { name: 'Name', exact: true }).fill('Color')
    await values.fill('Red')
    await values.press('Enter')
    await values.fill('Blue')
    await values.press('Enter')
    await pricing.getByTestId(`editor-row-option-${portion.id}`).click()
    await expect(choice.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Portion')
    await choice.getByRole('button', { name: 'Small portion', exact: true }).click()
    await values.fill('Small portion')
    await values.press('Enter')
    await expect(pricing.getByRole('link', { name: 'Six pieces', exact: false })).toHaveAttribute('href', `${productPath}/price/amounts/${before.variants.find(variant => variant.name === 'Six pieces')!.id}`)
    await expect(pricing.getByRole('link', { name: 'Six pieces', exact: false })).toContainText('5.00 USD')
    await expect(pricing.getByRole('link', { name: 'Twelve pieces', exact: false })).toHaveAttribute('href', `${productPath}/price/amounts/${before.variants.find(variant => variant.name === 'Twelve pieces')!.id}`)
    await expect(pricing.getByRole('link', { name: 'Twelve pieces', exact: false })).toContainText('9.00 USD')
    await expect(choice.getByText('Set Portion and Color for each saved priced choice before saving.', { exact: true })).toBeVisible()
    await expect(choice.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const pendingDimension = await request.get(`${baseURL}${editorPath}`)
    expect(pendingDimension.status()).toBe(200)
    expect((await pendingDimension.json() as { product: Product }).product).toEqual(before)
    for (const [name, selection] of [['Six pieces', 'Small portion'], ['Twelve pieces', 'Large portion']] as const) {
      await choice.getByRole('combobox', { name, exact: true }).click()
      await bookingPage.getByRole('option', { name: selection, exact: true }).click()
    }
    await pricing.getByRole('link', { name: 'Color', exact: false }).click()
    await expect(choice.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Color')
    for (const [name, selection] of [['Six pieces', 'Red'], ['Twelve pieces', 'Blue']] as const) {
      await choice.getByRole('combobox', { name, exact: true }).click()
      await bookingPage.getByRole('option', { name: selection, exact: true }).click()
    }
    const colorWrite = bookingPage.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === editorPath)
    await choice.getByRole('button', { name: 'Save', exact: true }).click()
    const colorResponse = await colorWrite
    expect(colorResponse.status(), await colorResponse.text()).toBe(200)
    await expect(bookingPage).toHaveURL(`${baseURL}${productPath}/price`)
    const matrixRead = await request.get(`${baseURL}${editorPath}`)
    expect(matrixRead.status()).toBe(200)
    const matrix = (await matrixRead.json() as { product: Product }).product
    expect(matrix.variants).toHaveLength(4)
    expect(matrix.options.map(option => option.name)).toEqual(['Portion', 'Color'])
    const matrixPortion = matrix.options.find(option => option.name === 'Portion')!
    const matrixColor = matrix.options.find(option => option.name === 'Color')!
    expect(matrixPortion.id).toBe(portion.id)
    for (const [name, portionValue, colorValue] of [['Six pieces', 'Small portion', 'Red'], ['Twelve pieces', 'Large portion', 'Blue']] as const) {
      const previous = before.variants.find(variant => variant.name === name)!
      const saved = matrix.variants.find(variant => variant.id === previous.id)!
      expect(saved).toEqual({
        ...previous,
        option_values: {
          [matrixPortion.id]: matrixPortion.values.find(value => value.value === portionValue)!.id,
          [matrixColor.id]: matrixColor.values.find(value => value.value === colorValue)!.id,
        },
      })
    }
    expect(matrix.variants.filter(variant => !before.variants.some(previous => previous.id === variant.id)).map(variant => ({ name: variant.name, prices: variant.prices }))).toEqual([
      { name: 'Large portion / Red', prices: [] }, { name: 'Small portion / Blue', prices: [] },
    ])
    expect({ ...matrix, options: before.options, variants: before.variants, updated_at: before.updated_at, updated_by: before.updated_by }).toEqual(before)
    before = matrix

    // Clearing an existing dimension must retain all four saved identities.
    // Editing the remaining one cannot collapse rows onto duplicate keys.
    await pricing.getByRole('link', { name: 'Color', exact: false }).click()
    await expect(choice.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Color')
    await choice.getByRole('button', { name: 'Red', exact: true }).click()
    await choice.getByRole('button', { name: 'Blue', exact: true }).click()
    await pricing.getByTestId(`editor-row-option-${portion.id}`).click()
    await expect(choice.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Portion')
    await choice.getByRole('button', { name: 'Large portion', exact: true }).click()
    await values.fill('Large portion')
    await values.press('Enter')
    for (const variant of before.variants) {
      const row = pricing.getByRole('link', { name: variant.name, exact: false })
      await expect(row).toHaveAttribute('href', `${productPath}/price/amounts/${variant.id}`)
      if (variant.name === 'Six pieces') await expect(row).toContainText('5.00 USD')
      if (variant.name === 'Twelve pieces') await expect(row).toContainText('9.00 USD')
    }
    await expect(choice.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const unchangedMatrix = await request.get(`${baseURL}${editorPath}`)
    expect(unchangedMatrix.status()).toBe(200)
    expect((await unchangedMatrix.json() as { product: Product }).product).toEqual(before)
    for (const variant of before.variants) {
      const selection = matrixPortion.values.find(value => value.id === variant.option_values[matrixPortion.id])!.value
      await choice.getByRole('combobox', { name: variant.name, exact: true }).click()
      await bookingPage.getByRole('option', { name: selection, exact: true }).click()
    }
    await pricing.getByRole('link', { name: 'Color', exact: false }).click()
    await expect(bookingPage).toHaveURL(`${baseURL}${productPath}/price/choices/${matrixColor.id}`)
    await expect(choice.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Color')
    await values.fill('Red')
    await values.press('Enter')
    await values.fill('Blue')
    await values.press('Enter')
    for (const variant of before.variants) {
      const selection = matrixColor.values.find(value => value.id === variant.option_values[matrixColor.id])!.value
      await choice.getByRole('combobox', { name: variant.name, exact: true }).click()
      await bookingPage.getByRole('option', { name: selection, exact: true }).click()
    }
    const remapWrite = bookingPage.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === editorPath)
    await choice.getByRole('button', { name: 'Save', exact: true }).click()
    const remapResponse = await remapWrite
    expect(remapResponse.status(), await remapResponse.text()).toBe(200)
    await expect(bookingPage).toHaveURL(`${baseURL}${productPath}/price`)
    const remapRead = await request.get(`${baseURL}${editorPath}`)
    expect(remapRead.status()).toBe(200)
    const remapped = (await remapRead.json() as { product: Product }).product
    expect(remapped.variants).toHaveLength(4)
    for (const previous of before.variants) {
      const saved = remapped.variants.find(variant => variant.id === previous.id)!
      expect({ ...saved, option_values: previous.option_values }).toEqual(previous)
      for (const previousOption of before.options) {
        const savedOption = remapped.options.find(option => option.id === previousOption.id)!
        expect(savedOption.values.find(value => value.id === saved.option_values[savedOption.id])!.value)
          .toBe(previousOption.values.find(value => value.id === previous.option_values[previousOption.id])!.value)
      }
    }
    expect({ ...remapped, options: before.options, variants: before.variants, updated_at: before.updated_at, updated_by: before.updated_by }).toEqual(before)
    before = remapped

    // The same price leaf edits one offer after choices are mapped, preserving
    // the sibling, other currency and every stored term of the changed offer.
    const six = before.variants.find(variant => variant.name === 'Six pieces')!
    const originalPrice = six.prices.find(price => price.currency === 'USD')!
    await pricing.getByRole('link', { name: 'Six pieces', exact: false }).click()
    await expect(bookingPage).toHaveURL(`${baseURL}${productPath}/price/amounts/${six.id}`)
    const amount = bookingPage.locator('#dashboard-panel-product-combination-price')
    await expect(amount.getByTestId('product-price')).toHaveValue('5.00')
    await amount.getByTestId('product-price').fill('5.25')
    const priceWrite = bookingPage.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === editorPath)
    await amount.getByRole('button', { name: 'Save', exact: true }).click()
    const pricedResponse = await priceWrite
    expect(pricedResponse.status(), await pricedResponse.text()).toBe(200)
    await expect(bookingPage).toHaveURL(`${baseURL}${productPath}/price`)
    const pricedRead = await request.get(`${baseURL}${editorPath}`)
    expect(pricedRead.status()).toBe(200)
    const priced = (await pricedRead.json() as { product: Product }).product
    const savedSix = priced.variants.find(variant => variant.id === six.id)!
    const savedPrice = savedSix.prices.find(price => price.id === originalPrice.id)!
    expect(savedPrice.unit_amount).toBe(525)
    expect({ ...savedPrice, unit_amount: originalPrice.unit_amount, updated_at: originalPrice.updated_at, updated_by: originalPrice.updated_by }).toEqual(originalPrice)
    expect({ ...savedSix, prices: six.prices }).toEqual(six)
    expect(savedSix.prices.find(price => price.currency === 'GBP')).toEqual(six.prices.find(price => price.currency === 'GBP'))
    expect(priced.variants).toHaveLength(4)
    expect(priced.variants.filter(variant => variant.id !== six.id)).toEqual(before.variants.filter(variant => variant.id !== six.id))
    expect({ ...priced, variants: before.variants, updated_at: before.updated_at, updated_by: before.updated_by }).toEqual(before)
    before = priced

    for (const section of ['booking', 'booking/enabled']) {
      await bookingPage.goto(`${baseURL}/dashboard/${encodeURIComponent(dashboardOrganization!.slug)}/products/${created.id}/${section}`)
      await expect(bookingPage.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
    }
  } finally {
    await bookingContext.close()
  }

  // The ChatGPT-style price edit names only the variant, price and new amount.
  // Read the persisted outcome through the dashboard API, which does not use
  // the MCP result that performed the write.
  // Compare the same independent projection before and after; dashboard prices
  // include audit fields the public MCP result intentionally does not expose.
  const small = before.variants.find(variant => variant.name === 'Six pieces')!
  const smallPrice = small.prices.find(price => price.currency === 'USD')!
  const edit = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'update_product',
    args: { organization_id: organizationId, product_id: created.id, variants: [{ id: small.id, prices: [{ id: smallPrice.id, unit_amount: 550 }] }] },
  })
  expect(edit.status()).toBe(200)
  expect(mcpData<{ product: Product }>(await edit.json()).product.id).toBe(created.id)
  const readback = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
  expect(readback.status()).toBe(200)
  const edited = (await readback.json() as { product: Product }).product
  expect(edited.variants).toHaveLength(4)
  expect(edited.options).toEqual(before.options)
  expect([edited.description, edited.unit_label, edited.metadata]).toEqual([before.description, before.unit_label, before.metadata])
  expect(edited.variants.filter(variant => variant.id !== small.id)).toEqual(before.variants.filter(variant => variant.id !== small.id))
  const editedSmall = edited.variants.find(variant => variant.id === small.id)!
  expect({ ...editedSmall, prices: small.prices }).toEqual(small)
  expect(editedSmall.prices.find(price => price.currency === 'GBP')).toEqual(small.prices.find(price => price.currency === 'GBP'))
  const changedPrice = editedSmall.prices.find(price => price.id === smallPrice.id)!
  expect(changedPrice.unit_amount).toBe(550)
  expect({ ...changedPrice, unit_amount: smallPrice.unit_amount, updated_at: smallPrice.updated_at, updated_by: smallPrice.updated_by }).toEqual(smallPrice)

  // Publication and location membership are separate states, and a read must
  // report both rather than implying one from the other.
  for (const [toolName, args] of [
    ['set_product_publication', { organization_id: organizationId, product_id: created.id, published: true }],
    ['set_product_location', { organization_id: organizationId, product_id: created.id, location_id: locationId }],
  ] as const) {
    const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName, args })
    expect(response.status(), await response.text()).toBe(200)
    const result = mcpData<Record<string, unknown>>(await response.json())
    expect(result).toEqual(toolName === 'set_product_publication'
      ? { product_id: created.id, organization_id: organizationId, published: true }
      : { product_id: created.id, location_id: locationId, active: true, published: true })
  }
  const savedPublication = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
  expect(savedPublication.status()).toBe(200)
  const offeredProduct = (await savedPublication.json()).product
  expect(offeredProduct.publications).toContainEqual(expect.objectContaining({ organization_id: organizationId, published: true }))
  expect(offeredProduct.locations).toContainEqual(expect.objectContaining({ location_id: locationId, active: true, published: true }))
  const withholdAtLocation = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'set_product_location', args: {
    organization_id: organizationId, product_id: created.id, location_id: locationId, published: false,
  } })
  expect(withholdAtLocation.status()).toBe(200)
  expect(mcpData(await withholdAtLocation.json())).toEqual({ product_id: created.id, location_id: locationId, active: true, published: false })
  const retainLocation = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'set_product_location', args: {
    organization_id: organizationId, product_id: created.id, location_id: locationId,
  } })
  expect(retainLocation.status()).toBe(200)
  expect(mcpData(await retainLocation.json())).toEqual({ product_id: created.id, location_id: locationId, active: true, published: false })
  const retainedRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
  expect(retainedRead.status()).toBe(200)
  expect((await retainedRead.json()).product.locations).toContainEqual(expect.objectContaining({ location_id: locationId, active: true, published: false }))
  const restoreLocation = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'set_product_location', args: {
    organization_id: organizationId, product_id: created.id, location_id: locationId, published: true,
  } })
  expect(restoreLocation.status()).toBe(200)
  expect(mcpData(await restoreLocation.json())).toEqual({ product_id: created.id, location_id: locationId, active: true, published: true })

  // A location offering and its price have independent lifetimes. Stopping
  // the offering retains its price, without leaving a broken scoped editor.
  const scopedPriceWrite = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'update_product',
    args: { organization_id: organizationId, product_id: created.id, variants: [{ id: small.id, prices: [{ location_id: locationId, unit_amount: 625, currency: 'USD' }] }] },
  })
  expect(scopedPriceWrite.status()).toBe(200)
  expect(mcpData<{ product: Product }>(await scopedPriceWrite.json()).product.id).toBe(created.id)
  const scopedPriceRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
  expect(scopedPriceRead.status()).toBe(200)
  const scopedProduct = (await scopedPriceRead.json() as { product: Product }).product
  const scopedPrice = scopedProduct.variants.find(variant => variant.id === small.id)!.prices.find(price => price.location_id === locationId)!
  expect(scopedPrice).toMatchObject({ location_id: locationId, unit_amount: 625, currency: 'USD' })
  const priceContext = await browser.newContext({ storageState: await request.storageState() })
  try {
    const pricePage = await priceContext.newPage()
    await pricePage.setViewportSize({ width: 1440, height: 900 })
    const productPath = `/dashboard/${encodeURIComponent(dashboardOrganization!.slug)}/products/${created.id}`
    expect((await pricePage.goto(`${baseURL}${productPath}/price`))?.status()).toBe(200)
    const pricing = pricePage.locator('#dashboard-panel-product-pricing')
    await pricing.getByTestId(`editor-row-location-${locationId}`).click()
    await expect(pricePage).toHaveURL(`${baseURL}${productPath}/price?location_id=${locationId}`)
    await pricing.getByTestId(`editor-row-price-${small.id}`).click()
    await expect(pricePage.locator('#dashboard-panel-product-combination-price').getByTestId('product-price')).toHaveValue('6.25')
    const removed = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'remove_product_location',
      args: { organization_id: organizationId, product_id: created.id, location_id: locationId },
    })
    expect(removed.status()).toBe(200)
    expect(mcpData(await removed.json())).toEqual({ product_id: created.id, location_id: locationId, removed: true })
    const retainedRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
    expect(retainedRead.status()).toBe(200)
    const retained = (await retainedRead.json() as { product: Product }).product
    expect(retained.locations).toEqual([])
    expect({ ...retained, locations: scopedProduct.locations }).toEqual(scopedProduct)
    const retainedMcp = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'get_product', args: { organization_id: organizationId, product_id: created.id },
    })
    expect(retainedMcp.status()).toBe(200)
    expect(mcpData<{ product: Product }>(await retainedMcp.json()).product.variants.find(variant => variant.id === small.id)!.prices)
      .toContainEqual(expect.objectContaining({ id: scopedPrice.id, location_id: locationId, unit_amount: 625, currency: 'USD' }))
    expect((await pricePage.goto(`${baseURL}${productPath}/price`))?.status()).toBe(200)
    await expect(pricing.locator('[data-testid^="editor-row-location-"]')).toHaveCount(0)
    const sharedPriceRow = pricing.getByTestId(`editor-row-price-${small.id}`)
    await expect(sharedPriceRow).toHaveAttribute('href', `${productPath}/price/amounts/${small.id}`)
    await expect(sharedPriceRow).toContainText('5.50 USD')
  } finally { await priceContext.close() }

  // A Product whose variant has no price is created, and is simply not
  // purchasable: nothing substitutes zero or a note for the amount.
  const unpriced = await mcpRequest(request, baseURL!, {
    method: 'tools/call',
    toolName: 'create_product',
    args: { kind: 'dish', organization_id: organizationId, idempotency_key: `pricing-unpriced-${runId}`, name: `MCP Pricing Chef's Choice ${runId}`, variants: [{ name: 'Standard' }] },
  })
  expect(unpriced.status()).toBe(200)
  const unpricedProduct = mcpData<{ product: Product }>(await unpriced.json()).product
  expect(unpricedProduct.variants).toHaveLength(1)
  expect(unpricedProduct.variants[0]!.prices).toEqual([])

  // Two simultaneously valid prices of the same scope are refused at write
  // time, so nobody has to pick one at checkout.
  const ambiguous = await mcpRequest(request, baseURL!, {
    method: 'tools/call',
    toolName: 'create_product',
    args: { kind: 'dish',
      organization_id: organizationId,
      idempotency_key: `pricing-ambiguous-${runId}`,
      name: `MCP Pricing Ambiguous Roll ${runId}`,
      variants: [{ name: 'Standard', prices: [
        { unit_amount: 500, currency: 'USD' },
        { unit_amount: 600, currency: 'USD' },
      ] }],
    },
  })
  // The refusal itself, not a word in the response: the product is called
  // "Ambiguous Roll", so a pattern matching "ambiguous" passed on the tool
  // echoing the name back after a successful create.
  const ambiguousBody = await ambiguous.json() as { result?: { isError?: unknown; content?: Array<{ text?: string }> } }
  expect(ambiguousBody.result?.isError, JSON.stringify(ambiguousBody)).toBe(true)
  expect(ambiguousBody.result?.content?.map(part => part.text).join(' ')).toMatch(/price/i)

  const invalidDetails = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'update_product',
    args: { organization_id: organizationId, product_id: created.id, details: { meeting_point: 'Meet at the counter' } },
  })
  const invalidDetailsBody = await invalidDetails.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
  expect(invalidDetailsBody.result?.isError, JSON.stringify(invalidDetailsBody)).toBe(true)
  expect(invalidDetailsBody.result?.content?.map(part => part.text).join(' ')).toMatch(/meeting_point.*dish/)
  const unchanged = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
  expect(unchanged.status()).toBe(200)
  expect((await unchanged.json() as { product: Product }).product.details).toEqual(edited.details)

  const beforeRemovalResponse = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: {
    organization_id: organizationId, product_id: created.id,
  } })
  expect(beforeRemovalResponse.status()).toBe(200)
  const beforeRemoval = mcpData<{ product: Product }>(await beforeRemovalResponse.json()).product
  expect(beforeRemoval.locations).toContainEqual(expect.objectContaining({ location_id: locationId, active: true, published: true }))
  const removal = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'remove_product_location', args: {
    organization_id: organizationId, product_id: created.id, location_id: locationId,
  } })
  expect(removal.status()).toBe(200)
  expect(mcpData(await removal.json())).toEqual({ product_id: created.id, location_id: locationId, removed: true })
  const afterRemovalResponse = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: {
    organization_id: organizationId, product_id: created.id,
  } })
  expect(afterRemovalResponse.status()).toBe(200)
  const afterRemoval = mcpData<{ product: Product }>(await afterRemovalResponse.json()).product
  expect(afterRemoval).toEqual({ ...beforeRemoval, locations: beforeRemoval.locations.filter(location => location.location_id !== locationId) })
})
