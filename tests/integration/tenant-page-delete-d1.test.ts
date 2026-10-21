import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { executeBatch } from '../../server/db/index.ts'
import { createContentDocumentWithBlocks, prepareContentDocumentDeletion } from '../../server/utils/content/documents.ts'
import { buildMediaPlacementInsertQuery } from '../../server/utils/media-asset-manager.ts'
import { deleteTenantPage } from '../../server/utils/content/pages.ts'

// What deleting a tenant page takes with it, proven against real D1 rather than
// reasoned about: the scope follows the row, and the rows that reference a
// document by owner_id — media placements and redirects, which carry no foreign
// key — go with it rather than being left pointing at nothing.
test('deleting a tenant page takes its translations, placements and redirects', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'tenant-page-delete-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id,name,slug,subdomain,theme_id,vertical, default_currency, timezone) VALUES (?,?,?,?,?,?, 'USD', 'UTC')`)
      .bind('org', 'org', 'org', 'org', 'tenant-theme-v1', 'restaurant').run()
    for (const locale of ['en', 'th']) {
      await db.prepare('INSERT INTO organization_locales (id,organization_id,locale,is_source,status) VALUES (?,?,?,?,?)')
        .bind('loc-' + locale, 'org', locale, Number(locale === 'en'), 'published').run()
    }
    await db.prepare("INSERT INTO media_assets (id,organization_id,kind,provider,source,status) VALUES ('asset','org','image','cloudflare_r2','uploaded','active')").run()

    const page = async (id: string, path: string, locale: string, rootId?: string) =>
      await createContentDocumentWithBlocks(db, {
        id, organizationId: 'org', kind: 'page', locale,
        ...(rootId ? { rowRole: 'representation' as const, rootId } : { rowRole: 'root' as const, metadata: { page_type: 'custom' } }),
        path, title: id,
      }, [{ id: id + '-body', type: 'markdown', data: { markdown: id, editor_mode: 'rich' } }])

    // An unclaimed path no template maps: /our-story renders through the
    // catch-all, so it is the owner's page and theirs to remove.
    await page('story', '/our-story', 'en')
    await page('story-th', '/our-story', 'th', 'story')
    await page('keeper', '/kept', 'en')
    for (const [id, owner] of [['story-image', 'story'], ['story-th-image', 'story-th'], ['keeper-image', 'keeper']]) {
      await executeBatch(db, [buildMediaPlacementInsertQuery({
        id, organizationId: 'org', ownerType: 'content_document', ownerId: owner, slot: 'cover', assetId: 'asset', sortOrder: 0,
      })])
    }
    await db.prepare(`INSERT INTO organization_redirects (id,organization_id,locale,from_path,to_path,owner_type,owner_id)
      VALUES ('r-story','org','en','/old-story','/our-story','content_document','story'),
             ('r-th','org','th','/old-story-th','/our-story','content_document','story-th'),
             ('r-keeper','org','en','/old-kept','/kept','content_document','keeper')`).run()

    const now = await db.prepare("SELECT updated_at FROM content_documents WHERE id = 'story'").first<string>('updated_at')
    const scope = { organizationId: 'org' }
    const env = {} as Parameters<typeof deleteTenantPage>[2]['env']

    // A stale timestamp is refused, so a page edited since the read is not
    // removed out from under the other writer.
    await assert.rejects(
      deleteTenantPage(db, 'story', { scope, expectedUpdatedAt: '1999-01-01T00:00:00.000Z', env }),
      /updated by another writer/,
    )

    // The pre-check is not what protects the row: prove the batch itself refuses
    // a stale delete, which is what covers the window between reading the
    // timestamp and writing.
    await assert.rejects(executeBatch(db, prepareContentDocumentDeletion({
      documentId: 'story', organizationId: 'org', expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
    })))
    assert.equal(
      await db.prepare("SELECT count(*) AS count FROM content_documents WHERE id IN ('story','story-th')").first('count'),
      2,
      'a stale batch aborts before any document, placement or redirect is removed',
    )
    assert.equal(await db.prepare('SELECT count(*) AS count FROM media_placements').first('count'), 3)
    assert.equal(await db.prepare('SELECT count(*) AS count FROM organization_redirects').first('count'), 3)

    const result = await deleteTenantPage(db, 'story', { scope, expectedUpdatedAt: now!, env })
    assert.deepEqual(result.deleted.removed_locales, ['th'], 'the response names the translations going with the source')

    const remaining = (await db.prepare('SELECT id FROM content_documents ORDER BY id').all()).results
    assert.deepEqual(remaining, [{ id: 'keeper' }], 'the source and its translation are gone, and nothing else is')
    assert.deepEqual(
      (await db.prepare('SELECT id FROM media_placements ORDER BY id').all()).results,
      [{ id: 'keeper-image' }],
      'the translation kept no placement pointing at a deleted document',
    )
    assert.deepEqual(
      (await db.prepare('SELECT id FROM organization_redirects ORDER BY id').all()).results,
      [{ id: 'r-keeper' }],
      'the translation kept no redirect pointing at a deleted document',
    )
    assert.equal(await db.prepare('SELECT count(*) AS count FROM media_assets').first('count'), 1, 'the asset itself survives its placement')
  } finally {
    await runtime.dispose()
  }
})

