import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test, { type TestContext } from 'node:test'
import { Miniflare } from 'miniflare'

import { drainPublicResourceCacheInvalidations, purgePublicResourceCacheNow, type OrganizationChangeDrainEnv } from '../../server/utils/public-resource-cache.ts'
import { buildOrganizationDocuments, expandDocumentsForSurfaces, indexItemPayload, organizationKeySegment, syncOrganizationSearchIndex } from '../../server/utils/public-search.ts'
import { createContentDocumentWithBlocks } from '../../server/utils/content/documents.ts'
import { articleCategoryMembershipQuery, createArticleCategory } from '../../server/utils/content/article-categories.ts'
import { updateBlogLifecycle, updateBlogPost } from '../../server/utils/content/publishing.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

const searchEnv: OrganizationChangeDrainEnv = {
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://krabiclaw.com',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.com',
  AI_SEARCH_INSTANCE_ID: 'test-index',
  AI_SEARCH: {
    get: () => ({
      items: {
        list: async () => ({ result: [], result_info: { per_page: 50, total_count: 0 } }),
        upload: async () => ({}),
        delete: async () => ({}),
      },
    }),
  } as unknown as NonNullable<OrganizationChangeDrainEnv['AI_SEARCH']>,
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
              contents: 'export default { fetch() { return new Response("ok") } }',
            },
          },
        },
        env: {
          DB: { type: 'd1' },
          ORGANIZATION_CACHE: { type: 'kv' },
        },
      },
    }],
  })
  context.after(() => miniflare.dispose())
  const db = await miniflare.getD1Database('DB')
  const kv = await miniflare.getKVNamespace('ORGANIZATION_CACHE')
  for (const filename of readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    const migration = readFileSync(`migrations/${filename}`, 'utf8')
    for (const statement of migration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }
  }
  await db.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Org', 'org', 'org', 'USD', 'UTC')").run()
  await db.prepare("INSERT INTO organization (id, name, slug, subdomain, theme_id, default_currency, timezone) VALUES ('platform', 'Platform', 'platform', 'platform', 'krabiclaw-theme-v1', 'USD', 'UTC')").run()
  return { db, kv }
}

async function insertInvalidation(
  db: D1Database,
  input: {
    id: string
    status: 'pending' | 'processing' | 'processed' | 'failed'
    attemptCount: number
    claimedAt?: string | null
    processedAt?: string | null
    createdAt: string
  },
) {
  await db.prepare(`
    INSERT INTO public_resource_cache_invalidations
      (id, organization_id, reason, status, attempt_count, claimed_at, processed_at, created_at)
    VALUES (?, 'org', 'test', ?, ?, ?, ?, ?)
  `).bind(input.id, input.status, input.attemptCount, input.claimedAt ?? null, input.processedAt ?? null, input.createdAt).run()
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
  const unchanged = await updateBlogPost(db, document.id, { expected_updated_at: document.updated_at, title: 'Original',
    excerpt: null, visibility: 'listed', seo_keywords: null, collection: 'blog', category_id: category.id,
    content_blocks: [{ id: 'evidence-body', type: 'markdown', data: { editor_mode: 'rich', markdown: 'Useful copy' } }],
  }, 'platform', 'editor', env)
  assert.equal(unchanged.changed, false)
  assert.equal(await db.prepare('SELECT updated_at FROM content_documents WHERE id = ?').bind(document.id).first('updated_at'), document.updated_at)
  assert.equal(await db.prepare("SELECT updated_at FROM content_blocks WHERE id = 'evidence-body'").first('updated_at'), originalBlockRevision)
  assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE event_name = 'article.updated'").first('count(*)'), 0)

  const edited = await updateBlogPost(db, document.id, { title: 'Revised', expected_updated_at: document.updated_at }, 'platform', 'editor', env)
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
  await assert.rejects(updateBlogPost(db, document.id, { title: 'Revised', expected_updated_at: document.updated_at }, 'platform', 'editor', env), { statusCode: 409 })
  const repeated = await updateBlogPost(db, document.id, { title: 'Revised', expected_updated_at: stored!.updated_at }, 'platform', 'editor', env)
  assert.equal(repeated.changed, false)
  assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE event_name = 'article.updated'").first('count(*)'), 1)

  await db.prepare("CREATE TRIGGER reject_article_evidence BEFORE INSERT ON activity_entries WHEN NEW.event_name = 'article.updated' BEGIN SELECT RAISE(ABORT, 'reject evidence'); END").run()
  await assert.rejects(updateBlogPost(db, document.id, { title: 'Must roll back', expected_updated_at: stored!.updated_at }, 'platform', 'editor', env), /reject evidence/)
  assert.equal(await db.prepare('SELECT title FROM content_documents WHERE id = ?').bind(document.id).first('title'), 'Revised')

  const publication = await updateBlogLifecycle(db, document.id, { expected_updated_at: stored!.updated_at }, 'platform', 'editor')
  assert.equal(publication.changed, true)
  assert.equal((await updateBlogLifecycle(db, document.id, { expected_updated_at: stored!.updated_at }, 'platform', 'author')).changed, false)
  const published = (await db.prepare("SELECT id, actor_user_id, payload_json FROM activity_entries WHERE event_name = 'article.published'").all<{ id: string; actor_user_id: string; payload_json: string }>()).results
  assert.equal(published.length, 1)
  assert.equal(published[0]?.actor_user_id, 'editor')
  assert.deepEqual(JSON.parse(published[0]!.payload_json).afterState, {
    status: 'published', published_at: publication.published_at, updated_at: publication.updated_at,
  })
  assert.equal(await db.prepare('SELECT status FROM content_documents WHERE id = ?').bind(document.id).first('status'), 'published')
})

