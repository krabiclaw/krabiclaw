import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { executeBatch } from '../../server/db/index.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { createContentDocumentWithBlocks } from '../../server/utils/content/documents.ts'
import { getPublishedTenantPage, isProductPageConflict, listPublishedTenantPagePaths, prepareTenantPageCreate } from '../../server/utils/content/pages.ts'
import { createProduct, getProduct, productPublicPresentation, reconcileProducts, setProductPublication, updateProduct } from '../../server/utils/product-management.ts'
import { setProductBookingConfig } from '../../server/utils/availability.ts'

// Real D1 and the real Better Auth subscription read. A service is a Product
// and the page that shows it, written together through the one product writer
// and the one page writer; these read the result back with plain SQL.

const ORG = 'org-services'
const ACTOR = { actorId: 'owner' }
const NOW = '2026-10-06T00:00:00.000Z'
const SERVICE_PAGE = { title: 'Family Law', pageType: 'custom' as const, recipe: null, blocks: [] }

async function boot(plan: 'growth' | null) {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'product-page-create-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example' } as CloudflareEnv
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Legal Services', 'legal-services', 'legal-services', '{}', 'blawby-theme-v1', 'USD', 'active', 'active', 'flat', 'service', ?, 'America/New_York')`).bind(ORG, NOW).run()
    await db.prepare("INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES ('canonical-domain', ?, 'legal-services.proof.example', 'custom', 'canonical', 'active')").bind(ORG).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@proof.example', 0, 0, 0)").bind(ACTOR.actorId).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('member-owner', ?, ?, 'owner')").bind(ORG, ACTOR.actorId).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('locale-en', ?, 'en', 1, 'published')").bind(ORG).run()
    if (plan) {
      await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('sub', ?, ?, 'active', ?)")
        .bind(plan, ORG, Math.floor(Date.now() / 1000) + 86400).run()
    }
    return { runtime, db, env }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

const counts = async (db: D1Database) => (await db.prepare(`SELECT
    (SELECT count(*) FROM products WHERE organization_id = ?1) AS products,
    (SELECT count(*) FROM product_variants WHERE organization_id = ?1) AS variants,
    (SELECT count(*) FROM content_documents WHERE organization_id = ?1 AND kind = 'page' AND row_role = 'root') AS pages`).bind(ORG).first<{ products: number; variants: number; pages: number }>())!

