import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import {
  createCollection,
  createProduct,
  deleteProduct,
  getProduct,
  listCollectionProducts,
  listCollections,
  listLocationProducts,
  listOrganizationProducts,
  productBookingReadiness,
  reconcileProducts,
  reorderCollections,
  resolveVariantPrice,
  setCollectionProducts,
  setProductLocation,
  setProductPublication,
  updateProduct,
  updateMenu,
} from '../../server/utils/product-management.ts'
import { AmbiguousPriceError } from '../../shared/prices.ts'
import { groupProductsByCollection } from '../../utils/product-presentation.ts'
import { claimSessionCapacity, listSessions } from '../../server/utils/availability.ts'
import { loadPublicSiteProductDetail, loadPublicProductCollection, loadPublicProductDetail, loadPublicProductSessions } from '../../server/utils/public-products.ts'
import { listPublicBookingSessions } from '../../server/utils/public-session-booking.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

const ORG = 'org'
const ACTOR = { actorId: 'actor' }
const NOW = '2026-09-11T00:00:00.000Z'

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'catalog-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
    VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'THB', 'active', 'active', 'flat', 'restaurant', ?, 'Asia/Bangkok')`)
    .bind(ORG, NOW).run()
  await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Actor', 'actor@example.test', 0, 0, 0)").bind(ACTOR.actorId).run()
  for (const loc of ['loc-a', 'loc-b']) {
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'Asia/Bangkok', ?, ?)`).bind(loc, ORG, loc, loc, NOW, NOW).run()
  }
  return { runtime, db }
}

test('product kind narrows organization and location catalogues before pagination', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const products = [
      ...Array.from({ length: 105 }, (_, index) => ({ id: `dish-${index}`, kind: 'dish', name: `A Dish ${String(index).padStart(3, '0')}` })),
      { id: 'take', kind: 'experience', name: 'Take Set' },
      { id: 'ume', kind: 'experience', name: 'Ume Set' },
    ]
    await db.batch(products.flatMap(product => [
      db.prepare('INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(product.id, ORG, product.kind, product.name, product.id, ACTOR.actorId, ACTOR.actorId),
      db.prepare('INSERT INTO product_publications (organization_id, product_id, published, created_by, updated_by) VALUES (?, ?, 0, ?, ?)')
        .bind(ORG, product.id, ACTOR.actorId, ACTOR.actorId),
      db.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES (?, ?, 'loc-a', 1, 1, ?, ?)")
        .bind(ORG, product.id, ACTOR.actorId, ACTOR.actorId),
    ]))
    assert.equal((await listOrganizationProducts(db, { organizationId: ORG, window: { limit: 100, offset: 0 } })).some(product => product.kind === 'experience'), false)
    for (const read of [
      (offset: number) => listOrganizationProducts(db, { organizationId: ORG, kind: 'experience', window: { limit: 1, offset } }),
      (offset: number) => listLocationProducts(db, { organizationId: ORG, locationId: 'loc-a', kind: 'experience', window: { limit: 1, offset } }),
    ]) {
      assert.deepEqual((await read(0)).map(product => product.id), ['take', 'ume'], 'filtered first page includes the extra row for has_more')
      assert.deepEqual((await read(1)).map(product => product.id), ['ume'])
    }
    assert.deepEqual(await listLocationProducts(db, { organizationId: ORG, locationId: 'loc-b', kind: 'experience' }), [])
    assert.deepEqual(await listOrganizationProducts(db, { organizationId: ORG, kind: 'experience', publishedOnly: true }), [], 'withheld experiences remain editable but are not claimed as public')
  } finally { await runtime.dispose() }
})