test('a sync reports an accepted, unindexed item as pending instead of waiting on it', async (t) => {
  const { db } = await migratedCacheD1(t)
  await db.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('location', 'org', 'location', 'Location', 'UTC')").run()
  const records = expandDocumentsForSurfaces(await buildOrganizationDocuments(db, 'org'))
  assert.equal(records.length, 1)
  const record = records[0]!
  let lists = 0
  let uploads = 0
  const env = {
    AI_SEARCH_INSTANCE_ID: 'test-index',
    AI_SEARCH: { get: () => ({
      stats: async () => { throw new Error('instance-wide status must not block this organization') },
      items: {
        list: async () => {
          lists += 1
          return {
            result: [{ id: 'item', key: record.key, status: lists === 1 ? 'queued' : 'completed',
              metadata: lists === 1 ? null : { content_hash: indexItemPayload(record).contentHash } }],
            result_info: { per_page: 50, total_count: 1 },
          }
        },
        upload: async () => { uploads += 1 },
        delete: async () => { throw new Error('the current item must not be deleted') },
      },
    }) },
  } as unknown as CloudflareEnv

  assert.deepEqual(await syncOrganizationSearchIndex(env, db, 'org'), {
    indexed: 0, unchanged: 0, pending: 1, deleted: 0,
  })
  assert.equal(lists, 1)
  assert.equal(uploads, 0)
})