test('a service, its default variant, its page and their binding commit together, and a retry returns the same pair', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot('growth')
  try {
    // An existing page already holds the service's natural path: the new page
    // takes the next free one and leaves this one exactly as it was.
    await createContentDocumentWithBlocks(db, {
      id: 'page-existing', organizationId: ORG, kind: 'page', rowRole: 'root', locale: 'en',
      title: 'Family law (old)', path: '/services/family-law', metadata: { page_type: 'custom' },
    }, [{ id: 'existing-copy', type: 'markdown', data: { markdown: 'Written before services were Products.', editor_mode: 'rich' } }])
    const existingBefore = await db.prepare("SELECT d.*, (SELECT group_concat(b.id || ':' || b.data_json) FROM content_blocks b WHERE b.document_id = d.id) AS blocks FROM content_documents d WHERE d.id = 'page-existing'").first()

    const create = () => createProduct(db, {
      organizationId: ORG, actor: ACTOR, product: { kind: 'service', name: 'Family Law' },
      publication: { published: false }, page: { data: SERVICE_PAGE, env }, idempotencyKey: 'create-family-law',
    })
    const created = await create()

    const row = await db.prepare(`SELECT p.id, p.kind, p.slug, p.active, pub.published,
        d.id AS page_id, d.path, d.title, d.product_id, d.row_role,
        (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id) AS variants,
        (SELECT count(*) FROM prices pr JOIN product_variants v ON v.id = pr.product_variant_id WHERE v.product_id = p.id) AS prices,
        (SELECT count(*) FROM product_booking_configs b WHERE b.product_id = p.id) AS booking
      FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
      JOIN content_documents d ON d.organization_id = p.organization_id AND d.product_id = p.id
     WHERE p.id = ?`).bind(created.id).first<Record<string, unknown>>()
    assert.deepEqual(row, {
      id: created.id, kind: 'service', slug: 'family-law', active: 1, published: 0,
      page_id: created.page?.id, path: '/services/family-law-2', title: 'Family Law', product_id: created.id, row_role: 'root',
      variants: 1, prices: 0, booking: 0,
    })
    assert.deepEqual(created.page, { id: row?.page_id, path: '/services/family-law-2', title: 'Family Law' })
    assert.deepEqual(await db.prepare("SELECT d.*, (SELECT group_concat(b.id || ':' || b.data_json) FROM content_blocks b WHERE b.document_id = d.id) AS blocks FROM content_documents d WHERE d.id = 'page-existing'").first(), existingBefore)

    // A lost response retried under the same key is the same product and page.
    const before = await counts(db)
    const replayed = await create()
    assert.equal(replayed.id, created.id)
    assert.deepEqual(replayed.page, created.page)
    assert.deepEqual(await counts(db), before)

    // The same key for a different request is refused, and writes nothing.
    await assert.rejects(createProduct(db, {
      organizationId: ORG, actor: ACTOR, product: { kind: 'service', name: 'Employment Law' },
      publication: { published: false }, page: { data: { ...SERVICE_PAGE, title: 'Employment Law' }, env }, idempotencyKey: 'create-family-law',
    }), (error: { statusCode?: number; data?: { mutation_applied?: boolean } }) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.data?.mutation_applied, undefined, 'an earlier committed creation is never classified as an unused key')
      return true
    })
    assert.deepEqual(await counts(db), before)

    const productBefore = await db.prepare('SELECT * FROM products WHERE id = ?').bind(created.id).first()
    await assert.rejects(updateProduct(db, {
      organizationId: ORG, productId: created.id, actor: ACTOR, env,
      patch: { name: 'Must not be saved', slug: 'a-different-address' } as never,
    }), { statusCode: 400, message: 'A product keeps its saved slug' })
    assert.deepEqual(await db.prepare('SELECT * FROM products WHERE id = ?').bind(created.id).first(), productBefore)

    // Renaming and changing the offering's kind are content edits. The saved
    // slug and its independently bound page survive both update entry points.
    await updateProduct(db, { organizationId: ORG, productId: created.id, actor: ACTOR, env,
      patch: { name: 'Family Law Workshop', kind: 'experience' } })
    assert.deepEqual(await db.prepare('SELECT kind, name, slug FROM products WHERE id = ?').bind(created.id).first(),
      { kind: 'experience', name: 'Family Law Workshop', slug: 'family-law' })
    await reconcileProducts(db, { organizationId: ORG, actor: ACTOR, env,
      products: [{ product_id: created.id, kind: 'service', name: 'Family Law Consultation' }] })
    assert.deepEqual(await db.prepare('SELECT kind, name, slug FROM products WHERE id = ?').bind(created.id).first(),
      { kind: 'service', name: 'Family Law Consultation', slug: 'family-law' })
    assert.deepEqual(await db.prepare('SELECT id, path, title FROM content_documents WHERE product_id = ?').bind(created.id).first(),
      { id: created.page!.id, path: '/services/family-law-2', title: 'Family Law' })
    assert.deepEqual(await counts(db), before)
  } finally {
    await runtime.dispose()
  }
})