test('public experiences require a configured booking flow and retain full or temporarily closed sessions', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', ?, 'en', 1, 'published')").bind(ORG).run()
    const legacy = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: {
      kind: 'experience', name: 'Omakase', active: true, variants: [{ name: 'Seat', prices: [{ unit_amount: 130000, currency: 'THB' }] }],
    }, publication: { published: false } })
    await assert.rejects(setProductLocation(db, { organizationId: ORG, productId: legacy.id, locationId: 'loc-a', active: true, published: true, actor: ACTOR }),
      { statusCode: 409, data: { code: 'EXPERIENCE_BOOKING_INCOMPLETE', product_id: legacy.id, location_id: 'loc-a', missing: ['booking', 'booking.schedule'] } })
    // Imported legacy state can have a published duration without a schedule.
    await db.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_by, updated_by) VALUES (?, ?, 'loc-a', 1, 1, ?, ?)")
      .bind(ORG, legacy.id, ACTOR.actorId, ACTOR.actorId).run()
    await db.prepare('INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, created_by, updated_by) VALUES (?, ?, 60, 8, ?, ?)')
      .bind(legacy.id, ORG, ACTOR.actorId, ACTOR.actorId).run()
    await db.prepare('UPDATE product_publications SET published = 1 WHERE organization_id = ? AND product_id = ?').bind(ORG, legacy.id).run()
    const visible = async () => (await loadPublicProductCollection(db, ORG, 'experiences', false))!.products.map(product => product.id)
    assert.deepEqual(await productBookingReadiness(db, ORG, await getProduct(db, ORG, legacy.id)), { ready: false, missing: ['booking.schedule'] })
    assert.deepEqual(await visible(), [])
    assert.deepEqual(await listOrganizationProducts(db, { organizationId: ORG, publishedOnly: true, kind: 'experience', window: { limit: 1, offset: 0 } }), [])
    await assert.rejects(listPublicBookingSessions(db, ORG, legacy.slug, {} as CloudflareEnv), (error: { statusCode?: number }) => error.statusCode === 404)
    await assert.rejects(setProductPublication(db, { organizationId: ORG, productId: legacy.id, published: true, actor: ACTOR }),
      (error: { statusCode?: number; data?: { code?: string; missing?: string[] } }) => error.statusCode === 409 && error.data?.code === 'EXPERIENCE_BOOKING_INCOMPLETE' && error.data.missing?.includes('booking.schedule') === true)

    const external = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'experience', name: 'External Booking', active: true, order_url: 'https://booking.example/omakase' }, publication: { published: true } })
    assert.deepEqual(await visible(), [external.id])
    assert.deepEqual(await listPublicBookingSessions(db, ORG, external.slug, {} as CloudflareEnv), { success: true, product: { id: external.id, name: external.name, slug: external.slug }, sessions: [] })

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const start = `${tomorrow}T12:00:00.000Z`, end = `${tomorrow}T13:00:00.000Z`
    await db.prepare("INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, created_by, updated_by) VALUES ('omakase-session', ?, ?, 'loc-a', 'Asia/Bangkok', ?, ?, 8, ?, ?)")
      .bind(ORG, legacy.id, start, end, ACTOR.actorId, ACTOR.actorId).run()
    const ids = [external.id, legacy.id].sort()
    assert.deepEqual((await visible()).sort(), ids)
    await claimSessionCapacity(db, { organizationId: ORG, productId: legacy.id, sessionId: 'omakase-session', productVariantId: legacy.variants[0]!.id, partySize: 8 })
    const sessions = await listSessions(db, { organizationId: ORG, productId: legacy.id, fromInstant: `${tomorrow}T00:00:00.000Z`, toInstant: `${tomorrow}T23:59:59.999Z` })
    assert.deepEqual(sessions.map(session => ({ remaining: session.remaining, full: session.is_full })), [{ remaining: 0, full: true }])
    assert.deepEqual((await visible()).sort(), ids, 'a full experience stays visible')
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE product_session_id = 'omakase-session'").run()
    await db.prepare("UPDATE business_locations SET special_hours = ? WHERE id = 'loc-a'")
      .bind(JSON.stringify([{ kind: 'closure', starts_on: tomorrow, ends_on: tomorrow, note: 'Private event' }])).run()
    assert.deepEqual(await productBookingReadiness(db, ORG, await getProduct(db, ORG, legacy.id)), { ready: true, missing: [] })
    assert.deepEqual((await visible()).sort(), ids, 'a temporary closure changes availability, not the published experience')
    await db.prepare("UPDATE business_locations SET special_hours = NULL WHERE id = 'loc-a'").run()
    assert.equal((await productBookingReadiness(db, ORG, await getProduct(db, ORG, legacy.id), { requireAllocation: true })).ready, true)
    await setProductLocation(db, { organizationId: ORG, productId: legacy.id, locationId: 'loc-a', active: false, published: true, actor: ACTOR })
    const pausedOffering = await getProduct(db, ORG, legacy.id)
    assert.deepEqual(await productBookingReadiness(db, ORG, pausedOffering), { ready: true, missing: [] })
    assert.equal((await productBookingReadiness(db, ORG, pausedOffering, { requireAllocation: true })).ready, false)
    await setProductPublication(db, { organizationId: ORG, productId: legacy.id, published: true, actor: ACTOR })
    assert.deepEqual((await visible()).sort(), ids, 'pausing a location offering retains its published information')
    const experienceDetail = await loadPublicSiteProductDetail({} as CloudflareEnv, db, ORG, 'experiences', false, legacy.slug)
    assert.equal(experienceDetail?.product.id, legacy.id)
    assert.equal(experienceDetail?.location, null)
    assert.deepEqual(await loadPublicProductSessions(db, experienceDetail!, {} as CloudflareEnv), [], 'an in-person-only paused offering never requests online sessions')
    const locationDetail = await loadPublicProductDetail({} as CloudflareEnv, db, ORG, 'experiences', false, 'loc-a', legacy.slug)
    assert.equal(locationDetail?.product.id, legacy.id)
    assert.equal(locationDetail?.location.id, 'loc-a')
    assert.deepEqual(await loadPublicProductSessions(db, locationDetail!, {} as CloudflareEnv), [], 'a paused location does not advertise sessions')
    await assert.rejects(listPublicBookingSessions(db, ORG, legacy.slug, {} as CloudflareEnv, 'loc-a'), (error: { statusCode?: number }) => error.statusCode === 404)
    for (const product of [legacy, external]) {
      await updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: { active: false } })
      const paused = await getProduct(db, ORG, product.id)
      await setProductPublication(db, { organizationId: ORG, productId: product.id, published: true, actor: ACTOR })
      assert.deepEqual(await productBookingReadiness(db, ORG, paused), { ready: true, missing: [] }, 'pausing bookings retains a configured public experience')
      assert.equal((await productBookingReadiness(db, ORG, paused, { requireAllocation: true })).missing.includes('active'), true)
      await assert.rejects(listPublicBookingSessions(db, ORG, product.slug, {} as CloudflareEnv), (error: { statusCode?: number }) => error.statusCode === 404)
      assert.deepEqual((await visible()).sort(), ids, 'Accept bookings controls sale availability rather than deleting the published information')
    }
    await setProductPublication(db, { organizationId: ORG, productId: external.id, published: false, actor: ACTOR })
    await assert.rejects(setProductPublication(db, { organizationId: ORG, productId: external.id, published: true, actor: ACTOR }),
      (error: { statusCode?: number; data?: { missing?: string[] } }) => error.statusCode === 409 && error.data?.missing?.includes('active') === true)
    assert.deepEqual(await visible(), [legacy.id], 'publishing a withheld experience still requires accepting bookings')
  } finally { await runtime.dispose() }
})

test('one product identity serves two locations', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Tom Yum Soup',
      variants: [{ name: 'Default', prices: [
        { unit_amount: 25000, currency: 'THB' },
        { unit_amount: 27000, currency: 'THB', location_id: 'loc-a' },
        { unit_amount: 900, currency: 'USD' },
      ] }],
    } })
    assert.equal(product.variants.length, 1, 'a product with no options still has one real variant')
    assert.equal(product.variants[0]!.prices.length, 3)

    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: true, actor: ACTOR })
    await setProductLocation(db, { organizationId: ORG, productId: product.id, locationId: 'loc-a', published: true, actor: ACTOR })
    await setProductLocation(db, { organizationId: ORG, productId: product.id, locationId: 'loc-b', published: true, actor: ACTOR })

    assert.equal(await db.prepare('SELECT count(*) n FROM products').first<number>('n'), 1, 'offering it at two locations did not duplicate identity')
    assert.equal((await listOrganizationProducts(db, { organizationId: ORG, publishedOnly: true })).length, 1)
    assert.equal((await listLocationProducts(db, { organizationId: ORG, locationId: 'loc-a', publishedOnly: true })).length, 1)
    assert.equal((await listLocationProducts(db, { organizationId: ORG, locationId: 'loc-b', publishedOnly: true })).length, 1)

    // Scope-specific prices stay independent, resolved through one contract.
    const variant = (await getProduct(db, ORG, product.id)).variants[0]!
    assert.equal(resolveVariantPrice(variant, { currency: 'THB', location_id: 'loc-a', at: NOW })!.unit_amount, 27000)
    assert.equal(resolveVariantPrice(variant, { currency: 'THB', location_id: 'loc-b', at: NOW })!.unit_amount, 25000)
    assert.equal(resolveVariantPrice(variant, { currency: 'USD', location_id: null, at: NOW })!.unit_amount, 900)
    assert.equal(resolveVariantPrice(variant, { currency: 'EUR', location_id: null, at: NOW }), null, 'an unpriced currency is not substituted')

    // The audit trail records the write, rather than failing quietly.
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name = 'product.created'").first<number>('n'), 1)
  } finally { await runtime.dispose() }
})