test('publishing a platform guide indexes its public pages and preserves another business’s items', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  await db.prepare("INSERT INTO user (id, name, email) VALUES ('author', 'Author', 'author@example.test')").run()
  await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('platform-en', 'platform', 'en', 1, 'published')").run()
  const category = await createArticleCategory(db, { organizationId: 'platform', collection: 'docs', name: 'Calendar and bookings', actorId: 'author' })
  const { document } = await createContentDocumentWithBlocks(db, {
    id: 'calendar-guide', organizationId: 'platform', kind: 'article', rowRole: 'root', locale: 'en',
    title: 'Connect Google Calendar', slug: 'connect-google-calendar', status: 'draft', visibility: 'listed', metadata: { collection: 'docs' },
  }, [{ id: 'calendar-body', type: 'markdown', data: { markdown: 'See your bookings in Google Calendar.', editor_mode: 'rich' } }], {
    additionalQueriesAfter: [await articleCategoryMembershipQuery(db, { organizationId: 'platform', collection: 'docs', articleId: 'calendar-guide', categoryId: category.id })],
  })
  await updateBlogLifecycle(db, document.id, { expected_updated_at: document.updated_at }, 'platform', 'author')
  const otherKey = `dashboard/${organizationKeySegment('org')}/route/other.md`
  const items = new Map<string, { id: string; key: string; status: string; metadata: Record<string, string>; content?: string }>([
    [otherKey, { id: 'other', key: otherKey, status: 'completed', metadata: {} }],
  ])
  const env: OrganizationChangeDrainEnv = {
    ...searchEnv,
    AI_SEARCH: { get: () => ({
      info: async () => ({ id: 'test' }),
      update: async () => ({}),
      stats: async () => ({ queued: 0, running: 0, outdated: 0 }),
      items: {
        list: async ({ page, per_page, search }: { page: number; per_page: number; search?: string }) => {
          const selected = [...items.values()].filter(item => !search || item.key.includes(search))
          return { result: selected.slice((page - 1) * per_page, page * per_page), result_info: { per_page, total_count: selected.length } }
        },
        upload: async (key: string, content: string, options: { metadata: Record<string, string> }) => {
          items.set(key, { id: key, key, status: 'completed', metadata: options.metadata, content })
        },
        delete: async (id: string) => {
          const item = [...items.values()].find(item => item.id === id)
          if (item) items.delete(item.key)
        },
      },
    }) } as unknown as NonNullable<OrganizationChangeDrainEnv['AI_SEARCH']>,
  }
  await drainPublicResourceCacheInvalidations(db, kv, env, {})
  const guide = [...items.values()].filter(item => item.metadata.record_id === 'doc:calendar-guide')
  assert.deepEqual(guide.map(item => item.metadata.surface).sort(), ['blog', 'chowbot', 'dashboard', 'docs', 'help', 'public'])
  for (const item of guide) {
    assert.equal(JSON.parse(item.metadata.display!).path, '/docs/connect-google-calendar')
    assert.match(item.content!, /See your bookings in Google Calendar/)
  }
  assert.equal(items.get(otherKey)?.id, 'other')
})