test('a refused page creates no product, and one page per product holds at the write itself', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot(null)
  try {
    // Without the plan that allows custom pages the page is refused, and the
    // product that would have owned it is not left behind.
    await assert.rejects(createProduct(db, {
      organizationId: ORG, actor: ACTOR, product: { kind: 'service', name: 'Tenant Rights' },
      publication: { published: false }, page: { data: { ...SERVICE_PAGE, title: 'Tenant Rights' }, env }, idempotencyKey: 'create-tenant-rights',
    }), (error: { statusCode?: number; data?: { mutation_applied?: boolean } }) => {
      assert.equal(error.statusCode, 402)
      assert.deepEqual(error.data, { mutation_applied: false })
      return true
    })
    assert.deepEqual(await counts(db), { products: 0, variants: 0, pages: 0 })

    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('sub', 'growth', ?, 'active', ?)")
      .bind(ORG, Math.floor(Date.now() / 1000) + 86400).run()
    // A legacy imported service has no page yet; concurrent page writers
    // must still obey the native one-page-per-product constraint.
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','legacy-probate',?,'Probate','probate',?,?)").bind(ORG,ACTOR.actorId,ACTOR.actorId).run()
    const product = { id: 'legacy-probate' }

    // Two pages prepared for one product, each passing its own checks before
    // either is written: the database keeps the second from binding.
    const prepare = (path: string) => prepareTenantPageCreate(db, { organizationId: ORG, userId: ACTOR.actorId, env,
      data: { ...SERVICE_PAGE, title: 'Probate', path, productId: product.id } })
    const first = await prepare('/services/probate')
    const second = await prepare('/services/probate-and-estate')
    await executeBatch(db, first.queries, { operation: 'Create tenant page' })
    await assert.rejects(executeBatch(db, second.queries, { operation: 'Create tenant page' }), (error: unknown) => isProductPageConflict(error))
    assert.deepEqual((await db.prepare("SELECT id, path FROM content_documents WHERE organization_id = ? AND product_id = ?").bind(ORG, product.id).all()).results,
      [{ id: first.variantId, path: '/services/probate' }])
  } finally {
    await runtime.dispose()
  }
})

test('a bound page and its share address follow publication while its booking is unavailable', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot('growth')
  try {
    const product = await createProduct(db, {
      organizationId: ORG, actor: ACTOR, product: { kind: 'service', name: 'Employment Law', active: false },
      publication: { published: false }, page: { data: { ...SERVICE_PAGE, title: 'Employment Law', blocks: [{ id: 'employment-copy', type: 'markdown', data: { markdown: 'Employment law information remains available before consultations open.', editor_mode: 'rich' } }] }, env },
    })
    const path = product.page?.path
    assert.equal(path, '/services/employment-law')
    const published = async () => ({
      page: (await getPublishedTenantPage(db, ORG, path!))?.id ?? null,
      listed: (await listPublishedTenantPagePaths(db, ORG)).some(entry => entry.path === path),
      publicUrl: (await productPublicPresentation(db, env, ORG, await getProduct(db, ORG, product.id))).publicUrl,
    })
    assert.deepEqual(await published(), { page: null, listed: false, publicUrl: null })
    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: true, actor: ACTOR })
    const visible = { page: product.page?.id, listed: true, publicUrl: `https://legal-services.proof.example${path}` }
    assert.deepEqual(await published(), visible)
    await setProductBookingConfig(db, { organizationId: ORG, productId: product.id, actorId: ACTOR.actorId, env, patch: { duration_minutes: 30 } })
    const saved = await getProduct(db, ORG, product.id)
    assert.equal(saved.active, false)
    const projection = await productPublicPresentation(db, env, ORG, saved)
    assert.deepEqual(projection.readiness, { ready: false, missing: ['variants.prices', 'booking.schedule'] })
    assert.deepEqual(await published(), visible)
    assert.equal((await getPublishedTenantPage(db, ORG, path!))?.blocks[0]?.data.markdown,
      'Employment law information remains available before consultations open.')
    await setProductPublication(db, { organizationId: ORG, productId: product.id, published: false, actor: ACTOR })
    assert.deepEqual(await published(), { page: null, listed: false, publicUrl: null })
  } finally {
    await runtime.dispose()
  }
})