test('merchant activation, organization publication, and location publication are distinct states', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish', name: 'Pad Thai' } })
    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: true, actor: ACTOR })
    await setProductLocation(db, { organizationId: ORG, productId: product.id, locationId: 'loc-a', published: true, active: true, actor: ACTOR })

    await updateProduct(db, { organizationId: ORG, productId: product.id, patch: { active: false }, actor: ACTOR })
    const disabled = await getProduct(db, ORG, product.id)
    assert.equal(disabled.active, false, 'the merchant sale switch is off')
    assert.equal(disabled.publications[0]!.published, true, 'disabling did not unpublish it')
    assert.equal(disabled.locations[0]!.published, true, 'disabling did not withdraw it from the location')
    // Nothing in the model says "sold out": that is a stock or capacity result
    // and a disabled product has made no claim about either.
    assert.equal(Object.hasOwn(disabled, 'available'), false)

    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: false, actor: ACTOR })
    const withheld = await getProduct(db, ORG, product.id)
    assert.equal(withheld.locations[0]!.published, true, 'organization publication is independent of location publication')
    assert.equal((await listOrganizationProducts(db, { organizationId: ORG, publishedOnly: true })).length, 0)
    assert.equal((await listOrganizationProducts(db, { organizationId: ORG })).length, 1, 'the organization still carries it, withheld')
  } finally { await runtime.dispose() }
})

test('a simple product and an optioned product use the same variant-price path', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const simple = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Espresso', variants: [{ name: 'Default', prices: [{ unit_amount: 8000, currency: 'THB' }] }],
    } })
    const optioned = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Latte',
      options: [{ id: 'opt-size', name: 'Size', values: [{ id: 'val-s', value: 'Small' }, { id: 'val-l', value: 'Large' }] }],
      variants: [
        { id: 'var-s', name: 'Small', option_values: { 'opt-size': 'val-s' }, prices: [{ unit_amount: 9000, currency: 'THB' }] },
        { id: 'var-l', name: 'Large', option_values: { 'opt-size': 'val-l' }, prices: [{ unit_amount: 12000, currency: 'THB' }] },
      ],
    } })
    for (const product of [simple, optioned]) {
      for (const variant of product.variants) {
        assert(resolveVariantPrice(variant, { currency: 'THB', location_id: null, at: NOW }), `${product.name}/${variant.name} prices through the same path`)
      }
    }
    assert.equal(optioned.variants.length, 2)
    assert.deepEqual(optioned.variants.map(v => v.option_values), [{ 'opt-size': 'val-s' }, { 'opt-size': 'val-l' }])

    // Invalid option combinations are refused.
    await assert.rejects(createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Broken A',
      options: [{ id: 'o1', name: 'Size', values: [{ id: 'v1', value: 'S' }] }],
      variants: [{ name: 'No selection', option_values: {} }],
    } }), /must select a value for every option/)
    await assert.rejects(createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Broken B',
      options: [{ id: 'o1', name: 'Size', values: [{ id: 'v1', value: 'S' }] }],
      variants: [
        { name: 'One', option_values: { o1: 'v1' } },
        { name: 'Two', option_values: { o1: 'v1' } },
      ],
    } }), /same combination/)
    await assert.rejects(createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Broken C',
      options: [{ id: 'o1', name: 'Size', values: [{ id: 'v1', value: 'S' }] }],
      variants: [{ name: 'Alien', option_values: { o2: 'v9' } }],
    } }), /options this product does not define/)
  } finally { await runtime.dispose() }
})

test('ambiguous pricing is refused at write time, not resolved at read time', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    await assert.rejects(createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Two Prices',
      variants: [{ name: 'Default', prices: [
        { unit_amount: 10000, currency: 'THB' },
        { unit_amount: 12000, currency: 'THB' },
      ] }],
    } }), AmbiguousPriceError)

    await assert.rejects(createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Bad Recurrence',
      variants: [{ name: 'Default', prices: [{ unit_amount: 10000, currency: 'THB', type: 'recurring' }] }],
    } }), /recurring price requires/)

    // Consecutive windows are not a conflict.
    const scheduled = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Seasonal',
      variants: [{ name: 'Default', prices: [
        { unit_amount: 10000, currency: 'THB', valid_until_at: '2026-10-01T00:00:00.000Z' },
        { unit_amount: 12000, currency: 'THB', valid_from_at: '2026-10-01T00:00:00.000Z' },
      ] }],
    } })
    const variant = scheduled.variants[0]!
    assert.equal(resolveVariantPrice(variant, { currency: 'THB', location_id: null, at: '2026-09-15T00:00:00.000Z' })!.unit_amount, 10000)
    assert.equal(resolveVariantPrice(variant, { currency: 'THB', location_id: null, at: '2026-11-15T00:00:00.000Z' })!.unit_amount, 12000)
  } finally { await runtime.dispose() }
})