test('a translation deletes alone, and a page the template renders does not delete at all', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'tenant-page-delete-scope-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id,name,slug,subdomain,theme_id,vertical, default_currency, timezone) VALUES (?,?,?,?,?,?, 'USD', 'UTC')`)
      .bind('org', 'org', 'org', 'org', 'tenant-theme-v1', 'restaurant').run()
    for (const locale of ['en', 'th']) {
      await db.prepare('INSERT INTO organization_locales (id,organization_id,locale,is_source,status) VALUES (?,?,?,?,?)')
        .bind('loc-' + locale, 'org', locale, Number(locale === 'en'), 'published').run()
    }
    const page = async (id: string, path: string, locale: string, rootId?: string) =>
      await createContentDocumentWithBlocks(db, {
        id, organizationId: 'org', kind: 'page', locale,
        ...(rootId ? { rowRole: 'representation' as const, rootId } : { rowRole: 'root' as const, metadata: { page_type: 'custom' } }),
        path, title: id,
      }, [])
    await page('story', '/our-story', 'en')
    await page('story-th', '/our-story', 'th', 'story')
    // /about is one the saya template renders, so its route would have nothing
    // to show without it.
    await page('about', '/about', 'en')

    const scope = { organizationId: 'org' }
    const env = {} as Parameters<typeof deleteTenantPage>[2]['env']
    const stamp = async (id: string) => (await db.prepare('SELECT updated_at FROM content_documents WHERE id = ?').bind(id).first<string>('updated_at'))!

    const translation = await deleteTenantPage(db, 'story-th', { scope, expectedUpdatedAt: await stamp('story-th'), env })
    assert.equal(translation.deleted.locale, 'th')
    assert.deepEqual(translation.deleted.removed_locales, [], 'deleting a translation takes nothing else')
    assert.deepEqual(
      (await db.prepare('SELECT id FROM content_documents ORDER BY id').all()).results,
      [{ id: 'about' }, { id: 'story' }],
      'the source page survives its translation being removed',
    )

    await assert.rejects(
      deleteTenantPage(db, 'about', { scope, expectedUpdatedAt: await stamp('about'), env }),
      /organization's template renders/,
    )
  } finally {
    await runtime.dispose()
  }
})

// The union on prepareContentDocumentDeletion is what keeps a caller from
// passing a document timestamp to a location deletion and believing it was
// honoured. A location deletion removes every document scoped to it, so one
// document's timestamp says nothing about the set.
// @ts-expect-error a location deletion takes no expectedUpdatedAt
void (() => prepareContentDocumentDeletion({ locationId: 'x', organizationId: 'org', expectedUpdatedAt: 'x' }))
