import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { mcpOrganizationId, mcpData, mcpRequest } from './helpers/mcp'
import { seededTenant } from './seed/manifest'
import type { Product } from '../../server/types/products'

interface CreatedProduct { id: string; name: string; description: string; active: boolean }

test('Product batches validate and commit atomically for a 100-item catalog', async ({ request, baseURL }, testInfo) => {
  const organizationId = mcpOrganizationId()
  // Compare the existing catalog before and after this test's batch, so
  // nothing else may write the demo's products meanwhile.
  const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, organizationId)
  try {
    await loginAs(request, baseURL!)
    const locationId = seededTenant('restaurant').locations.brooklyn!.id

    // The demo's own catalog is part of the tenant this runs on. Its active
    // products are read first so every assertion below names exactly which
    // products an operation touched.
    const listProducts = async () => {
      const products: CreatedProduct[] = []
      let cursor: string | undefined
      do {
        const page = mcpData<{ products: CreatedProduct[]; page_info: {next_cursor: string | null} }>(await (await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'list_products', args: { organization_id: organizationId, limit: 100, ...(cursor ? { cursor } : {}) },
        })).json())
        products.push(...page.products)
        cursor = page.page_info.next_cursor ?? undefined
      } while (cursor)
      return products
    }
    const demoProducts = await listProducts()
    const demoIds = new Set(demoProducts.map(product => product.id))
    const demoActiveIds = demoProducts.filter(product => product.active).map(product => product.id).sort()
    expect(demoActiveIds.length, 'the demo tenant sells products').toBeGreaterThan(0)
    const editorUrl = `${baseURL}/api/editor/organizations/${organizationId}/products`
    const beforeEditor = await request.get(editorUrl)
    expect(beforeEditor.status(), await beforeEditor.text()).toBe(200)
    const demoDetails = (await beforeEditor.json()).products as Product[]

    const collectionIds: string[] = []
    let created: CreatedProduct[] = []
    try {
      for (const name of ['First', 'Second']) {
        const response = await mcpRequest(request, baseURL!, {
          method: 'tools/call',
          toolName: 'create_collection',
          args: { organization_id: organizationId, name },
        })
        collectionIds.push(mcpData<{ collection: { id: string } }>(await response.json()).collection.id)
      }

      const products = Array.from({ length: 100 }, (_, index) => ({ kind: 'dish',
        name: `Batch Product ${String(index + 1).padStart(3, '0')}`,
        description: `Original ${index + 1}`,
        variants: [{ name: 'Standard', prices: [{ unit_amount: (100 + index) * 100, currency: 'USD' }] }],
      }))
      // One invalid row anywhere in the batch must take the whole batch down: a
      // partial catalogue is worse than none, because nobody can tell which half
      // landed.
      const invalidProducts = products.map((product, index) => index === 99
        ? { ...product, variants: [{ name: 'Standard', prices: [{ unit_amount: (100 + index) * 100, currency: 'USD', valid_from_at: 'invalid' }] }] }
        : product)

      const invalidCreate = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'batch_create_products',
        args: { organization_id: organizationId, idempotency_key: `invalid-batch-${Date.now()}`, products: invalidProducts },
      })
      expect((await invalidCreate.json()).result?.isError).toBe(true)

      // Nothing from the refused batch landed, and the demo's catalog is untouched.
      const afterInvalid = await listProducts()
      expect(afterInvalid.filter(product => product.name.startsWith('Batch Product '))).toEqual([])
      expect(afterInvalid).toEqual(demoProducts)

      const validCreate = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'batch_create_products',
        args: { organization_id: organizationId, idempotency_key: `valid-batch-${Date.now()}`, products },
      })
      created = mcpData<{ products: CreatedProduct[] }>(await validCreate.json()).products
      expect(created).toHaveLength(100)

      const firstDishPage = mcpData<{ products: Array<{ id: string; kind: string }>; page_info: { has_more: boolean; next_cursor: string } }>(await (await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'list_products', args: { organization_id: organizationId, kind: 'dish', limit: 1 },
      })).json())
      expect(firstDishPage.products).toHaveLength(1)
      expect(firstDishPage.products[0]!.kind).toBe('dish')
      expect(firstDishPage.page_info.has_more).toBe(true)
      expect(firstDishPage.page_info.next_cursor).toBeTruthy()
      const secondDishPage = mcpData<{ products: Array<{ id: string; kind: string }> }>(await (await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'list_products', args: { organization_id: organizationId, kind: 'dish', limit: 1, cursor: firstDishPage.page_info.next_cursor },
      })).json())
      expect(secondDishPage.products).toHaveLength(1)
      expect(secondDishPage.products[0]!.kind).toBe('dish')
      expect(secondDishPage.products[0]!.id).not.toBe(firstDishPage.products[0]!.id)
      for (const [toolName, args] of [
        ['list_products', { kind: 'experience' }],
        ['list_products', { kind: 'dish', published_only: true }],
        ['list_location_products', { location_id: locationId, kind: 'dish' }],
      ] as const) {
        const wrongScope = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName,
          args: { organization_id: organizationId, ...args, limit: 1, cursor: firstDishPage.page_info.next_cursor } })
        expect((await wrongScope.json()).result.isError, 'a cursor cannot skip rows in a different catalogue filter').toBe(true)
      }
      const absentProduct = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_product',
        args: { organization_id: organizationId, product_id: crypto.randomUUID() } })
      const absentResult = (await absentProduct.json()).result
      expect(absentResult.isError).toBe(true)
      expect(absentResult.structuredContent).toBeUndefined()
      expect(JSON.parse(absentResult.content[0].text)).toMatchObject({ status: 404, message: 'Product not found' })

      // Membership is explicit and ordered, and one call sets the whole list.
      for (const [index, collectionId] of collectionIds.entries()) {
        const slice = created.slice(index * 50, index * 50 + 50).map(product => product.id)
        const response = await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'set_collection_products',
          args: { organization_id: organizationId, collection_id: collectionId, product_ids: slice },
        })
        expect(mcpData<{ products: unknown[] }>(await response.json()).products).toHaveLength(50)
      }
      const collectionStateBefore = await request.get(editorUrl)
      expect(collectionStateBefore.status()).toBe(200)
      const beforeUnprotectedMove = await collectionStateBefore.json()
      const unprotectedMove = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'set_collection_products', args: {
          organization_id: organizationId, collection_id: collectionIds[0], product_ids: [],
          move_to: { collection_id: collectionIds[1], expected_product_ids: created.slice(50).map(product => product.id) },
        },
      })
      expect(unprotectedMove.status()).toBe(200)
      expect((await unprotectedMove.json()).result.isError).toBe(true)
      const collectionStateAfter = await request.get(editorUrl)
      expect(collectionStateAfter.status()).toBe(200)
      expect(await collectionStateAfter.json()).toEqual(beforeUnprotectedMove)
      await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'set_product_location',
        args: { organization_id: organizationId, product_id: created[0]!.id, location_id: locationId, active: true, published: true },
      })

      const desired = created.map((product, index) => ({ kind: 'dish',
        product_id: product.id,
        active: index < 95,
        name: `Batch Product ${String(index + 1).padStart(3, '0')}`,
        description: index === 0 ? 'Updated atomically' : `Original ${index + 1}`,
        variants: [{ name: 'Standard', prices: [{ unit_amount: (100 + index) * 100, currency: 'USD' }] }],
      }))
      // Whole-catalog omission cannot partially deactivate existing offerings
      // when a supplied row is invalid. The positive write below names only
      // this test's products instead of disabling unrelated demo experiences.
      const beforeRejected = await request.get(editorUrl)
      expect(beforeRejected.status(), await beforeRejected.text()).toBe(200)
      const catalogBeforeRejected = await beforeRejected.json()
      const invalidReconcile = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'reconcile_products',
        args: { organization_id: organizationId, idempotency_key: crypto.randomUUID(), deactivate_missing: true,
          products: desired.map((product, index) => index === 99 ? { ...product,
            variants: [{ name: 'Standard', prices: [{ ...product.variants[0]!.prices[0]!, compare_at_unit_amount: product.variants[0]!.prices[0]!.unit_amount }] }],
          } : product) },
      })
      const rejected = (await invalidReconcile.json()).result
      expect(rejected.isError).toBe(true)
      expect(rejected.structuredContent).toBeUndefined()
      expect(JSON.parse(rejected.content[0].text)).toEqual({ status: 400, message: 'variants[0].prices[0]: compare_at_unit_amount must exceed unit_amount' })
      const afterRejected = await request.get(editorUrl)
      expect(afterRejected.status(), await afterRejected.text()).toBe(200)
      expect(await afterRejected.json()).toEqual(catalogBeforeRejected)
      const reconcileResponse = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'reconcile_products',
        args: { organization_id: organizationId, idempotency_key: crypto.randomUUID(), products: desired },
      })
      const reconciled = mcpData<{ products: CreatedProduct[] }>(await reconcileResponse.json()).products
      expect(reconciled).toHaveLength(100)
      expect(reconciled.find(product => product.id === created[0]!.id)?.description).toBe('Updated atomically')
      // Disable only this batch's five named products. An unrelated offering
      // remains untouched, including its publication and booking configuration.
      expect(reconciled.filter(product => !product.active).map(product => product.id).sort())
        .toEqual(created.slice(95).map(product => product.id).sort())
      expect(reconciled.filter(product => product.active).map(product => product.id).sort())
        .toEqual(created.slice(0, 95).map(product => product.id).sort())
      const afterReconcile = await listProducts()
      expect(afterReconcile.filter(product => demoIds.has(product.id))).toEqual(demoProducts)
      expect(afterReconcile.filter(product => created.some(item => item.id === product.id)).map(product => ({ id: product.id, active: product.active })))
        .toEqual(reconciled.map(product => ({ id: product.id, active: product.active })))
      const afterEditor = await request.get(editorUrl)
      expect(afterEditor.status(), await afterEditor.text()).toBe(200)
      const afterDetails = (await afterEditor.json()).products as Product[]
      expect(afterDetails.filter(product => demoIds.has(product.id))).toEqual(demoDetails)
      expect(afterDetails.find(product => product.id === created[0]!.id)).toMatchObject({ description: 'Updated atomically', active: true })
    } finally {
      // Delete only this test's products and collections. Every cleanup step
      // runs and reports its failure without rewriting existing offerings.
      const failures: string[] = []
      const step = async (name: string, run: () => Promise<boolean>) => {
        try {
          if (!(await run())) failures.push(name)
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const product of created) {
        await step(`delete product ${product.id}`, async () => mcpData<{ deleted: boolean }>(await (await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'delete_product', args: { organization_id: organizationId, product_id: product.id } })).json()).deleted)
      }
      for (const collectionId of collectionIds) {
        await step(`delete collection ${collectionId}`, async () => mcpData<{ deleted: boolean }>(await (await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'delete_collection', args: { organization_id: organizationId, collection_id: collectionId } })).json()).deleted)
      }
      expect(failures, 'demo tenant cleanup').toEqual([])
    }
    const restored = await listProducts()
    expect(restored).toEqual(demoProducts)
    const restoredEditor = await request.get(editorUrl)
    expect(restoredEditor.status(), await restoredEditor.text()).toBe(200)
    expect((await restoredEditor.json()).products).toEqual(demoDetails)
  } finally {
    await releaseTenantMutationLock()
  }
})
