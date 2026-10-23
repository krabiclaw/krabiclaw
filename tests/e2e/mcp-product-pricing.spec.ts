import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { loginAs } from './helpers/auth'
import { MCP_ORGANIZATION_ID, mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { Product } from '../../server/types/products'

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
test('deployed MCP transport prices variants, and refuses to invent a missing amount', async ({ request, baseURL, browser }) => {

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
  const createDraft = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'create_product',
    args: { organization_id: organizationId, kind: 'experience', name: experienceName, idempotency_key: `pricing-experience-draft-${runId}` },
  })
  expect(createDraft.status()).toBe(200)
  const draftId = mcpData<{ product: Product }>(await createDraft.json()).product.id
  const draftPath = `${baseURL}/api/editor/organizations/${organizationId}/products/${draftId}`
  try {
    const draftRead = await request.get(draftPath)
    expect(draftRead.status()).toBe(200)
    const savedDraft = await draftRead.json() as { product: Product; public_url: string | null }
    expect(savedDraft.product).toMatchObject({ id: draftId, name: experienceName, kind: 'experience', booking: null, stay: null, order_url: null })
    expect(savedDraft.product.publications).toEqual([{ organization_id: organizationId, published: false }])
    expect(savedDraft.product.variants).toHaveLength(1)
    expect(savedDraft.product.variants[0]!.prices).toEqual([])
    expect(savedDraft.public_url).toBeNull()
  } finally {
    const deleteDraft = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'delete_product', args: { organization_id: organizationId, product_id: draftId },
    })
    expect(deleteDraft.status()).toBe(200)
    expect(mcpData<{ deleted: boolean }>(await deleteDraft.json()).deleted).toBe(true)
    const deletedDraft = await request.get(draftPath)
    expect(deletedDraft.status()).toBe(404)
  }

  const create = await mcpRequest(request, baseURL!, {
    method: 'tools/call',
    toolName: 'create_product',
    args: { kind: 'dish',
      organization_id: organizationId,
      idempotency_key: `pricing-salmon-${runId}`,
      name: `MCP Pricing Salmon Roll ${runId}`,
      description: 'Fresh salmon with rice', unit_label: 'portion', metadata: { kitchen: 'sushi' },
      options: [{ name: 'Portion', values: [{ value: 'Six pieces' }, { value: 'Twelve pieces' }] }],
      variants: [
        { name: 'Six pieces', sku: smallSku, option_values: { Portion: 'Six pieces' }, prices: [{ unit_amount: 500, currency: 'USD', tax_behavior: 'inclusive' }, { unit_amount: 400, currency: 'GBP' }] },
        { name: 'Twelve pieces', sku: largeSku, sort_order: 4, option_values: { Portion: 'Twelve pieces' }, prices: [{ unit_amount: 900, currency: 'USD' }] },
      ],
    },
  })
  expect(create.status()).toBe(200)
  const created = mcpData<{ product: Product }>(await create.json()).product
  expect(created.variants.map(variant => variant.name).sort()).toEqual(['Six pieces', 'Twelve pieces'].sort())
  expect(created.variants.map(variant => variant.sku).sort()).toEqual([smallSku, largeSku].sort())
  expect(created.variants.flatMap(variant => variant.prices).map(price => price.unit_amount).sort()).toEqual([400, 500, 900])

  const beforeResponse = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`)
  expect(beforeResponse.status()).toBe(200)
  const before = (await beforeResponse.json() as { product: Product }).product
  expect(before.id).toBe(created.id)
  // Dishes have prices and options, but no booking editor at either depth.
  // Dashboard documents serve the app shell; its route guard shows the refusal.
  const bookingContext = await browser.newContext({ storageState: await request.storageState() })
  try {
    const bookingPage = await bookingContext.newPage()
    for (const section of ['booking', 'booking/enabled']) {
      await bookingPage.goto(`${baseURL}/dashboard/${organizationId}/products/${created.id}/${section}`)
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
  expect(edited.variants).toHaveLength(2)
  expect(edited.options).toEqual(before.options)
  expect([edited.description, edited.unit_label, edited.metadata]).toEqual([before.description, before.unit_label, before.metadata])
  expect(edited.variants.find(variant => variant.name === 'Twelve pieces')).toEqual(before.variants.find(variant => variant.name === 'Twelve pieces'))
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
    ['set_product_location', { organization_id: organizationId, product_id: created.id, location_id: locationId, active: true, published: true }],
  ] as const) {
    const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName, args })
    expect(response.status(), await response.text()).toBe(200)
  }

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
})