test('collections carry grouping and order without copying the product', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const a = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish', name: 'Soup' } })
    const b = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish', name: 'Salad' } })
    const starters = await createCollection(db, { organizationId: ORG, actor: ACTOR, collection: { name: 'Starters' } })
    const featured = await createCollection(db, { organizationId: ORG, actor: ACTOR, collection: { name: 'Featured' } })
    const branch = await createCollection(db, { organizationId: ORG, actor: ACTOR, collection: { location_id: 'loc-a', name: 'Branch Menu' } })

    await setCollectionProducts(db, { organizationId: ORG, collectionId: starters.id, productIds: [b.id, a.id], actor: ACTOR })
    await setCollectionProducts(db, { organizationId: ORG, collectionId: featured.id, productIds: [a.id], actor: ACTOR })
    await setCollectionProducts(db, { organizationId: ORG, collectionId: branch.id, productIds: [a.id, b.id], actor: ACTOR })

    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: starters.id })).map(p => p.name), ['Salad', 'Soup'])
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: branch.id })).map(p => p.name), ['Soup', 'Salad'])
    assert.equal(await db.prepare('SELECT count(*) n FROM products').first<number>('n'), 2, 'appearing in three collections copied nothing')

    // "Featured" is curated membership, not a second truth on the product.
    const soup = await getProduct(db, ORG, a.id)
    assert.equal(soup.collections.length, 3)
    assert.equal(Object.hasOwn(soup, 'featured'), false)

    // Source removals and destination appends are one final-state write.
    // Existing destination membership keeps its position and row identity.
    const beforeProducts = (await db.prepare('SELECT * FROM products ORDER BY id').all()).results
    const beforeLocations = (await db.prepare('SELECT * FROM product_locations ORDER BY product_id, location_id').all()).results
    const retained = await db.prepare('SELECT * FROM collection_products WHERE collection_id = ? AND product_id = ?').bind(featured.id, a.id).first()
    await setCollectionProducts(db, { organizationId: ORG, collectionId: starters.id, productIds: [], expectedProductIds: [b.id, a.id], moveTo: { collection_id: featured.id, expected_product_ids: [a.id] }, actor: ACTOR })
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: starters.id })).map(product => product.id), [])
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: featured.id })).map(product => product.id), [a.id, b.id])
    assert.deepEqual(await db.prepare('SELECT * FROM collection_products WHERE collection_id = ? AND product_id = ?').bind(featured.id, a.id).first(), retained)
    assert.deepEqual((await db.prepare('SELECT * FROM products ORDER BY id').all()).results, beforeProducts)
    assert.deepEqual((await db.prepare('SELECT * FROM product_locations ORDER BY product_id, location_id').all()).results, beforeLocations)
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: branch.id })).map(product => product.id), [a.id, b.id])

    // An explicit cross-scope destination is valid; collections never imply a
    // change to a Product's location offerings.
    await setCollectionProducts(db, { organizationId: ORG, collectionId: featured.id, productIds: [b.id], expectedProductIds: [a.id, b.id], moveTo: { collection_id: branch.id, expected_product_ids: [a.id, b.id] }, actor: ACTOR })
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: featured.id })).map(product => product.id), [b.id])
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: branch.id })).map(product => product.id), [a.id, b.id])
    assert.deepEqual((await db.prepare('SELECT * FROM product_locations ORDER BY product_id, location_id').all()).results, beforeLocations)

    const beforeRefusal = (await db.prepare('SELECT * FROM collection_products ORDER BY collection_id, sort_order, product_id').all()).results
    await assert.rejects(setCollectionProducts(db, { organizationId: ORG, collectionId: featured.id, productIds: [], expectedProductIds: [a.id, b.id], actor: ACTOR }), { statusCode: 409, data: { code: 'COLLECTION_PRODUCTS_CHANGED', field: 'expected_product_ids', collection_id: featured.id } })
    await assert.rejects(setCollectionProducts(db, { organizationId: ORG, collectionId: featured.id, productIds: [], expectedProductIds: [b.id], moveTo: { collection_id: branch.id, expected_product_ids: [b.id, a.id] }, actor: ACTOR }), { statusCode: 409, data: { code: 'COLLECTION_PRODUCTS_CHANGED', field: 'expected_product_ids', collection_id: branch.id } })
    assert.deepEqual((await db.prepare('SELECT * FROM collection_products ORDER BY collection_id, sort_order, product_id').all()).results, beforeRefusal)

    await setCollectionProducts(db, { organizationId: ORG, collectionId: starters.id, productIds: [a.id, b.id], expectedProductIds: [], actor: ACTOR })
    const race = await Promise.allSettled([
      setCollectionProducts(db, { organizationId: ORG, collectionId: starters.id, productIds: [], expectedProductIds: [a.id, b.id], moveTo: { collection_id: featured.id, expected_product_ids: [b.id] }, actor: ACTOR }),
      setCollectionProducts(db, { organizationId: ORG, collectionId: featured.id, productIds: [a.id], expectedProductIds: [b.id], actor: ACTOR }),
    ])
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of race) if (result.status === 'rejected') assert.equal(result.reason.data.code, 'COLLECTION_PRODUCTS_CHANGED')
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: starters.id })).map(product => product.id), race[0]!.status === 'fulfilled' ? [] : [a.id, b.id])
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: featured.id })).map(product => product.id), race[0]!.status === 'fulfilled' ? [b.id, a.id] : [a.id])

    const another = await createCollection(db, { organizationId: ORG, actor: ACTOR, collection: { name: 'Desserts' } })
    const shared = (await listCollections(db, { organizationId: ORG, locationId: null })).map(collection => collection.id)
    assert(shared.includes(another.id))
    const firstOrder = [...shared].reverse()
    const secondOrder = [...shared.slice(1), shared[0]!]
    const orderRace = await Promise.allSettled([firstOrder, secondOrder].map(collectionIds => reorderCollections(db, { organizationId: ORG, locationId: null, collectionIds, expectedCollectionIds: shared, actor: ACTOR })))
    assert.equal(orderRace.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of orderRace) if (result.status === 'rejected') assert.equal(result.reason.data.code, 'COLLECTION_ORDER_CHANGED')
    assert.deepEqual((await listCollections(db, { organizationId: ORG, locationId: null })).map(collection => collection.id), orderRace[0]!.status === 'fulfilled' ? firstOrder : secondOrder)
    assert.deepEqual((await listCollections(db, { organizationId: ORG, locationId: 'loc-a' })).map(collection => collection.id), [branch.id])
    await assert.rejects(reorderCollections(db, { organizationId: ORG, locationId: null, collectionIds: shared, expectedCollectionIds: shared, actor: ACTOR }), { statusCode: 409, data: { code: 'COLLECTION_ORDER_CHANGED', field: 'expected_collection_ids' } })

    // Imported membership positions may tie. A rename must not change their
    // canonical order or turn the editor's displayed snapshot into a conflict.
    const tiedIds = [a.id, b.id].sort()
    await updateProduct(db, { organizationId: ORG, productId: tiedIds[0]!, patch: { name: 'Zucchini' }, actor: ACTOR })
    await updateProduct(db, { organizationId: ORG, productId: tiedIds[1]!, patch: { name: 'Apple' }, actor: ACTOR })
    await db.prepare('UPDATE collection_products SET sort_order = 0 WHERE organization_id = ? AND collection_id = ?').bind(ORG, branch.id).run()
    const tiedRead = await listCollectionProducts(db, { organizationId: ORG, collectionId: branch.id })
    assert.deepEqual(tiedRead.map(product => product.id), tiedIds)
    assert.deepEqual(tiedRead.map(product => product.name), ['Zucchini', 'Apple'])
    const displayed = groupProductsByCollection(await listOrganizationProducts(db, { organizationId: ORG }), await listCollections(db, { organizationId: ORG })).find(collection => collection.id === branch.id)!.products.map(product => product.id)
    assert.deepEqual(displayed, tiedIds, 'editor snapshots use the same stable tie order as the canonical read')
    await setCollectionProducts(db, { organizationId: ORG, collectionId: branch.id, productIds: [...tiedIds].reverse(), expectedProductIds: displayed, actor: ACTOR })
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: branch.id })).map(product => product.id), [...tiedIds].reverse())
  } finally { await runtime.dispose() }
})

