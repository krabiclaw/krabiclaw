import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createContentDocumentWithBlocks } from '../../server/utils/content/documents.ts'
import { createProduct, setProductLocation, setProductPublication } from '../../server/utils/product-management.ts'
import { getPublicTenantPageForPath } from '../../server/utils/public-tenant-pages.ts'
import { loadOwnerPictures } from '../../server/notifications/hero.ts'
import type { CloudflareEnv } from '../../server/types/cloudflare.ts'

const ORG = 'org'
const LOC = 'loc-a'
const ACTOR = { actorId: 'actor' }
const NOW = '2026-09-16T00:00:00.000Z'

const COVER = 'https://imagedelivery.net/acct/cover/public'
const REEL = 'https://media.example.test/org/media/reel.mp4'
const REEL_POSTER = 'https://imagedelivery.net/acct/reel/public'

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'tenant-page-product-cover-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  await db.prepare(`INSERT INTO organization (id, name, slug, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
    VALUES (?, 'Org', 'org', '{}', 'tenant-theme-v1', 'THB', 'active', 'complete', 'flat', 'restaurant', ?, 'Asia/Bangkok')`).bind(ORG, NOW).run()
  await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Actor', 'actor@example.test', 0, 0, 0)").bind(ACTOR.actorId).run()
  await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')")
    .bind('locale-en', ORG).run()
  await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
    VALUES (?, ?, ?, 'Branch', 'active', 'Asia/Bangkok', ?, ?)`).bind(LOC, ORG, LOC, NOW, NOW).run()
  return { runtime, db }
}

async function placeAsset(db: D1Database, input: {
  assetId: string
  ownerType: 'organization' | 'business_location' | 'product'
  ownerId: string
  slot: string
  kind: 'image' | 'video'
  publicUrl: string
  thumbnailUrl: string
  mimeType: string
}) {
  await db.prepare(`INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, thumbnail_url, mime_type, status, created_at, updated_at)
    VALUES (?, ?, ?, 'cloudflare_images', 'uploaded', ?, ?, ?, 'active', ?, ?)`)
    .bind(input.assetId, ORG, input.kind, input.publicUrl, input.thumbnailUrl, input.mimeType, NOW, NOW).run()
  await db.prepare(`INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`)
    .bind(`placement-${input.assetId}`, ORG, input.ownerType, input.ownerId, input.slot, input.assetId, NOW, NOW).run()
}

/**
 * A product card is drawn from the product's `image` placement.
 *
 * Placements are read slot-ordered, so `gallery` precedes `image`. The grid
 * carried the product's whole placement list and the card drew the head of it,
 * which put a gallery video's .mp4 into an <img src> on every Saya home page
 * whose products had galleries.
 */
test('a product grid item carries the product cover, not whichever placement sorted first', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Ceramics Painting Class',
      variants: [{ name: 'Default', prices: [{ unit_amount: 140000, currency: 'THB' }] }],
    } })
    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: true, actor: ACTOR })
    await setProductLocation(db, { organizationId: ORG, productId: product.id, locationId: LOC, published: true, actor: ACTOR })
    const share = 'https://imagedelivery.net/acct/organization-share/public'
    await placeAsset(db, { assetId: 'asset-share', ownerType: 'organization', ownerId: ORG, slot: 'social_share', kind: 'image', publicUrl: share, thumbnailUrl: `${share}/thumbnail`, mimeType: 'image/png' })
    // Slot order is alphabetical in the placement read: gallery, then image.
    await placeAsset(db, { assetId: 'asset-reel', ownerType: 'product', ownerId: product.id, slot: 'gallery', kind: 'video', publicUrl: REEL, thumbnailUrl: REEL_POSTER, mimeType: 'video/mp4' })
    assert.equal((await loadOwnerPictures(db, ORG, 'product', [product.id])).get(product.id)?.imageUrl, share, 'notifications retain the organization share-image fallback')
    assert.equal((await loadOwnerPictures(db, ORG, 'product', [product.id], { organizationFallback: false })).get(product.id), null, 'a record without its own cover has no contextual photo')
    assert.equal((await loadOwnerPictures(db, ORG, 'business_location', [LOC], { organizationFallback: false })).get(LOC), null, 'organization branding is not a location photo')
    await placeAsset(db, { assetId: 'asset-cover', ownerType: 'product', ownerId: product.id, slot: 'image', kind: 'image', publicUrl: COVER, thumbnailUrl: `${COVER}/thumbnail`, mimeType: 'image/png' })
    const locationPhoto = 'https://imagedelivery.net/acct/location-photo/public'
    await placeAsset(db, { assetId: 'asset-location', ownerType: 'business_location', ownerId: LOC, slot: 'hero', kind: 'image', publicUrl: locationPhoto, thumbnailUrl: `${locationPhoto}/thumbnail`, mimeType: 'image/png' })
    assert.equal((await loadOwnerPictures(db, ORG, 'product', [product.id], { organizationFallback: false })).get(product.id)?.imageUrl, COVER, 'the authored Product cover remains the record photo')
    assert.equal((await loadOwnerPictures(db, ORG, 'business_location', [LOC], { organizationFallback: false })).get(LOC)?.imageUrl, locationPhoto, 'the authored location hero remains the reservation photo')

    await createContentDocumentWithBlocks(db, {
      id: 'home', organizationId: ORG, kind: 'page', rowRole: 'root', locale: 'en',
      title: 'Home', path: '/', status: 'published', visibility: 'listed', metadata: { page_type: 'custom' },
    }, [{ id: 'home-products', type: 'product_grid', data: { product_ids: [product.id] } }])

    const page = await getPublicTenantPageForPath({} as CloudflareEnv, db, ORG, '/')
    assert(page, 'the published home page resolves')
    const grid = page.blocks.find(block => block.type === 'product_grid')
    assert(grid, 'the home page carries its product grid')
    const items = grid.data.items as Array<{ media: Array<{ slot: string; public_url: string | null; kind: string | null }> }>
    assert.equal(items.length, 1)
    assert.deepEqual(
      items[0]!.media.map(item => [item.slot, item.kind, item.public_url]),
      [['image', 'image', COVER]],
      'the card is given the cover placement alone — a gallery video is not a card image',
    )
  } finally {
    await runtime.dispose()
  }
})
