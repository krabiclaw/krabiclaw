import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Miniflare } from 'miniflare'

import { drainPublicResourceCacheInvalidations, purgePublicResourceCacheNow, type OrganizationChangeDrainEnv } from '../../server/utils/public-resource-cache.ts'
import { createContentDocumentWithBlocks } from '../../server/utils/content/documents.ts'
import { articleCategoryMembershipQuery, createArticleCategory } from '../../server/utils/content/article-categories.ts'
import { updateBlogLifecycle, updateBlogPost } from '../../server/utils/content/publishing.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { bindDatabaseEvents } from '../../server/db/index.ts'
import { consumeEvent } from '../../server/events.ts'
import { RETENTION_HUB, runDueBusinessWork } from '../../server/domain/due-business-work.ts'
import { captureEvents } from './support/events.ts'
import { applySchema } from './support/schema.ts'

const cacheEnv: OrganizationChangeDrainEnv = {
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://blawby.com',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://blawby.com',
}

async function migratedCacheD1(context: TestContext) {
  const miniflare = new Miniflare({
    workers: [{
      config: {
        name: 'public-resource-cache-test',
        compatibilityDate: '2024-11-01',
        manifest: {
          mainModule: 'index.mjs',
          modules: {
            'index.mjs': {
              type: 'esm',
              contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }',
            },
          },
        },
        exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
        env: {
          DB: { type: 'd1' },
          ORGANIZATION_CACHE: { type: 'kv' },
          GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'public-resource-cache-test', exportName: 'Hub' },
        },
      },
    }],
  })
  context.after(() => miniflare.dispose())
  const db = await miniflare.getD1Database('DB')
  const kv = await miniflare.getKVNamespace('ORGANIZATION_CACHE')
  await applySchema(db)
  await db.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Org', 'org', 'org', 'USD', 'UTC')").run()
  await db.prepare("INSERT INTO organization (id, name, slug, subdomain, theme_id, default_currency, timezone) VALUES ('platform', 'Platform', 'platform', 'platform', 'blawby-theme-v1', 'USD', 'UTC')").run()
  const { GUEST_INBOX_HUBS: hubs } = await miniflare.getBindings<{ GUEST_INBOX_HUBS: DurableObjectNamespace }>()
  return { db, kv, hubs }
}

async function insertInvalidation(
  db: D1Database,
  input: {
    id: string
    status: 'pending' | 'processed' | 'failed'
    processedAt?: string | null
    createdAt: string
  },
) {
  await db.prepare(`
    INSERT INTO public_resource_cache_invalidations
      (id, organization_id, reason, status, processed_at, created_at)
    VALUES (?, 'org', 'test', ?, ?, ?)
  `).bind(input.id, input.status, input.processedAt ?? null, input.createdAt).run()
}

