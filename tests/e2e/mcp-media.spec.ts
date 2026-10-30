import { expect, test } from '@playwright/test'
import Ajv from 'ajv'
import { loginAs } from './helpers/auth'
import { MCP_VERSION, mcpOrganizationId, mcpRequest, mcpData } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import type { Product as EditorProduct } from '../../server/types/products'

test.describe('stateless MCP server', () => {
  test('ChatGPT session exposes native media upload', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!)

    const initialize = await mcpRequest(request, baseURL!, {
      method: 'initialize',
      params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } },
      extraHeaders: { 'user-agent': 'openai-mcp/1.0.0' },
    })
    expect(initialize.status()).toBe(200)
    const initializeBody = await initialize.json() as { result?: { protocolVersion?: string; capabilities?: { tools?: unknown; resources?: unknown } } }
    expect(initializeBody.result?.protocolVersion).toBe(MCP_VERSION)
    expect(initializeBody.result?.capabilities?.tools).toBeDefined()

    const initialized = await mcpRequest(request, baseURL!, {
      method: 'notifications/initialized',
      extraHeaders: { 'user-agent': 'openai-mcp/1.0.0' },
    })
    expect(initialized.status()).toBe(202)

    const tools = await mcpRequest(request, baseURL!, {
      method: 'tools/list',
      extraHeaders: { 'user-agent': 'openai-mcp/1.0.0' },
    })
    expect(tools.status()).toBe(200)
    const toolsBody = await tools.json() as { result: { tools: Array<{ name: string, inputSchema?: { required?: string[], properties?: Record<string, unknown>, additionalProperties?: boolean }, outputSchema?: Record<string, unknown>, _meta?: Record<string, unknown> }> } }
    const uploadTool = toolsBody.result.tools.find(tool => tool.name === 'save_media_attachment')
    expect(uploadTool?.inputSchema?.required).toEqual(['file', 'idempotency_key'])
    expect(uploadTool?.inputSchema?.properties?.file_id).toBeUndefined()
    expect(uploadTool?.inputSchema?.properties?.poster_file).toBeDefined()
    expect(uploadTool?.inputSchema?.additionalProperties).toBe(false)
    expect(uploadTool?._meta?.['openai/fileParams']).toEqual(['file', 'poster_file'])
    const setMediaTool = toolsBody.result.tools.find(tool => tool.name === 'set_media')
    expect(setMediaTool?.inputSchema?.required).toEqual(['placement', 'asset_id'])
    expect(setMediaTool?.inputSchema?.properties?.placement).toBeDefined()
    expect(setMediaTool?.inputSchema?.additionalProperties).toBe(false)

    const locations = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'list_locations',
      args: { organization_id: mcpOrganizationId() },
    })
    expect(locations.status()).toBe(200)
    const locationId = mcpData<{ locations: Array<{ id: string }> }>(await locations.json()).locations[0]?.id
    expect(locationId).toEqual(expect.any(String))

    const mismatchedTarget = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'set_media',
      organizationId: mcpOrganizationId(),
      args: {
        organization_id: mcpOrganizationId(),
        placement: { owner_type: 'business_location', owner_id: locationId, slot: 'hero' },
        location_id: locationId,
        asset_id: 'media-does-not-matter-for-this-check',
      },
    })
    expect(mismatchedTarget.status()).toBe(200)
    const mismatchedTargetBody = await mismatchedTarget.json() as { result?: { isError?: boolean, content?: Array<{ text?: string }> } }
    expect(mismatchedTargetBody.result?.isError).toBe(true)
    expect(mismatchedTargetBody.result?.content?.[0]?.text).toContain('location_id')

    // Library responses expose media metadata needed for selection, while
    // storage keys and the uploader's identity stay at the provider boundary.
    const libraryTool = toolsBody.result.tools.find(tool => tool.name === 'list_media_assets')
    expect(libraryTool).toBeDefined()
    const libraryResponse = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'list_media_assets', args: { organization_id: mcpOrganizationId(), kind: 'image', limit: 100 },
    })
    expect(libraryResponse.status()).toBe(200)
    const library = mcpData<{ assets: Array<Record<string, unknown>> }>(await libraryResponse.json())
    const validateLibrary = new Ajv({ strict: false, allErrors: true }).compile(libraryTool!.outputSchema!)
    expect(validateLibrary(library), JSON.stringify(validateLibrary.errors)).toBe(true)
    const selected = library.assets.find(asset => asset.asset_id === seededTenant('restaurant').media.margherita!.id)
    expect(selected, 'The existing Margherita photo is available for selection').toBeDefined()
    const editorMedia = await request.get(`${baseURL}/api/editor/organizations/${mcpOrganizationId()}/media`, { params: { id: String(selected!.asset_id) } })
    expect(editorMedia.status()).toBe(200)
    const storedMedia = (await editorMedia.json()).media
    expect(storedMedia).toHaveLength(1)
    const stored = storedMedia[0]
    expect(selected).toEqual({
      asset_id: stored.id, kind: stored.kind, provider: stored.provider, source: stored.source,
      public_url: stored.public_url, thumbnail_url: stored.thumbnail_url, mime_type: stored.mime_type,
      file_name: stored.file_name, file_size: stored.file_size, width: stored.width, height: stored.height,
      duration: stored.duration, alt_text: stored.alt_text, category: stored.category, status: stored.status,
      created_at: stored.created_at, updated_at: stored.updated_at,
    })
    for (const asset of library.assets) {
      expect(asset).not.toHaveProperty('r2_key')
      expect(asset).not.toHaveProperty('cloudflare_image_id')
      expect(asset).not.toHaveProperty('created_by_user_id')
      expect(asset).not.toHaveProperty('organization_id')
    }
    const emptyMetadataEdit = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'update_media_asset', args: { organization_id: mcpOrganizationId(), asset_id: selected!.asset_id },
    })
    expect(emptyMetadataEdit.status()).toBe(200)
    expect((await emptyMetadataEdit.json()).result.isError).toBe(true)
    const unchangedMedia = await request.get(`${baseURL}/api/editor/organizations/${mcpOrganizationId()}/media`, { params: { id: String(selected!.asset_id) } })
    expect(unchangedMedia.status()).toBe(200)
    expect((await unchangedMedia.json()).media).toEqual([stored])
  })

  test('a gallery reorder moves the fixture gallery and get_location reads the new order', async ({ request, baseURL }, testInfo) => {
    const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, mcpOrganizationId())
    const call = async <T>(toolName: string, args: Record<string, unknown>) => mcpData<T>(await (await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName, args: { organization_id: mcpOrganizationId(), ...args },
    })).json())
    const locationId = seededTenant('restaurant').locations.williamsburg!.id
    const placement = { owner_type: 'business_location', owner_id: locationId, slot: 'gallery' }
    let original: string[] = []
    try {
      await loginAs(request, baseURL!)
      const galleryOrder = async () => (await call<{ location: { media: Array<{ slot: string; asset_id: string }> } }>('get_location', { location_id: locationId }))
        .location.media.filter(item => item.slot === 'gallery').map(item => item.asset_id)
      // The fixture's two-image gallery, in its stored order.
      original = await galleryOrder()
      const [first, second] = original
      // Nothing changes until the fixture is known to be exactly the two images restored below.
      expect(original, 'Williamsburg fixture gallery').toHaveLength(2)
      const conflictingAnchors = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'reorder_media', args: {
          organization_id: mcpOrganizationId(), placement,
          moves: [{ asset_id: second, before_asset_id: first, after_asset_id: first }],
        },
      })
      expect(conflictingAnchors.status()).toBe(200)
      expect((await conflictingAnchors.json()).result.isError).toBe(true)
      expect(await galleryOrder()).toEqual(original)
      await call('reorder_media', { placement, moves: [{ asset_id: first }] })
      expect(await galleryOrder()).toEqual([second, first])
      await call('reorder_media', { placement, moves: [{ asset_id: second, before_asset_id: first }] })
      expect(await galleryOrder()).toEqual([second, first])
      await call('reorder_media', { placement, moves: [{ asset_id: first, before_asset_id: second }] })
      expect(await galleryOrder()).toEqual([first, second])
    } finally {
      // Put the fixture back in its stored order whatever failed above.
      try {
        if (original.length === 2) await call('reorder_media', { placement, moves: [{ asset_id: original[0], before_asset_id: original[1] }] })
      } finally {
        await releaseTenantMutationLock()
      }
    }
  })
  test('product mutation responses preserve the canonical image and gallery', async ({ request, baseURL }, testInfo) => {
    const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, mcpOrganizationId())
    type MediaItem = { asset_id: string }
    type Product = { id: string; name: string; image: MediaItem | null; gallery: MediaItem[] }
    const call = async <T>(toolName: string, args: Record<string, unknown>) => mcpData<T>(await (await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName, args: { organization_id: mcpOrganizationId(), ...args },
    })).json())
    // The seeded Margherita carries one image, also its only gallery item.
    const productId = seededTenant('restaurant').products.margherita!.id
    const seededAsset = seededTenant('restaurant').media.margherita!.id
    const readEditorProduct = async () => {
      const response = await request.get(`${baseURL}/api/editor/organizations/${mcpOrganizationId()}/products/${productId}`)
      expect(response.status(), await response.text()).toBe(200)
      return (await response.json() as { product: EditorProduct }).product
    }
    const expectSeededMedia = (product: Product) => {
      expect(product.image?.asset_id).toBe(seededAsset)
      expect(product.gallery.map(item => item.asset_id)).toEqual([seededAsset])
      expect(product).not.toHaveProperty('media')
      expect(product).not.toHaveProperty('social_image')
    }
    let originalProduct: EditorProduct | undefined
    let originalName: string | undefined
    const expectSavedProduct = (product: EditorProduct, name: string) => {
      expect(product.name).toBe(name)
      for (const field of ['image', 'gallery', 'media'] as const) {
        expect(product[field]).toEqual(originalProduct![field])
      }
    }
    try {
      await loginAs(request, baseURL!)
      originalProduct = await readEditorProduct()
      expect(originalProduct.image?.asset_id).toBe(seededAsset)
      expect(originalProduct.gallery.map(item => item.asset_id)).toEqual([seededAsset])
      expect(originalProduct.media.length).toBeGreaterThan(0)
      originalName = originalProduct.name
      expect((await call<{ product: Product }>('get_product', { product_id: productId })).product.name).toBe(originalName)
      const changed = (await call<{ product: Product }>('update_product', { product_id: productId, name: `${originalName} MCP media check` })).product
      expect(changed.name).toBe(`${originalName} MCP media check`)
      expectSeededMedia(changed)
      expectSavedProduct(await readEditorProduct(), `${originalName} MCP media check`)
      const saved = (await call<{ product: Product }>('get_product', { product_id: productId })).product
      expect(saved.name).toBe(`${originalName} MCP media check`)
      expectSeededMedia(saved)
    } finally {
      try {
        if (originalName !== undefined) {
          await call('update_product', { product_id: productId, name: originalName })
          const restored = (await call<{ product: Product }>('get_product', { product_id: productId })).product
          expect(restored.name).toBe(originalName)
          expectSeededMedia(restored)
          expectSavedProduct(await readEditorProduct(), originalName)
        }
      } finally {
        await releaseTenantMutationLock()
      }
    }
  })

})
