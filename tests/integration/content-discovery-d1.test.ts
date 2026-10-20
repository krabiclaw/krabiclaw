import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { createContentDocumentWithBlocks, updateContentDocument } from '../../server/utils/content/documents.ts'
import { buildPlatformKnowledgeDocuments, buildTenantBlogDocuments } from '../../server/utils/public-search.ts'
import { listSocialCardOwners } from '../../server/utils/social-card.ts'
import { getPublishedBlogPost, listPublishedArticles } from '../../server/utils/content/publishing.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { createDb } from '../../server/db/index.ts'
import { recordTenantPageview, resolvePublicPageIdentity } from '../../server/utils/pageview-tracking.ts'

test('public discovery resolves translations through current publication owners', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'content-discovery-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example' }
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    for (const id of ['platform', 'tenant', 'other']) {
      // KrabiClaw's own organization is the one running the platform template.
      await db.prepare(`INSERT INTO organization (id,name,slug,subdomain,theme_id,vertical, default_currency, timezone) VALUES (?,?,?,?,?,?, 'USD', 'UTC')`)
        .bind(id, id, id, id, id === 'platform' ? 'krabiclaw-theme-v1' : 'saya-theme-v1', id === 'platform' ? 'service' : 'restaurant').run()
      for (const locale of ['en', 'th']) await db.prepare('INSERT INTO organization_locales (id,organization_id,locale,is_source,status) VALUES (?,?,?,?,?)')
        .bind(id + locale, id, locale, Number(locale === 'en'), 'published').run()
    }
    // Documentation is the platform organization's docs article collection.
    await createContentDocumentWithBlocks(db, { id: 'guide', organizationId: 'platform', kind: 'article', rowRole: 'root', locale: 'en',
      title: 'guide', slug: 'guide', summary: 'guide summary', status: 'published', publishedAt: '2026-01-01T00:00:00.000Z', visibility: 'listed',
      metadata: { collection: 'docs', category: 'Getting Started' },
    }, [{ id: 'guide-body', type: 'markdown', data: { markdown: 'guide exact body', editor_mode: 'rich' } }])
    for (const [id, org] of [['news', 'platform'], ['tenant-story', 'tenant'], ['other-story', 'other']] as const) {
      await createContentDocumentWithBlocks(db, { id, organizationId: org, kind: 'article', rowRole: 'root', locale: 'en',
        title: id, slug: id, summary: id + ' summary', metadata: { collection: 'blog', category: 'Marketing' }, status: 'published', publishedAt: '2026-01-01T00:00:00.000Z', visibility: 'listed',
      }, [{ id: id + '-body', type: 'markdown', data: { markdown: id + ' exact body', editor_mode: 'rich' } }])
    }
    for (const [id, path] of [['home', '/'], ['about', '/about']]) await createContentDocumentWithBlocks(db, {
      id, organizationId: 'tenant', kind: 'page', rowRole: 'root', locale: 'en', title: id, path,
      metadata: { page_type: 'custom' },
    }, [])
    const { document: hidden } = await createContentDocumentWithBlocks(db, { id: 'hidden', organizationId: 'tenant',
      kind: 'article', rowRole: 'root', locale: 'en', title: 'Hidden', slug: 'hidden', status: 'published', publishedAt: '2026-01-01T00:00:00.000Z', visibility: 'unlisted' }, [])
    await createContentDocumentWithBlocks(db, { id: 'unpublished', organizationId: 'tenant', kind: 'article', rowRole: 'root',
      locale: 'en', title: 'Unpublished', slug: 'unpublished', status: 'draft', visibility: 'listed' }, [])
    await createContentDocumentWithBlocks(db, { id: 'story-th', organizationId: 'tenant', kind: 'article', rowRole: 'representation',
      rootId: 'tenant-story', locale: 'th', title: 'Translated story', slug: 'translated', path: '/blog/translated', summary: 'Translated summary' }, [])
    const tenantRecords = await buildTenantBlogDocuments(db)
    assert.deepEqual(tenantRecords.map(record => record.id).sort(), ['tenant-blog:other-story', 'tenant-blog:tenant-story'])
    assert(tenantRecords.find(record => record.id === 'tenant-blog:tenant-story')?.body.includes('tenant story exact body'))
    const platformRecords = await buildPlatformKnowledgeDocuments(db)
    assert(platformRecords.find(record => record.id === 'doc:guide')?.body.includes('guide exact body'))
    // The unlisted platform article stays out; the tenant's unpublished draft is absent from the tenant records above.
    assert(!platformRecords.some(record => record.id.includes(hidden.id)))
    const cards = await listSocialCardOwners(db)
    assert(cards.some(owner => owner.owner_type === 'content_document' && owner.owner_id === 'guide'))
    assert(cards.some(owner => owner.owner_type === 'content_document' && owner.owner_id === 'about'))
    assert(!cards.some(owner => owner.owner_type === 'content_document' && ['home', 'unpublished'].includes(owner.owner_id)))
    // An article belongs to one collection: the doc is read, listed and addressed only as a doc.
    assert.deepEqual((await listPublishedArticles(db, env, 'platform', 'docs', 'en')).map(row => row.id), ['guide'])
    assert.deepEqual((await listPublishedArticles(db, env, 'platform', 'blog', 'en')).map(row => row.id), ['news'])
    assert.equal((await getPublishedBlogPost(db, 'platform', 'docs', 'guide', 'en', env))?.id, 'guide')
    assert.equal(await getPublishedBlogPost(db, 'platform', 'blog', 'guide', 'en', env), null)
    // A translated list is readable only where the language is published on a Growth site.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, periodEnd) VALUES ('sub-tenant','growth','tenant','active',4102444800)").run()
    // Complete built-in routes derive their localized paths; authored pages still
    // require a published representation. The collector stores the actual visit.
    const identityInput = { organizationId: 'tenant', requestedLocale: null, themeId: 'saya-theme-v1', vertical: 'restaurant' }
    for (const path of ['/th/menu', '/th/experiences', '/th/contact', '/th/reservations']) {
      const identity = await resolvePublicPageIdentity(env, createDb(db), { ...identityInput, pagePath: path })
      assert(identity, path)
      assert.deepEqual(identity, { publicPath: path, sourcePath: path.slice(3), locale: 'th',
        locationId: null, pageId: null, documentId: null, pageType: null, recipe: null, productId: null })
      const eventId = crypto.randomUUID()
      await recordTenantPageview(db, { eventId, organizationId: 'tenant', pagePath: identity.publicPath,
        sourcePath: identity.sourcePath, locale: identity.locale, referrerHost: null, attribution: {}, internalHosts: [],
        userAgent: 'Desktop', ipHash: 'proof', sessionId: 'localized-visit', visitorId: 'localized-visitor',
        country: null, region: null, city: null, locationId: identity.locationId, pageId: identity.pageId,
        documentId: identity.documentId, pageType: identity.pageType, recipe: identity.recipe, productId: identity.productId,
        now: '2026-10-13T00:00:00.000Z' })
      assert.deepEqual(await db.prepare("SELECT page_path, payload_json ->> '$.source_path' AS source_path, payload_json ->> '$.locale' AS locale FROM analytics_events WHERE id = ?").bind(eventId).first(),
        { page_path: path, source_path: path.slice(3), locale: 'th' })
    }
    for (const path of ['/th', '/th/about', '/fr/menu', '/th/experiences/missing', '/th/unpublished']) {
      assert.equal(await resolvePublicPageIdentity(env, createDb(db), { ...identityInput, pagePath: path }), null, path)
    }
    assert.equal(await resolvePublicPageIdentity(env, createDb(db), { ...identityInput, organizationId: 'other', pagePath: '/th/menu' }), null)
    const translated = await listPublishedArticles(db, env, 'tenant', 'blog', 'th')
    assert.deepEqual(translated.map(row => [row.id, row.title, row.excerpt, row.slug]), [
      ['tenant-story', 'Translated story', 'Translated summary', 'translated'],
    ])
    const source = await db.prepare("SELECT updated_at FROM content_documents WHERE id = 'tenant-story'").first<string>('updated_at')
    assert(source)
    await updateContentDocument(db, 'tenant-story', { expected_updated_at: source, changes: { visibility: 'unlisted' } })
    assert.deepEqual(await listPublishedArticles(db, env, 'tenant', 'blog', 'th'), [])
    assert(!(await buildTenantBlogDocuments(db)).some(record => record.id === 'tenant-blog:tenant-story'))
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, [])
  } finally {
    await runtime.dispose()
  }
})