test('article evidence attributes meaningful persisted changes and excludes unchanged or rejected writes', async (t) => {
  const { db } = await migratedCacheD1(t)
  await db.prepare("INSERT INTO user (id, name, email) VALUES ('author', 'Author', 'author@example.test'), ('editor', 'Editor', 'editor@example.test')").run()
  await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('platform-en', 'platform', 'en', 1, 'published')").run()
  const env = { DB: db, BETTER_AUTH_SECRET: 'article-evidence-proof-secret-long-enough', BETTER_AUTH_URL: 'https://proof.example',
    STRIPE_SECRET_KEY: 'sk_test_no_provider_requests', PREVIEW_SECRET: 'article-preview-proof-secret',
    NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example' } as CloudflareEnv
  const category = await createArticleCategory(db, { organizationId: 'platform', collection: 'blog', name: 'News', actorId: 'author' })
  const { document } = await createContentDocumentWithBlocks(db, {
    id: 'evidence-article', organizationId: 'platform', kind: 'article', rowRole: 'root', locale: 'en',
    title: 'Original', slug: 'evidence-article', status: 'draft', visibility: 'listed', authorId: 'author', metadata: { collection: 'blog' },
  }, [{ id: 'evidence-body', type: 'markdown', data: { markdown: 'Useful copy', editor_mode: 'rich' } }], {
    additionalQueriesAfter: [await articleCategoryMembershipQuery(db, { organizationId: 'platform', collection: 'blog', articleId: 'evidence-article', categoryId: category.id })],
  })
  const originalBlockRevision = await db.prepare("SELECT updated_at FROM content_blocks WHERE id = 'evidence-body'").first('updated_at')
  const unchanged = await updateBlogPost(db, document.id, { updated_at: document.updated_at, title: 'Original',
    excerpt: null, visibility: 'listed', seo_keywords: null, collection: 'blog', category_id: category.id,
    content_blocks: [{ id: 'evidence-body', type: 'markdown', data: { editor_mode: 'rich', markdown: 'Useful copy' } }],
  }, 'platform', 'editor', env)
  assert.equal(unchanged.changed, false)
  assert.equal(await db.prepare('SELECT updated_at FROM content_documents WHERE id = ?').bind(document.id).first('updated_at'), document.updated_at)
  assert.equal(await db.prepare("SELECT updated_at FROM content_blocks WHERE id = 'evidence-body'").first('updated_at'), originalBlockRevision)
  assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE event_name = 'article.updated'").first('count(*)'), 0)

  const edited = await updateBlogPost(db, document.id, { title: 'Revised', updated_at: document.updated_at }, 'platform', 'editor', env)
  assert.equal(edited.changed, true)
  const stored = await db.prepare('SELECT title, updated_at, updated_by, author_id FROM content_documents WHERE id = ?').bind(document.id).first<{ title: string; updated_at: string; updated_by: string; author_id: string }>()
  assert.equal(stored?.title, 'Revised')
  assert.equal(stored?.updated_by, 'editor')
  assert.equal(stored?.author_id, 'author')
  assert.notEqual(stored?.updated_at, document.updated_at)
  const edits = (await db.prepare("SELECT id, actor_user_id, payload_json FROM activity_entries WHERE event_name = 'article.updated'").all<{ id: string; actor_user_id: string; payload_json: string }>()).results
  assert.equal(edits.length, 1)
  assert.equal(edits[0]?.actor_user_id, 'editor')
  assert.deepEqual(JSON.parse(edits[0]!.payload_json).metadata, {
    changed_fields: ['title'], evidence_basis: 'persisted_change', public_visibility: 'unverified',
  })
  await assert.rejects(updateBlogPost(db, document.id, { title: 'Revised', updated_at: document.updated_at }, 'platform', 'editor', env), { statusCode: 409 })
  const repeated = await updateBlogPost(db, document.id, { title: 'Revised', updated_at: stored!.updated_at }, 'platform', 'editor', env)
  assert.equal(repeated.changed, false)
  assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE event_name = 'article.updated'").first('count(*)'), 1)

  await db.prepare("CREATE TRIGGER reject_article_evidence BEFORE INSERT ON activity_entries WHEN NEW.event_name = 'article.updated' BEGIN SELECT RAISE(ABORT, 'reject evidence'); END").run()
  await assert.rejects(updateBlogPost(db, document.id, { title: 'Must roll back', updated_at: stored!.updated_at }, 'platform', 'editor', env), /reject evidence/)
  assert.equal(await db.prepare('SELECT title FROM content_documents WHERE id = ?').bind(document.id).first('title'), 'Revised')

  const publication = await updateBlogLifecycle(db, document.id, { updated_at: stored!.updated_at }, 'platform', 'editor')
  assert.equal(publication.changed, true)
  assert.equal((await updateBlogLifecycle(db, document.id, { updated_at: stored!.updated_at }, 'platform', 'author')).changed, false)
  const published = (await db.prepare("SELECT id, actor_user_id, payload_json FROM activity_entries WHERE event_name = 'article.published'").all<{ id: string; actor_user_id: string; payload_json: string }>()).results
  assert.equal(published.length, 1)
  assert.equal(published[0]?.actor_user_id, 'editor')
  assert.deepEqual(JSON.parse(published[0]!.payload_json).afterState, {
    status: 'published', published_at: publication.published_at, updated_at: publication.updated_at,
  })
  assert.equal(await db.prepare('SELECT status FROM content_documents WHERE id = ?').bind(document.id).first('status'), 'published')
})

test('cache invalidation drain enforces the durable work lifecycle', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  await t.test('validates its domain before taking work and purges both cache contracts', async () => {
    await insertInvalidation(db, {
      id: 'pending', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
    })
    const change = { organizationId: 'org', invalidationId: 'pending' }

    await assert.rejects(
      drainPublicResourceCacheInvalidations(db, kv, { NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: undefined }, change),
      /NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required/,
    )
    const row = await db.prepare(`
      SELECT status FROM public_resource_cache_invalidations WHERE id = 'pending'
    `).first<{ status: string }>()
    assert.deepEqual(row, { status: 'pending' })
    await kv.put('public~org~v4~page', 'public resource')
    await kv.put('html:org.blawby.com:/', 'html')
    assert.equal(await drainPublicResourceCacheInvalidations(db, kv, cacheEnv, change), 1)
    assert.equal(await kv.get('public~org~v4~page'), null)
    assert.equal(await kv.get('html:org.blawby.com:/'), null)
    const processed = await db.prepare(`
      SELECT status FROM public_resource_cache_invalidations WHERE id = 'pending'
    `).first<{ status: string }>()
    assert.deepEqual(processed, { status: 'processed' })

    await insertInvalidation(db, { id: 'local-write', status: 'pending', createdAt: '2026-01-02T00:00:00.000Z' })
    await kv.put('public~org~v4~page', 'stale public resource')
    const local = { NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://blawby.com', NUXT_PUBLIC_PLATFORM_DOMAIN: 'http://localhost:3107' }
    assert.equal(await drainPublicResourceCacheInvalidations(db, kv, local, { organizationId: 'org', invalidationId: 'local-write' }), 1)
    assert.equal(await kv.get('public~org~v4~page'), null)
  })
  await db.prepare('DELETE FROM public_resource_cache_invalidations').run()

  await t.test('a failed drain records its reason and the retention alarm expires old receipts', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z')
    const failingKv = new Proxy(kv, {
      get(target, property) {
        if (property === 'list') return async () => { throw new Error('injected KV failure') }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await insertInvalidation(db, { id: 'changed', status: 'pending', createdAt: '2026-09-05T11:00:00.000Z' })
    for (const status of ['processed', 'failed'] as const) {
      await insertInvalidation(db, { id: `old-${status}`, status, processedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' })
    }

    await assert.rejects(
      drainPublicResourceCacheInvalidations(db, failingKv, cacheEnv, { organizationId: 'org', invalidationId: 'changed', now }),
      /injected KV failure/,
    )
    assert.equal(await db.prepare('SELECT count(*) AS n FROM public_resource_cache_invalidations').first('n'), 3)
    const result = await runDueBusinessWork({ DB: db } as CloudflareEnv, RETENTION_HUB, 'retention', now.getTime())
    assert.equal(result.next, Date.parse('2026-09-13T00:00:00.000Z'))

    const terminal = await db.prepare(`
      SELECT id, status, processed_at, last_error FROM public_resource_cache_invalidations ORDER BY id
    `).all<{ id: string; status: string; processed_at: string | null; last_error: string | null }>()
    assert.deepEqual(terminal.results, [
      { id: 'changed', status: 'failed', processed_at: now.toISOString(), last_error: 'injected KV failure' },
    ])
  })
})


test('an organization write purges that organization despite an older invalidation for another', async (t) => {
  const { db, kv, hubs } = await migratedCacheD1(t)
  await db.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('changed', 'Changed', 'changed', 'changed', 'USD', 'UTC')").run()
  await insertInvalidation(db, {
    id: 'older-other-org', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
  })
  for (const organization of ['org', 'changed']) {
    await kv.put(`public~${organization}~v4~page`, 'cached public resource')
    await kv.put(`html:${organization}.blawby.com:/`, 'cached HTML')
  }
  const queue = captureEvents()
  const env = { ...cacheEnv, DB: db, ORGANIZATION_CACHE: kv, GUEST_INBOX_HUBS: hubs, EVENTS: queue.binding, ZARAZ_ANALYTICS: 'absent' } as CloudflareEnv
  bindDatabaseEvents(db, env)
  await purgePublicResourceCacheNow(env, 'changed')
  assert.equal(await kv.get('public~changed~v4~page'), null)
  assert.equal(await kv.get('html:changed.blawby.com:/'), null)
  assert.equal(await kv.get('public~org~v4~page'), 'cached public resource')
  assert.equal(await kv.get('html:org.blawby.com:/'), 'cached HTML')
  // The write clears its own organization's caches and queues the row that makes every
  // other worker converge; the queue's own bookkeeping belongs to the drainer,
  // not to a mutation's response time.
  const rows = await db.prepare('SELECT organization_id, status FROM public_resource_cache_invalidations ORDER BY organization_id')
    .all<{ organization_id: string; status: string }>()
  assert.deepEqual(rows.results, [
    { organization_id: 'changed', status: 'pending' },
    { organization_id: 'org', status: 'pending' },
  ])
  assert.equal(queue.pending.length, 1)
  assert.match(JSON.stringify(queue.pending[0]?.body), /"organization_id":"changed"/)
  await queue.drain(env, 'site.cache_changed')
  assert.equal(await db.prepare("SELECT status FROM public_resource_cache_invalidations WHERE id = 'older-other-org'").first('status'), 'pending')
  assert.equal(await kv.get('public~org~v4~page'), 'cached public resource')
  await consumeEvent(env, { type: 'deployment.adopt_pending_work' })
  await queue.drain(env, 'site.cache_changed')
  assert.equal(await kv.get('public~org~v4~page'), null)
  assert.equal(await kv.get('html:org.blawby.com:/'), null)
})