test('details carry descriptive attributes, and an undefined one is refused', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Pad Thai', details: { 'allergens': ['Peanuts'], 'ingredients': ['Rice noodles'] },
    } })
    assert.deepEqual(product.details['allergens'], ['Peanuts'])
    assert.deepEqual(product.details['ingredients'], ['Rice noodles'], 'inclusions and preparation stay distinct')

    await assert.rejects(createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Undefined attribute', details: { 'unknown': ['x'] },
    } }), /not a field/)
    await assert.rejects(createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Wrong type', details: { 'allergens': 'Peanuts' },
    } }), /must be a list/)
  } finally { await runtime.dispose() }
})

test('reconcile converges instead of duplicating, and deletion respects the canonical page', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const rows = [{ product_id: 'src-1', kind: 'dish', name: 'Imported Pad Thai' }, { product_id: 'src-2', kind: 'dish', name: 'Imported Tom Yum' }]
    await reconcileProducts(db, { organizationId: ORG, products: rows, actor: ACTOR })
    await reconcileProducts(db, { organizationId: ORG, products: rows, actor: ACTOR })
    assert.equal(await db.prepare('SELECT count(*) n FROM products').first<number>('n'), 2, 'running the same import twice converges')

    await reconcileProducts(db, { organizationId: ORG, products: [rows[0]!], actor: ACTOR, deactivateMissing: true })
    assert.equal(await db.prepare("SELECT active FROM products WHERE id = 'src-2'").first<number>('active'), 0,
      'a product missing from the import is deactivated, not deleted')
    assert.equal(await db.prepare('SELECT count(*) n FROM products').first<number>('n'), 2)

    // Removing the offering removes its canonical page in the same operation.
    await db.prepare(`INSERT INTO organization_locales (id, organization_id, locale, is_source, status, created_at, updated_at)
      VALUES ('sl-en', ?, 'en', 1, 'published', ?, ?)`).bind(ORG, NOW, NOW).run()
    await db.prepare(`INSERT INTO content_documents (id, organization_id, kind, row_role, locale, product_id, title, path, sort_order, metadata_json, created_at, updated_at)
      VALUES ('doc-1', ?, 'page', 'root', 'en', 'src-1', 'One', '/one', 0, '{"page_type":"custom"}', ?, ?)`).bind(ORG, NOW, NOW).run()
    await deleteProduct(db, { organizationId: ORG, productId: 'src-1' })
    assert.equal(await db.prepare("SELECT count(*) n FROM content_documents WHERE id='doc-1'").first<number>('n'),0)
    assert.equal(await db.prepare('SELECT count(*) n FROM products').first<number>('n'), 1)
    assert.equal(await db.prepare('SELECT count(*) n FROM product_variants').first<number>('n'), 1, 'the deleted product took its variants with it')
  } finally { await runtime.dispose() }
})