test('cache invalidation drain enforces the durable work lifecycle', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  await t.test('validates its domain before claiming work and purges both cache contracts', async () => {
    await insertInvalidation(db, {
      id: 'pending', status: 'pending', attemptCount: 0, createdAt: '2026-01-01T00:00:00.000Z',
    })

    await assert.rejects(
      drainPublicResourceCacheInvalidations(db, kv, { NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: undefined }, {}),
      /NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required/,
    )
    const row = await db.prepare(`
      SELECT status, attempt_count FROM public_resource_cache_invalidations WHERE id = 'pending'
    `).first<{ status: string; attempt_count: number }>()
    assert.deepEqual(row, { status: 'pending', attempt_count: 0 })
    await assert.rejects(
      drainPublicResourceCacheInvalidations(db, kv, { NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://krabiclaw.com' }, {}),
      /AI Search binding is required/,
    )
    assert.deepEqual(await db.prepare(`
      SELECT status, attempt_count FROM public_resource_cache_invalidations WHERE id = 'pending'
    `).first(), { status: 'pending', attempt_count: 0 })

    await kv.put('public~org~v4~page', 'public resource')
    await kv.put('html:org.krabiclaw.com:/', 'html')
    assert.equal(await drainPublicResourceCacheInvalidations(db, kv, searchEnv, {}), 1)
    assert.equal(await kv.get('public~org~v4~page'), null)
    assert.equal(await kv.get('html:org.krabiclaw.com:/'), null)
    const processed = await db.prepare(`
      SELECT status, attempt_count FROM public_resource_cache_invalidations WHERE id = 'pending'
    `).first<{ status: string; attempt_count: number }>()
    assert.deepEqual(processed, { status: 'processed', attempt_count: 1 })
  })
  await db.prepare('DELETE FROM public_resource_cache_invalidations').run()

  await t.test('terminates exhausted work and removes old terminal history', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z')
    const failingKv = new Proxy(kv, {
      get(target, property) {
        if (property === 'list') return async () => { throw new Error('injected KV failure') }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await insertInvalidation(db, {
      id: 'last-attempt', status: 'pending', attemptCount: 4, createdAt: '2026-09-05T11:00:00.000Z',
    })
    await insertInvalidation(db, {
      id: 'stale-exhausted', status: 'processing', attemptCount: 5,
      createdAt: '2026-09-05T10:00:00.000Z',
    })
    for (const status of ['processed', 'failed'] as const) {
      await insertInvalidation(db, {
        id: `old-${status}`, status, attemptCount: 5,
        processedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
      })
    }

    await assert.rejects(
      drainPublicResourceCacheInvalidations(db, failingKv, searchEnv, { now }),
      /injected KV failure/,
    )

    const terminal = await db.prepare(`
      SELECT id, status, attempt_count, claimed_at, processed_at, last_error
        FROM public_resource_cache_invalidations ORDER BY id
    `).all<{
      id: string
      status: string
      attempt_count: number
      claimed_at: string | null
      processed_at: string | null
      last_error: string | null
    }>()
    assert.deepEqual(terminal.results, [
      {
        id: 'last-attempt', status: 'failed', attempt_count: 5, claimed_at: null,
        processed_at: now.toISOString(), last_error: 'injected KV failure',
      },
      {
        id: 'stale-exhausted', status: 'failed', attempt_count: 5, claimed_at: null,
        processed_at: now.toISOString(), last_error: 'Retry limit reached',
      },
    ])
  })
})

test('nonproduction drains cache invalidations without AI Search', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  await insertInvalidation(db, {
    id: 'local-write', status: 'pending', attemptCount: 0, createdAt: '2026-09-29T04:00:00.000Z',
  })
  await kv.put('public~org~v4~page', 'stale public resource')
  await kv.put('html:org.krabiclaw.com:/', 'stale HTML')
  const env: OrganizationChangeDrainEnv = {
    NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://krabiclaw.com',
    NUXT_PUBLIC_PLATFORM_DOMAIN: 'http://localhost:3107',
  }
  assert.equal(await drainPublicResourceCacheInvalidations(db, kv, env, {}), 1)
  assert.equal(await kv.get('public~org~v4~page'), null)
  assert.equal(await kv.get('html:org.krabiclaw.com:/'), null)
  assert.deepEqual(await db.prepare("SELECT status, attempt_count FROM public_resource_cache_invalidations WHERE id = 'local-write'").first(),
    { status: 'processed', attempt_count: 1 })
})


test('an organization write purges that organization despite an older invalidation for another', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  await db.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('changed', 'Changed', 'changed', 'changed', 'USD', 'UTC')").run()
  await insertInvalidation(db, {
    id: 'older-other-org', status: 'pending', attemptCount: 0, createdAt: '2026-01-01T00:00:00.000Z',
  })
  for (const organization of ['org', 'changed']) {
    await kv.put(`public~${organization}~v4~page`, 'cached public resource')
    await kv.put(`html:${organization}.krabiclaw.com:/`, 'cached HTML')
  }
  await purgePublicResourceCacheNow({ DB: db, ORGANIZATION_CACHE: kv, NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://krabiclaw.com' }, 'changed')
  assert.equal(await kv.get('public~changed~v4~page'), null)
  assert.equal(await kv.get('html:changed.krabiclaw.com:/'), null)
  assert.equal(await kv.get('public~org~v4~page'), 'cached public resource')
  assert.equal(await kv.get('html:org.krabiclaw.com:/'), 'cached HTML')
  // The write clears its own organization's caches and queues the row that makes every
  // other worker converge; the queue's own bookkeeping belongs to the drainer,
  // not to a mutation's response time.
  const rows = await db.prepare('SELECT organization_id, status, attempt_count FROM public_resource_cache_invalidations ORDER BY organization_id')
    .all<{ organization_id: string; status: string; attempt_count: number }>()
  assert.deepEqual(rows.results, [
    { organization_id: 'changed', status: 'pending', attempt_count: 0 },
    { organization_id: 'org', status: 'pending', attempt_count: 0 },
  ])
  assert.equal(await drainPublicResourceCacheInvalidations(db, kv, searchEnv, {}), 2)
  assert.equal(await kv.get('public~org~v4~page'), null)
  assert.equal(await kv.get('html:org.krabiclaw.com:/'), null)
})

test('a complete fresh reconciliation clears older terminal work, but no work cannot claim to repair it', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  const now = new Date('2026-09-29T04:30:00.000Z')
  await insertInvalidation(db, {
    id: 'old-failed', status: 'failed', attemptCount: 5,
    processedAt: '2026-09-28T04:30:00.000Z', createdAt: '2026-09-28T04:00:00.000Z',
  })
  assert.equal(await drainPublicResourceCacheInvalidations(db, kv, searchEnv, { now }), 0)
  assert.equal((await db.prepare("SELECT status FROM public_resource_cache_invalidations WHERE id = 'old-failed'").first<{ status: string }>())!.status, 'failed')
  await insertInvalidation(db, {
    id: 'fresh', status: 'pending', attemptCount: 0, createdAt: '2026-09-29T04:00:00.000Z',
  })
  assert.equal(await drainPublicResourceCacheInvalidations(db, kv, searchEnv, { now }), 1)
  const rows = await db.prepare("SELECT id, status, last_error FROM public_resource_cache_invalidations ORDER BY id")
    .all<{ id: string; status: string; last_error: string | null }>()
  assert.deepEqual(rows.results, [
    { id: 'fresh', status: 'processed', last_error: null },
    { id: 'old-failed', status: 'processed', last_error: null },
  ])
})

test('a global drain reports one failed organization after processing other organizations', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  await db.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('changed', 'Changed', 'changed', 'changed', 'USD', 'UTC')").run()
  await insertInvalidation(db, {
    id: 'first', status: 'pending', attemptCount: 0, createdAt: '2026-09-29T04:00:00.000Z',
  })
  await db.prepare(`INSERT INTO public_resource_cache_invalidations
    (id, organization_id, reason, status, attempt_count, created_at)
    VALUES ('second', 'changed', 'test', 'pending', 0, '2026-09-29T04:01:00.000Z')`).run()
  await kv.put('public~changed~v4~page', 'old page')
  const failingKv = new Proxy(kv, {
    get(target, property) {
      if (property === 'list') return async (options: { prefix?: string }) => {
        if (options.prefix?.startsWith('public~org~')) throw new Error('injected org KV failure')
        return await target.list(options)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await assert.rejects(
    drainPublicResourceCacheInvalidations(db, failingKv, searchEnv, { now: new Date('2026-09-29T04:30:00.000Z') }),
    /injected org KV failure/,
  )
  assert.equal(await kv.get('public~changed~v4~page'), null)
  const rows = await db.prepare('SELECT id, status, attempt_count FROM public_resource_cache_invalidations ORDER BY id')
    .all<{ id: string; status: string; attempt_count: number }>()
  assert.deepEqual(rows.results, [
    { id: 'first', status: 'pending', attempt_count: 1 },
    { id: 'second', status: 'processed', attempt_count: 1 },
  ])
})

test('simultaneous drains cannot sync one organization out of order', async (t) => {
  const { db, kv } = await migratedCacheD1(t)
  await insertInvalidation(db, {
    id: 'first', status: 'pending', attemptCount: 0, createdAt: '2026-09-29T04:00:00.000Z',
  })
  let releaseFirst!: () => void
  let signalFirst!: () => void
  const firstEntered = new Promise<void>(resolve => { signalFirst = resolve })
  const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve })
  let providerReads = 0
  const env: OrganizationChangeDrainEnv = {
    ...searchEnv,
    AI_SEARCH: {
      get: () => ({ items: {
        list: async () => {
          providerReads += 1
          if (providerReads === 1) {
            signalFirst()
            await firstMayFinish
          }
          return { result: [], result_info: { per_page: 50, total_count: 0 } }
        },
        upload: async () => ({}),
        delete: async () => ({}),
      } }),
    } as unknown as NonNullable<OrganizationChangeDrainEnv['AI_SEARCH']>,
  }
  const now = new Date('2026-09-29T04:30:00.000Z')
  const first = drainPublicResourceCacheInvalidations(db, kv, env, { now })
  try {
    await firstEntered
    await insertInvalidation(db, {
      id: 'second', status: 'pending', attemptCount: 0, createdAt: '2026-09-29T04:01:00.000Z',
    })
    // An overlapping run leaves the site to the run holding it.
    assert.equal(await drainPublicResourceCacheInvalidations(db, kv, env, { now }), 0)
    assert.equal(providerReads, 1)
    assert.deepEqual(await db.prepare("SELECT status, attempt_count FROM public_resource_cache_invalidations WHERE id = 'second'").first(),
      { status: 'pending', attempt_count: 0 })
  } finally {
    releaseFirst()
  }
  assert.equal(await first, 1)
  // The next run syncs the later write, after the first.
  assert.equal(await drainPublicResourceCacheInvalidations(db, kv, env, { now }), 1)
  assert.equal(providerReads, 2)
  assert.deepEqual(await db.prepare('SELECT id, status FROM public_resource_cache_invalidations ORDER BY id').all().then(result => result.results),
    [{ id: 'first', status: 'processed' }, { id: 'second', status: 'processed' }])
})


test('a drain syncs search once and leaves its continuation to the next run', async (t) => {
  for (const outcome of ['completed', 'skipped'] as const) {
    await t.test(outcome, async (t) => {
      const { db, kv } = await migratedCacheD1(t)
      await db.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('first-location', 'org', 'first-location', 'First', 'UTC'), ('second-location', 'org', 'second-location', 'Second', 'UTC')").run()
      const records = expandDocumentsForSurfaces(await buildOrganizationDocuments(db, 'org'))
      assert.equal(records.length, 2)
      const [queued, missing] = records
      let lists = 0
      const uploads: string[] = []
      const env: OrganizationChangeDrainEnv = {
        ...searchEnv,
        AI_SEARCH: { get: () => ({ items: {
          list: async () => {
            lists += 1
            const result = lists === 1
              ? [{ id: 'queued', key: queued!.key, status: 'queued', metadata: null }]
              : records.map((record, index) => ({
                id: `item-${index}`, key: record.key,
                status: outcome === 'skipped' && index === 0 ? 'skipped' : 'completed',
                metadata: { content_hash: indexItemPayload(record).contentHash },
                error: outcome === 'skipped' && index === 0 ? 'unsupported document type' : null,
              }))
            return { result, result_info: { per_page: 50, total_count: result.length } }
          },
          upload: async (key: string) => { uploads.push(key) },
          delete: async () => { throw new Error('current items must not be deleted') },
        } }) } as unknown as NonNullable<OrganizationChangeDrainEnv['AI_SEARCH']>,
      }
      await insertInvalidation(db, { id: 'write', status: 'pending', attemptCount: 0, createdAt: '2026-10-02T00:00:00.000Z' })
      const continuation = async () => (await db.prepare("SELECT status, attempt_count, last_error FROM public_resource_cache_invalidations WHERE reason = 'search-sync-continue'").first<{
        status: string; attempt_count: number; last_error: string | null
      }>())!

      // One drain run: one bounded sync, the write's row processed, the rest queued.
      assert.equal(await drainPublicResourceCacheInvalidations(db, kv, env, {}), 1)
      assert.equal(lists, 1)
      assert.deepEqual(uploads, [missing!.key])
      assert.equal((await db.prepare("SELECT status FROM public_resource_cache_invalidations WHERE id = 'write'").first<{ status: string }>())!.status, 'processed')
      assert.deepEqual(await continuation(), { status: 'pending', attempt_count: 0, last_error: null })

      // The next run finishes it, or reports what the provider refused.
      if (outcome === 'completed') {
        assert.equal(await drainPublicResourceCacheInvalidations(db, kv, env, {}), 1)
        assert.deepEqual(await continuation(), { status: 'processed', attempt_count: 1, last_error: null })
      } else {
        await assert.rejects(drainPublicResourceCacheInvalidations(db, kv, env, {}), /AI Search skipped unchanged item.*unsupported document type/)
        const row = await continuation()
        assert.equal(row.status, 'pending')
        assert.equal(row.attempt_count, 1)
        assert.match(row.last_error!, /unsupported document type/)
      }
      assert.equal(lists, 2)
    })
  }
})
