import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { MCP_VERSION, MCP_ORGANIZATION_ID, mcpRequest, mcpData } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'

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
      args: { organization_id: MCP_ORGANIZATION_ID },
    })
    expect(locations.status()).toBe(200)
    const locationId = mcpData<{ locations: Array<{ id: string }> }>(await locations.json()).locations[0]?.id
    expect(locationId).toEqual(expect.any(String))

    const mismatchedTarget = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'set_media',
      organizationId: MCP_ORGANIZATION_ID,
      args: {
        organization_id: MCP_ORGANIZATION_ID,
        placement: { owner_type: 'business_location', owner_id: locationId, slot: 'hero' },
        location_id: locationId,
        asset_id: 'media-does-not-matter-for-this-check',
      },
    })
    expect(mismatchedTarget.status()).toBe(200)
    const mismatchedTargetBody = await mismatchedTarget.json() as { result?: { isError?: boolean, content?: Array<{ text?: string }> } }
    expect(mismatchedTargetBody.result?.isError).toBe(true)
    expect(mismatchedTargetBody.result?.content?.[0]?.text).toContain('location_id')
  })

  test('a gallery reorder moves the fixture gallery and get_location reads the new order', async ({ request, baseURL }, testInfo) => {
    const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, MCP_ORGANIZATION_ID)
    const call = async <T>(toolName: string, args: Record<string, unknown>) => mcpData<T>(await (await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName, args: { organization_id: MCP_ORGANIZATION_ID, ...args },
    })).json())
    const locationId = 'loc-demo-2'
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
      expect(original, 'loc-demo-2 fixture gallery').toHaveLength(2)
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
    const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, MCP_ORGANIZATION_ID)
    type MediaItem = { asset_id: string }
    type Product = { id: string; name: string; image: MediaItem | null; gallery: MediaItem[]; media: MediaItem[] }
    const call = async <T>(toolName: string, args: Record<string, unknown>) => mcpData<T>(await (await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName, args: { organization_id: MCP_ORGANIZATION_ID, ...args },
    })).json())
    // The seeded Margherita carries one image, also its only gallery item.
    const productId = 'mi-1'
    const seededAsset = 'media-demo-margherita'
    const expectSeededMedia = (product: Product) => {
      expect(product.image?.asset_id).toBe(seededAsset)
      expect(product.gallery.map(item => item.asset_id)).toEqual([seededAsset])
      expect(product.media.length).toBeGreaterThan(0)
    }
    let originalName: string | undefined
    try {
      await loginAs(request, baseURL!)
      originalName = (await call<{ product: Product }>('get_product', { product_id: productId })).product.name
      const changed = (await call<{ product: Product }>('update_product', { product_id: productId, name: `${originalName} MCP media check` })).product
      expect(changed.name).toBe(`${originalName} MCP media check`)
      expectSeededMedia(changed)
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
        }
      } finally {
        await releaseTenantMutationLock()
      }
    }
  })

})