test('editing a product keeps variant identity, so bookings survive', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Class', variants: [{ id: 'var-adult', name: 'Adult', prices: [{ unit_amount: 50000, currency: 'THB' }] }],
    } })
    await db.prepare(`INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, created_by, updated_by)
      VALUES (?, ?, 60, 5, 'a', 'a')`).bind(product.id, ORG).run()
    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, status, created_by, updated_by)
      VALUES ('s1', ?, ?, 'loc-a', 'Asia/Bangkok', '2099-01-01T00:00:00.000Z', '2099-01-01T01:00:00.000Z', 5, 'scheduled', 'a', 'a')`).bind(ORG, product.id).run()
    await db.prepare(`INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, status)
      VALUES ('b1', ?, ?, 's1', 'var-adult', 2, 'confirmed')`).bind(ORG, product.id).run()

    await updateProduct(db, { organizationId: ORG, productId: product.id, patch: { description: 'Now with clay' }, actor: ACTOR })
    assert.equal(await db.prepare("SELECT count(*) n FROM bookings WHERE id = 'b1'").first<number>('n'), 1,
      'editing the product did not drop the booking')
    assert.equal((await getProduct(db, ORG, product.id)).description, 'Now with clay')
    assert.equal(await db.prepare("SELECT count(*) n FROM product_sessions WHERE id = 's1'").first<number>('n'), 1)

    // Removing that option is refused, and refused before anything is written:
    // the booking's foreign key cascades, so a delete that went through would
    // take the guest's seat with it.
    await assert.rejects(
      updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
        variants_mode: 'replace',
        variants: [{ name: 'Child', prices: [{ unit_amount: 25000, currency: 'THB' }] }],
      } }),
      (error: unknown) => String((error as { statusMessage?: string }).statusMessage).includes('bookings'),
    )
    assert.equal(await db.prepare("SELECT count(*) n FROM bookings WHERE id = 'b1'").first<number>('n'), 1,
      'the refused edit left the booking alone')
    assert.equal(await db.prepare("SELECT count(*) n FROM product_variants WHERE id = 'var-adult'").first<number>('n'), 1,
      'the refused edit left the variant alone')

    // A cancelled booking is the record that it happened, and it is held by
    // the same key. The option stops being sold by being turned off.
    await db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = '2099-01-01T00:00:00.000Z' WHERE id = 'b1'").run()
    await assert.rejects(
      updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
        variants_mode: 'replace',
        variants: [{ name: 'Child', prices: [{ unit_amount: 25000, currency: 'THB' }] }],
      } }),
      (error: unknown) => String((error as { statusMessage?: string }).statusMessage).includes('bookings'),
    )
    assert.equal(await db.prepare("SELECT count(*) n FROM bookings WHERE id = 'b1'").first<number>('n'), 1,
      'a cancelled booking is history, not something an edit deletes')

    // The race the pre-check cannot see: a booking that lands after the check
    // and before the write. The variant's foreign key RESTRICTS its deletion,
    // and D1 applies a batch whole or not at all — so the same statements the
    // writer runs, with a booking now present, leave the product exactly as it
    // was: variant, selections and prices, not a surviving id with nothing
    // behind it.
    await db.prepare("UPDATE bookings SET status = 'confirmed', cancelled_at = NULL WHERE id = 'b1'").run()
    await db.prepare("INSERT INTO product_options (id, organization_id, product_id, name, sort_order) VALUES ('opt', ?, ?, 'Size', 0)").bind(ORG, product.id).run()
    await db.prepare("INSERT INTO product_option_values (id, organization_id, product_id, product_option_id, value, sort_order) VALUES ('val', ?, ?, 'opt', 'Adult', 0)").bind(ORG, product.id).run()
    await db.prepare("INSERT INTO product_variant_option_values (organization_id, product_id, product_variant_id, product_option_id, product_option_value_id) VALUES (?, ?, 'var-adult', 'opt', 'val')").bind(ORG, product.id).run()
    const before = {
      prices: await db.prepare("SELECT count(*) n FROM prices WHERE product_variant_id = 'var-adult'").first<number>('n'),
      selections: await db.prepare("SELECT count(*) n FROM product_variant_option_values WHERE product_variant_id = 'var-adult'").first<number>('n'),
      values: await db.prepare("SELECT count(*) n FROM product_option_values WHERE id = 'val'").first<number>('n'),
    }
    assert.deepEqual(before, { prices: 1, selections: 1, values: 1 })
    await assert.rejects(db.batch([
      db.prepare('DELETE FROM product_variant_option_values WHERE organization_id = ? AND product_id = ?').bind(ORG, product.id),
      db.prepare('DELETE FROM prices WHERE organization_id = ? AND product_variant_id IN (SELECT id FROM product_variants WHERE organization_id = ? AND product_id = ?)').bind(ORG, ORG, product.id),
      db.prepare("DELETE FROM product_variants WHERE organization_id = ? AND product_id = ? AND id NOT IN ('var-child')").bind(ORG, product.id),
      db.prepare("DELETE FROM product_option_values WHERE organization_id = ? AND product_id = ? AND id NOT IN ('none')").bind(ORG, product.id),
      db.prepare("UPDATE products SET description = 'half-written' WHERE id = ?").bind(product.id),
    ]))
    const after = {
      prices: await db.prepare("SELECT count(*) n FROM prices WHERE product_variant_id = 'var-adult'").first<number>('n'),
      selections: await db.prepare("SELECT count(*) n FROM product_variant_option_values WHERE product_variant_id = 'var-adult'").first<number>('n'),
      values: await db.prepare("SELECT count(*) n FROM product_option_values WHERE id = 'val'").first<number>('n'),
      description: (await getProduct(db, ORG, product.id)).description,
    }
    assert.deepEqual(after, { ...before, description: 'Now with clay' }, 'the refused batch changed nothing')
  } finally { await runtime.dispose() }
})

test('an organization that withholds a product does not show it, at any location', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Seasonal Special', variants: [{ name: 'Default', prices: [{ unit_amount: 19000, currency: 'THB' }] }],
    } })
    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: true, actor: ACTOR })
    await setProductLocation(db, { organizationId: ORG, productId: product.id, locationId: 'loc-a', published: true, actor: ACTOR })
    assert.equal((await listLocationProducts(db, { organizationId: ORG, locationId: 'loc-a', publishedOnly: true })).length, 1)

    // Organization publication and location publication are separate switches,
    // and the public answer needs both. Withholding it hides it even though
    // the location still offers it.
    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: false, actor: ACTOR })
    assert.equal((await listLocationProducts(db, { organizationId: ORG, locationId: 'loc-a', publishedOnly: true })).length, 0,
      'a withheld product is not public at its location')
    assert.equal((await listLocationProducts(db, { organizationId: ORG, locationId: 'loc-a' })).length, 1,
      'the merchant still sees what the organization is withholding')
  } finally { await runtime.dispose() }
})

test('a minimal price patch preserves sibling variants, prices, options and unrelated fields', { timeout: 120_000 }, async (t) => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Pad Thai', description: 'With tofu', unit_label: 'plate', metadata: { kitchen: 'wok' },
      options: [{ id: 'opt-size', name: 'Size', values: [{ id: 'val-small', value: 'Small' }, { id: 'val-large', value: 'Large' }] }],
      variants: [{ id: 'var-small', name: 'Small', sku: 'PAD-S', sort_order: 0, option_values: { 'opt-size': 'val-small' }, prices: [
        { unit_amount: 18000, currency: 'THB', location_id: 'loc-a', compare_at_unit_amount: 30000, tax_behavior: 'inclusive', source: 'import', valid_from_at: '2026-01-01T00:00:00.000Z', valid_until_at: '2099-01-01T00:00:00.000Z' },
        { unit_amount: 14000, currency: 'THB', location_id: 'loc-b' },
      ] }, {
        id: 'var-large', name: 'Large', sku: 'PAD-L', active: false, sort_order: 7, option_values: { 'opt-size': 'val-large' },
        prices: [{ unit_amount: 24000, currency: 'THB', location_id: 'loc-a', tax_behavior: 'exclusive' }],
      }],
    } })
    const before = (await getProduct(db, ORG, product.id)).variants[0]!.prices
      .map(price => `${price.id}:${price.unit_amount}:${price.location_id}:${price.created_at}`).sort()
    assert.equal(before.length, 2)

    await updateProduct(db, { organizationId: ORG, productId: product.id, patch: { description: 'With prawns' }, actor: ACTOR })
    const after = (await getProduct(db, ORG, product.id)).variants[0]!.prices
      .map(price => `${price.id}:${price.unit_amount}:${price.location_id}:${price.created_at}`).sort()
    assert.deepEqual(after, before, 'editing the description kept both offers, their scopes and their identity')

    // A caller that does restate the variants keeps the identity it restates.
    const kept = (await getProduct(db, ORG, product.id)).variants[0]!
    await updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      variants: [{ id: kept.id, name: kept.name, prices: kept.prices.map(price => ({
        id: price.id, unit_amount: price.location_id === 'loc-a' ? 19000 : price.unit_amount,
        currency: price.currency, location_id: price.location_id,
      })) }],
    } })
    const repriced = (await getProduct(db, ORG, product.id)).variants[0]!.prices
    assert.deepEqual(repriced.map(price => price.id).sort(), kept.prices.map(price => price.id).sort(), 'restated prices kept their identity')
    assert.equal(repriced.find(price => price.location_id === 'loc-a')!.unit_amount, 19000)
    assert.equal(repriced.find(price => price.location_id === 'loc-b')!.unit_amount, 14000, 'the other location was not touched')

    // An edit names what changes: the variant id, the price id and the new
    // amount. Everything unstated — the variant's name, the other price, every
    // other field of the restated price — is kept, and so is the price's row.
    const priceA = repriced.find(price => price.location_id === 'loc-a')!
    const previous = await getProduct(db, ORG, product.id)
    const rowsBefore = {
      variants: (await db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id').bind(product.id).all()).results,
      options: (await db.prepare('SELECT * FROM product_options WHERE product_id = ? ORDER BY id').bind(product.id).all()).results,
      values: (await db.prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id').bind(product.id).all()).results,
      selections: (await db.prepare('SELECT * FROM product_variant_option_values WHERE product_id = ? ORDER BY product_variant_id').bind(product.id).all()).results,
      siblingPrices: (await db.prepare('SELECT * FROM prices WHERE product_variant_id IN (SELECT id FROM product_variants WHERE product_id = ?) AND id <> ? ORDER BY id').bind(product.id, priceA.id).all()).results,
    }
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(previous.updated_at) })
    await updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      expected_updated_at: previous.updated_at,
      variants: [{ id: kept.id, prices: [{ id: priceA.id, unit_amount: 21000 }] }],
    } })
    const afterMinimal = await getProduct(db, ORG, product.id)
    assert.equal(afterMinimal.updated_at, new Date(Date.parse(previous.updated_at) + 1).toISOString(), 'a price edit advances the canonical Product version even in the same millisecond')
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      expected_updated_at: previous.updated_at, name: 'Stale dish', options: [], variants_mode: 'replace',
      variants: [{ id: kept.id, prices_mode: 'replace', prices: [{ id: priceA.id, unit_amount: 1 }] }],
    } }), { statusCode: 409, data: { code: 'PRODUCT_UPDATE_CONFLICT', field: 'expected_updated_at', product_id: product.id } })
    assert.deepEqual(await getProduct(db, ORG, product.id), afterMinimal, 'a stale full catalog edit changes no scalar, option, variant or price')
    assert.equal(afterMinimal.variants.length, 2, 'an unmentioned sibling variant is preserved')
    assert.deepEqual(afterMinimal.variants.find(variant => variant.id === 'var-large'), previous.variants.find(variant => variant.id === 'var-large'))
    assert.deepEqual(afterMinimal.options, previous.options)
    assert.deepEqual([afterMinimal.description, afterMinimal.unit_label, afterMinimal.metadata], ['With prawns', 'plate', { kitchen: 'wok' }])
    const rowsAfter = {
      variants: (await db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id').bind(product.id).all()).results,
      options: (await db.prepare('SELECT * FROM product_options WHERE product_id = ? ORDER BY id').bind(product.id).all()).results,
      values: (await db.prepare('SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id').bind(product.id).all()).results,
      selections: (await db.prepare('SELECT * FROM product_variant_option_values WHERE product_id = ? ORDER BY product_variant_id').bind(product.id).all()).results,
      siblingPrices: (await db.prepare('SELECT * FROM prices WHERE product_variant_id IN (SELECT id FROM product_variants WHERE product_id = ?) AND id <> ? ORDER BY id').bind(product.id, priceA.id).all()).results,
    }
    assert.deepEqual(rowsAfter, rowsBefore, 'every unmentioned persisted catalog field remains unchanged')
    const minimal = afterMinimal.variants.find(variant => variant.id === kept.id)!
    assert.equal(minimal.name, kept.name, 'an unstated variant name is kept')
    assert.deepEqual(minimal.prices.map(price => price.id).sort(), kept.prices.map(price => price.id).sort(), 'a price-only edit kept the price it did not mention')
    const edited = minimal.prices.find(price => price.id === priceA.id)!
    assert.deepEqual([edited.unit_amount, edited.currency, edited.location_id, edited.created_at], [21000, priceA.currency, 'loc-a', priceA.created_at])
    assert.deepEqual({ ...edited, unit_amount: priceA.unit_amount, updated_at: priceA.updated_at, updated_by: priceA.updated_by }, priceA, 'a price patch changes no other stored terms')
    assert.equal(minimal.prices.find(price => price.location_id === 'loc-b')!.unit_amount, 14000)

    // A price or variant this product does not have cannot be restated into it, and a new one must say what it is.
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      variants: [{ id: kept.id, prices: [{ id: 'price-elsewhere', unit_amount: 1 }] }],
    } }), /does not belong to variant/)
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      variants: [{ id: kept.id, prices: [{ currency: 'THB' }] }],
    } }), /unit_amount is required for a new price/)
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      variants: [{ prices: [{ unit_amount: 100, currency: 'THB' }] }],
    } }), /name is required for a new variant/)

    // Removing children is a separate, explicit instruction. Kept identities
    // still accept partial fields, while omitted children are removed.
    await updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      variants_mode: 'replace',
      variants: [{ id: kept.id, prices_mode: 'replace', prices: [{ id: priceA.id }] }],
    } })
    const replaced = await getProduct(db, ORG, product.id)
    assert.deepEqual(replaced.variants.map(variant => variant.id), [kept.id])
    assert.deepEqual(replaced.variants[0]!.prices.map(price => price.id), [priceA.id])
    assert.equal(replaced.variants[0]!.prices[0]!.unit_amount, 21000)
    assert.deepEqual(replaced.options, previous.options)
    await updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      variants: [{ id: kept.id, prices_mode: 'replace', prices: [] }],
    } })
    assert.equal(await db.prepare('SELECT count(*) n FROM prices WHERE product_variant_id = ?').bind(kept.id).first<number>('n'), 0, 'explicit empty price replacement clears the offers')
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: { variants_mode: 'replace' } }), /variants is required/)
    await assert.rejects(updateProduct(db, { organizationId: ORG, productId: product.id, actor: ACTOR, patch: {
      variants: [{ id: kept.id, prices_mode: 'replace' }],
    } }), /prices is required/)
  } finally { await runtime.dispose() }
})

test('two options can offer the same value label without colliding', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const product = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Mug',
      options: [
        { name: 'Inside colour', values: [{ value: 'White' }, { value: 'Blue' }] },
        { name: 'Outside colour', values: [{ value: 'White' }, { value: 'Green' }] },
      ],
      variants: [
        { name: 'White / White', option_values: { 'Inside colour': 'White', 'Outside colour': 'White' }, prices: [{ unit_amount: 40000, currency: 'THB' }] },
        { name: 'Blue / Green', option_values: { 'Inside colour': 'Blue', 'Outside colour': 'Green' }, prices: [{ unit_amount: 45000, currency: 'THB' }] },
      ],
    } })
    const stored = await getProduct(db, ORG, product.id)
    const inside = stored.options.find(option => option.name === 'Inside colour')!
    const outside = stored.options.find(option => option.name === 'Outside colour')!
    const whiteWhite = stored.variants.find(variant => variant.name === 'White / White')!
    assert.equal(whiteWhite.option_values[inside.id], inside.values.find(value => value.value === 'White')!.id,
      'the inside selection points at the inside option own value')
    assert.equal(whiteWhite.option_values[outside.id], outside.values.find(value => value.value === 'White')!.id,
      'the outside selection points at the outside option own value')
    assert.notEqual(whiteWhite.option_values[inside.id], whiteWhite.option_values[outside.id])
  } finally { await runtime.dispose() }
})

test('an id from another tenant is refused, not upserted onto', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    await db.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('org-other', 'Other', 'other', 'USD', 'UTC')").run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('actor-other', 'Other', 'other@example.test', 0, 0, 0)").run()
    await db.prepare(`INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('dish', 'prod-other','org-other','Their Dish','their-dish','actor-other','actor-other')`).run()
    await db.prepare(`INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('var-other','org-other','prod-other','Their Variant','actor-other','actor-other')`).run()

    const mine = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish',
      name: 'Mine', variants: [{ name: 'Default', prices: [{ unit_amount: 1000, currency: 'THB' }] }],
    } })
    await assert.rejects(
      updateProduct(db, { organizationId: ORG, productId: mine.id, actor: ACTOR, patch: {
        variants: [{ id: 'var-other', name: 'Hijacked', option_values: {}, prices: [] }],
      } }),
      /does not belong to this product/,
    )
    assert.equal(await db.prepare("SELECT name FROM product_variants WHERE id='var-other'").first<string>('name'), 'Their Variant',
      "another tenant's variant was not touched")
    assert.equal(await db.prepare("SELECT count(*) n FROM product_variants WHERE product_id = ?").bind(mine.id).first<number>('n'), 1,
      'the refused edit left this product with its own variant')
  } finally { await runtime.dispose() }
})


test('a menu update commits all sections, prices and public offerings once', { timeout: 120_000 }, async () => {
  const { runtime, db } = await boot()
  try {
    const sections = Array.from({ length: 7 }, (_, section) => ({ name: `Section ${section + 1}`, items: Array.from({ length: section === 6 ? 7 : 10 }, (_, item) => ({ name: `Dish ${section}-${item}`, variants: [{ name: 'Default', prices: [{ unit_amount: 10000 + item, currency: 'THB' }] }] })) }))
    const input = { organizationId: ORG, locationId: 'loc-a', sections, idempotencyKey: 'photo-menu', actor: ACTOR }
    const outcome = await updateMenu(db, input)
    assert.equal(outcome.sections.length, 7)
    const publicProducts = await listLocationProducts(db, { organizationId: ORG, locationId: 'loc-a', publishedOnly: true })
    assert.equal(publicProducts.length, 67)
    assert.ok(publicProducts.every(product => product.kind === 'dish' && product.active && product.variants[0]?.prices[0]?.currency === 'THB'))
    assert.deepEqual(outcome.sections.map(section => section.collection.name), sections.map(section => section.name))
    for (const [index, section] of outcome.sections.entries()) assert.deepEqual(section.products.map(product => product.name), sections[index]!.items.map(item => item.name))
    assert.equal((await updateMenu(db, input)).replayed, true)
    assert.equal(await db.prepare('SELECT count(*) n FROM products').first<number>('n'), 67)
    await assert.rejects(updateMenu(db, { ...input, sections: [{ ...sections[0]!, name: 'Different menu' }] }), /different menu update/)
    const collection = outcome.sections[0]!.collection
    const before = (await listCollectionProducts(db, { organizationId: ORG, collectionId: collection.id })).map(product => product.id)
    await assert.rejects(setCollectionProducts(db, { organizationId: ORG, collectionId: collection.id, productIds: ['missing-id'], actor: ACTOR }), /missing products/)
    assert.deepEqual((await listCollectionProducts(db, { organizationId: ORG, collectionId: collection.id })).map(product => product.id), before)
  } finally { await runtime.dispose() }
})

test('catalog edits and publication changes retain their actor without counting unchanged saves as work', async () => {
  const { runtime, db } = await boot()
  try {
    const env = {} as CloudflareEnv
    const made = await createProduct(db, { organizationId: ORG, actor: ACTOR, product: { kind: 'dish', name: 'Original bowl' }, publication: { published: false } })
    const edits = async () => (await db.prepare("SELECT actor_user_id, payload_json FROM activity_entries WHERE event_name = 'product.updated' AND json_extract(payload_json, '$.entityId') = ? ORDER BY occurred_at, id")
      .bind(made.id).all<{ actor_user_id: string; payload_json: string }>()).results.map(row => ({ actor: row.actor_user_id, ...JSON.parse(row.payload_json) }))
    await updateProduct(db, { organizationId: ORG, productId: made.id, patch: { name: 'New bowl' }, actor: ACTOR, env })
    assert.equal((await getProduct(db, ORG, made.id)).name, 'New bowl')
    const first = await edits()
    assert.equal(first.length, 1)
    assert.equal(first[0].actor, ACTOR.actorId)
    assert.deepEqual(first[0].metadata.changed_fields, ['name'])
    assert.notEqual(first[0].beforeState.updated_at, first[0].afterState.updated_at)
    await updateProduct(db, { organizationId: ORG, productId: made.id, patch: { name: 'New bowl' }, actor: ACTOR, env })
    assert.deepEqual(await edits(), first)
    const keyed = { organizationId: ORG, productId: made.id, patch: { name: 'New bowl' }, actor: ACTOR, env, idempotencyKey: 'unchanged-bowl' }
    await updateProduct(db, keyed)
    await updateProduct(db, keyed)
    const afterRepeat = await edits()
    assert.equal(afterRepeat.length, 2, 'the unchanged keyed request retains one replay receipt')
    assert.equal(afterRepeat[1].metadata.operation, 'unchanged')
    assert.deepEqual(afterRepeat[1].metadata.changed_fields, [])
    assert.equal(afterRepeat.filter(edit => edit.metadata.operation !== 'unchanged').length, 1)
    await assert.rejects(updateProduct(db, { ...keyed, patch: { name: 'Different bowl' } }), /different product update/)
    await setProductPublication(db, { organizationId: ORG, productId: made.id, published: true, actor: ACTOR, env })
    const published = await getProduct(db, ORG, made.id)
    assert.equal(published.publications.find(publication => publication.organization_id === ORG)?.published, true)
    const afterPublication = await edits()
    assert.equal(afterPublication.length, 3)
    assert.deepEqual(afterPublication[2].metadata.changed_fields, ['publication'])
    assert.equal(afterPublication[2].afterState.updated_at, await db.prepare('SELECT updated_at FROM product_publications WHERE organization_id = ? AND product_id = ?').bind(ORG, made.id).first('updated_at'))
    assert.equal(afterPublication[2].actor, ACTOR.actorId)
    await setProductPublication(db, { organizationId: ORG, productId: made.id, published: true, actor: ACTOR, env })
    assert.deepEqual(await edits(), afterPublication)
    await setProductLocation(db, { organizationId: ORG, productId: made.id, locationId: 'loc-a', active: true, published: true, actor: ACTOR, env })
    const afterLocation = await edits()
    assert.deepEqual(afterLocation[3].metadata.changed_fields, ['locations'])
    assert.equal(afterLocation[3].afterState.updated_at, await db.prepare('SELECT updated_at FROM product_locations WHERE organization_id = ? AND product_id = ? AND location_id = ?').bind(ORG, made.id, 'loc-a').first('updated_at'))
    await setProductLocation(db, { organizationId: ORG, productId: made.id, locationId: 'loc-a', active: true, published: true, actor: ACTOR, env })
    assert.deepEqual(await edits(), afterLocation)
  } finally { await runtime.dispose() }
})
