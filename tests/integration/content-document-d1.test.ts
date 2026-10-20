import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { HTTPError } from 'nitro'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { executeBatch } from '../../server/db/index.ts'
import { buildMediaPlacementInsertQuery } from '../../server/utils/media-asset-manager.ts'
import { createArticleCategory, updateArticleCategory } from '../../server/utils/content/article-categories.ts'
import {
  appendContentBlock, replaceContentBlock, deleteContentBlock,
  createContentDocumentWithBlocks, getContentDocumentById, listBlocksForDocument,
  prepareContentDocumentUpdate, prepareContentDocumentDeletion, updateContentDocument,
} from '../../server/utils/content/documents.ts'

test('document scopes, translations, block ownership and concurrent edits persist through real D1', async () => {
  const miniflare = new Miniflare({ workers: [{ config: {
    name: 'content-document-test', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': {
      type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }',
    } } }, env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await miniflare.getD1Database('DB')
    const empty = await generateSQLiteDrizzleJson({})
    const currentSchema = await generateSQLiteDrizzleJson(schema)
    for (const statement of await generateSQLiteMigration(empty, currentSchema)) await db.prepare(statement).run()
    for (const id of ['one', 'two']) {
      await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES (?, ?, ?, ?, 'USD', 'UTC')`).bind(id, id, id, id).run()
      for (const locale of ['en', 'th']) await db.prepare('INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, ?, ?, ?)')
        .bind(id + locale, id, locale, Number(locale === 'en'), 'published').run()
    }
    const { document } = await createContentDocumentWithBlocks(db, {
      id: 'article', organizationId: 'one', kind: 'article', rowRole: 'root', locale: 'en',
      title: 'Original', slug: 'article', status: 'published', publishedAt: '2026-01-01T00:00:00.000Z', visibility: 'listed',
    }, [{ id: 'body', type: 'markdown', data: { markdown: 'Original', editor_mode: 'rich' } }])
    const prepare = (label: string) => prepareContentDocumentUpdate(document, { expected_updated_at: document.updated_at,
      changes: { title: label, summary: label }, blocks: [{ id: 'body', type: 'markdown', data: { markdown: label, editor_mode: 'rich' } }],
    })
    await executeBatch(db, prepare('Winner').queries)
    await assert.rejects(executeBatch(db, prepare('Stale').queries))
    assert.deepEqual(await db.prepare("SELECT title, summary FROM content_documents WHERE id = 'article'").first(), { title: 'Winner', summary: 'Winner' })
    assert.equal(JSON.parse((await listBlocksForDocument(db, document.id))[0]!.data_json).markdown, 'Winner')
    const pageBlocks = [
      { id: 'page-heading', type: 'heading', position: 1001, level: 2, data: { text: 'About' } },
      { id: 'page-body', parent_block_id: 'page-heading', type: 'markdown', position: 1002, data: { markdown: 'Page copy', editor_mode: 'rich' } },
    ]
    const page = await createContentDocumentWithBlocks(db, {
      id: 'roundtrip-page', organizationId: 'one', kind: 'page', rowRole: 'root', locale: 'en', title: 'About', path: '/about', metadata: { page_type: 'custom', recipe: null },
    }, pageBlocks)
    const beforePage = await listBlocksForDocument(db, page.document.id)
    const { normalizeTenantPageBlocks } = await import('../../utils/tenant-page-blocks.ts')
    const returnedBlocks = normalizeTenantPageBlocks(beforePage.map(block => ({ ...block, data: JSON.parse(block.data_json) })))
    await updateContentDocument(db, page.document.id, {
      expected_updated_at: page.document.updated_at, changes: { title: 'About us' }, blocks: returnedBlocks,
    })
    const afterPage = await listBlocksForDocument(db, page.document.id)
    const content = (rows: typeof beforePage) => rows.map(({ updated_at, created_at, ...row }) => row)
    assert.deepEqual(content(afterPage), content(beforePage), 'a full page read/save changing only its title preserves block content, position, level and parent')

    const translated = await createContentDocumentWithBlocks(db, { id: 'translation', organizationId: 'one',
      kind: 'article', rowRole: 'representation', rootId: document.id, locale: 'th', title: 'Translated', slug: 'translated' },
    [{ id: 'translated-body', type: 'markdown', data: { markdown: 'Translated', editor_mode: 'rich' } }])
    await assert.rejects(createContentDocumentWithBlocks(db, { organizationId: 'two', kind: 'article',
      rowRole: 'representation', rootId: document.id, locale: 'th' }, []))
    await assert.rejects(createContentDocumentWithBlocks(db, { organizationId: 'one', kind: 'qa',
      rowRole: 'representation', rootId: document.id, locale: 'th' }, []))
    await assert.rejects(createContentDocumentWithBlocks(db, { organizationId: 'one', kind: 'article',
      rowRole: 'representation', rootId: translated.document.id, locale: 'th' }, []))
    await assert.rejects(updateContentDocument(db, translated.document.id, { expected_updated_at: translated.document.updated_at,
      blocks: [{ id: 'body', type: 'markdown', data: { markdown: 'Cross-document overwrite', editor_mode: 'rich' } }] }))
    await db.prepare("INSERT INTO media_assets (id,organization_id,kind,provider,source) VALUES ('shared-image','one','image','cloudflare_r2','uploaded')").run()
    const sourceLinks = await createContentDocumentWithBlocks(db, { id: 'links', organizationId: 'one',
      kind: 'page', rowRole: 'root', locale: 'en', title: 'Links', path: '/links', metadata: { recipe: 'links', page_type: 'custom' } },
    [{ id: 'link-a', type: 'cta', data: { label: 'A', url: '/a' } }, { id: 'link-b', type: 'cta', data: { label: 'B', url: '/b' } }])
    const translatedLinks = await createContentDocumentWithBlocks(db, { id: 'links-th', organizationId: 'one',
      kind: 'page', rowRole: 'representation', rootId: sourceLinks.document.id, locale: 'th', title: 'Translated links', path: '/links' },
    [{ id: 'link-a-th', source_block_id: 'link-a', type: 'cta', data: { label: 'Translated A' } },
      { id: 'translated-link-image', parent_block_id: 'link-a-th', type: 'image', data: {} }])
    await assert.rejects(updateContentDocument(db, translatedLinks.document.id, { expected_updated_at: translatedLinks.document.updated_at,
      blocks: [{ id: 'link-a-th', source_block_id: 'body', type: 'cta', data: { label: 'Wrong root' } }] }))
    const appended = await appendContentBlock(db, translatedLinks.document.id, {
      source_block_id: 'link-b', type: 'cta', data: { label: 'Translated B' },
    })
    const appendedLink = appended.blocks.find(block => block.source_block_id === 'link-b')
    assert.ok(appendedLink)
    let translatedBlocks = await listBlocksForDocument(db, translatedLinks.document.id)
    let firstLink = translatedBlocks.find(block => block.id === 'link-a-th')!
    assert.equal(firstLink.source_block_id, 'link-a')
    await replaceContentBlock(db, firstLink.id, { expected_updated_at: firstLink.updated_at, data: { label: 'Edited A' } })
    translatedBlocks = await listBlocksForDocument(db, translatedLinks.document.id)
    firstLink = translatedBlocks.find(block => block.id === 'link-a-th')!
    assert.equal(firstLink.source_block_id, 'link-a')
    const secondLink = translatedBlocks.find(block => block.id === appendedLink.id)!
    assert.equal(secondLink.source_block_id, 'link-b')
    await deleteContentBlock(db, secondLink.id, { expected_updated_at: secondLink.updated_at })
    assert.equal((await listBlocksForDocument(db, translatedLinks.document.id)).find(block => block.id === firstLink.id)?.source_block_id, 'link-a')
    await executeBatch(db, [buildMediaPlacementInsertQuery({ id: 'translated-descendant-image', organizationId: 'one',
      ownerType: 'content_block', ownerId: 'translated-link-image', slot: 'media', assetId: 'shared-image', sortOrder: 0 })])
    const beforeTypeChange = await listBlocksForDocument(db, sourceLinks.document.id)
    const beforeTranslatedTypeChange = await listBlocksForDocument(db, translatedLinks.document.id)
    await assert.rejects(updateContentDocument(db, sourceLinks.document.id, { expected_updated_at: sourceLinks.document.updated_at,
      changes: { title: 'Invalid type change' },
      blocks: [{ id: 'link-a', type: 'heading', data: { text: 'Changed type' } }] }))
    assert.deepEqual(await listBlocksForDocument(db, sourceLinks.document.id), beforeTypeChange)
    assert.deepEqual(await listBlocksForDocument(db, translatedLinks.document.id), beforeTranslatedTypeChange)
    assert.deepEqual(await getContentDocumentById(db, sourceLinks.document.id), sourceLinks.document)
    assert.equal(await db.prepare("SELECT title FROM content_documents WHERE id = 'links'").first('title'), 'Links')
    assert.equal(await db.prepare("SELECT count(*) AS count FROM media_placements WHERE id = 'translated-descendant-image'").first('count'), 1)
    await updateContentDocument(db, sourceLinks.document.id, { expected_updated_at: sourceLinks.document.updated_at,
      blocks: [{ id: 'link-b', type: 'cta', data: { label: 'B', url: '/b' } }, { id: 'link-a', type: 'cta', data: { label: 'A', url: '/new-a' } }] })
    assert.equal((await listBlocksForDocument(db, translatedLinks.document.id))[0]?.id, 'link-a-th')
    const reordered = await getContentDocumentById(db, sourceLinks.document.id)
    assert.ok(reordered)
    await updateContentDocument(db, reordered.id, { expected_updated_at: reordered.updated_at,
      blocks: [{ id: 'link-b', type: 'cta', data: { label: 'B', url: '/b' } }] })
    assert.deepEqual(await listBlocksForDocument(db, translatedLinks.document.id), [])
    assert.equal(await db.prepare("SELECT count(*) AS count FROM media_placements WHERE id = 'translated-descendant-image'").first('count'), 0)
    const unreferencedSource = await getContentDocumentById(db, sourceLinks.document.id)
    assert.ok(unreferencedSource)
    await updateContentDocument(db, unreferencedSource.id, { expected_updated_at: unreferencedSource.updated_at,
      blocks: [{ id: 'link-b', type: 'heading', data: { text: 'Unreferenced heading' } }] })
    const headingSource = await getContentDocumentById(db, sourceLinks.document.id)
    assert.ok(headingSource)
    const emptyTranslation = await getContentDocumentById(db, translatedLinks.document.id)
    assert.ok(emptyTranslation)
    await updateContentDocument(db, emptyTranslation.id, { expected_updated_at: emptyTranslation.updated_at,
      blocks: [{ id: 'heading-th', source_block_id: 'link-b', type: 'heading', data: { text: 'Translated heading' } }] })
    await assert.rejects(updateContentDocument(db, headingSource.id, { expected_updated_at: headingSource.updated_at,
      blocks: [{ id: 'link-b', type: 'markdown', data: { markdown: 'Changed type', editor_mode: 'rich' } }] }))
    await updateContentDocument(db, headingSource.id, { expected_updated_at: headingSource.updated_at,
      additionalQueriesBefore: prepareContentDocumentDeletion({ documentId: emptyTranslation.id, organizationId: 'one' }),
      blocks: [{ id: 'link-b', type: 'markdown', data: { markdown: 'Changed after removing translation', editor_mode: 'rich' } }] })
    assert.equal((await listBlocksForDocument(db, headingSource.id))[0]?.type, 'markdown')
    assert.equal(await getContentDocumentById(db, emptyTranslation.id), undefined)
    await assert.rejects(db.prepare("INSERT INTO content_documents(id,organization_id,kind,row_role,locale,summary,status,published_at,source,metadata_json) VALUES ('invalid-social','one','social_post','root','en','Body','published','2026-09-06T00:00:00.000Z','manual','{}')").run())
    for (const [id, type, owner, slot] of [['root-image', 'content_document', document.id, 'cover'],
      ['translated-image', 'content_block', 'translated-body', 'media'], ['retained-image', 'content_document', sourceLinks.document.id, 'cover']]) {
      await executeBatch(db, [buildMediaPlacementInsertQuery({ id, organizationId: 'one', ownerType: type,
        ownerId: owner, slot, assetId: 'shared-image', sortOrder: 0 })])
    }
    await assert.rejects(executeBatch(db, [buildMediaPlacementInsertQuery({ organizationId: 'two',
      ownerType: 'content_document', ownerId: document.id, slot: 'cover', assetId: 'shared-image', sortOrder: 0 })]))
    await executeBatch(db, prepareContentDocumentDeletion({ documentId: document.id, organizationId: 'one' }))
    assert.equal(await getContentDocumentById(db, translated.document.id), undefined)
    assert.deepEqual(await listBlocksForDocument(db, translated.document.id), [])
    assert.deepEqual((await db.prepare('SELECT id FROM media_placements').all()).results, [{ id: 'retained-image' }])
    assert.equal(await db.prepare('SELECT count(*) AS count FROM media_assets').first('count'), 1)
    await db.prepare("INSERT INTO business_locations (id,organization_id,slug,title, timezone) VALUES ('delete-location','one','delete','Delete', 'UTC'),('keep-location','one','keep','Keep', 'UTC')").run()
    await db.prepare("INSERT INTO media_assets (id,organization_id,kind,provider,source,status) VALUES ('retained-asset','one','image','cloudflare_r2','uploaded','active')").run()
    const deletion = prepareContentDocumentDeletion({ locationId: 'delete-location', organizationId: 'one' })
    for (const id of ['late-a', 'late-b', 'keep']) {
      await db.prepare(`INSERT INTO content_documents (id,organization_id,location_id,kind,row_role,locale,title,slug,status,visibility,published_at)
        VALUES (?,'one',?,'article','root','en',?,?,'published','listed','2026-01-01T00:00:00.000Z')`).bind(id, id === 'keep' ? 'keep-location' : 'delete-location', id, id).run()
      await db.prepare(`INSERT INTO content_documents (id,organization_id,kind,row_role,root_id,root_role,locale,title,slug)
        VALUES (?,'one','article','representation',?,'root','th',?,?)`).bind(id + '-th', id, id, id).run()
      for (const owner of [id, id + '-th']) {
        await db.prepare("INSERT INTO content_blocks (id,document_id,type,data_json) VALUES (?,?,'markdown','{}')").bind(owner + '-parent', owner).run()
        await db.prepare("INSERT INTO content_blocks (id,document_id,parent_block_id,type,data_json) VALUES (?,?,?,'image','{}')").bind(owner + '-child', owner, owner + '-parent').run()
        for (const [type, ownerId] of [['content_document', owner], ['content_block', owner + '-child']]) {
          await db.prepare("INSERT INTO media_placements (id,organization_id,owner_type,owner_id,slot,asset_id) VALUES (?,'one',?,?,'image','retained-asset')").bind(ownerId + '-media', type, ownerId).run()
          await db.prepare("INSERT INTO organization_redirects (id,organization_id,from_path,to_path,owner_type,owner_id,locale) VALUES (?,'one',?,'/target',?,?,'en')").bind(ownerId + '-redirect', '/' + ownerId, type, ownerId).run()
        }
      }
    }
    await assert.rejects(executeBatch(db, [...deletion, { query: "INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('invalid',NULL,'invalid', 'USD', 'UTC')" }]))
    assert.equal(await db.prepare("SELECT count(*) AS count FROM media_placements WHERE asset_id='retained-asset'").first('count'), 12)
    await executeBatch(db, [...deletion, { query: "DELETE FROM business_locations WHERE id='delete-location' AND organization_id='one'" }])
    assert.equal(await db.prepare("SELECT count(*) AS count FROM content_documents WHERE id LIKE 'late-%'").first('count'), 0)
    assert.equal(await db.prepare("SELECT count(*) AS count FROM content_blocks WHERE id LIKE 'late-%'").first('count'), 0)
    assert.equal(await db.prepare("SELECT count(*) AS count FROM media_placements WHERE asset_id='retained-asset'").first('count'), 4)
    assert.equal(await db.prepare("SELECT count(*) AS count FROM organization_redirects WHERE id LIKE 'late-%'").first('count'), 0)
    assert.equal(await db.prepare("SELECT count(*) AS count FROM media_assets WHERE id='retained-asset'").first('count'), 1)
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0)
  } finally {
    await miniflare.dispose()
  }
})

test('category names and hierarchy remain valid during concurrent D1 writes', async () => {
  const miniflare = new Miniflare({ workers: [{ config: {
    name: 'article-category-test', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': {
      type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }',
    } } }, env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await miniflare.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('category-org', 'Category org', 'category-org', 'USD', 'UTC')").run()
    await db.prepare("INSERT INTO user (id, name, email) VALUES ('category-author', 'Category author', 'category@example.test')").run()
    const create = (name: string, parentId?: string) => createArticleCategory(db, {
      organizationId: 'category-org', collection: 'blog', name, parentId, actorId: 'category-author',
    })
    const attempts = await Promise.allSettled([create('News'), create('news')])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = attempts.find(result => result.status === 'rejected')
    assert(rejected?.status === 'rejected')
    assert(rejected.reason instanceof HTTPError)
    assert.equal(rejected.reason.statusCode, 409)
    const persisted = (await db.prepare("SELECT id, name FROM article_categories WHERE organization_id = 'category-org' ORDER BY id").all()).results
    assert.equal(persisted.length, 1)
    assert.equal(String(persisted[0]?.name).toLowerCase(), 'news')
    assert.equal((await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = 'category-org'").first<{ n: number }>())?.n, 1)

    const other = await create('Culture')
    await assert.rejects(updateArticleCategory(db, {
      organizationId: 'category-org', categoryId: other.id, name: 'NeWs', actorId: 'category-author',
    }), (error: unknown) => {
      assert(error instanceof HTTPError)
      assert.equal(error.statusCode, 409)
      return true
    })
    assert.deepEqual((await db.prepare("SELECT name FROM article_categories WHERE organization_id = 'category-org' ORDER BY name").all()).results.map(row => row.name), ['Culture', persisted[0]?.name])
    assert.equal((await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = 'category-org'").first<{ n: number }>())?.n, 2)

    const move = (categoryId: string, parentId: string | null) => updateArticleCategory(db, {
      organizationId: 'category-org', categoryId, parentId, actorId: 'category-author',
    })
    const assertOneConflict = (results: PromiseSettledResult<unknown>[]) => {
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      const conflict = results.find(result => result.status === 'rejected')
      assert(conflict?.status === 'rejected')
      assert(conflict.reason instanceof HTTPError)
      assert.equal(conflict.reason.statusCode, 409)
    }
    const first = String(persisted[0]!.id)
    assertOneConflict(await Promise.allSettled([move(first, other.id), move(other.id, first)]))
    const parents = (await db.prepare("SELECT id, parent_id FROM article_categories WHERE organization_id = 'category-org'").all()).results
    assert.equal(parents.filter(row => row.parent_id === null).length, 1)
    assert.equal(parents.filter(row => row.parent_id !== null).length, 1)
    const nested = parents.find(row => row.parent_id !== null)!
    assert.equal(nested.parent_id, parents.find(row => row.parent_id === null)!.id)
    await move(String(nested.id), null)
    assert.equal(await db.prepare('SELECT parent_id FROM article_categories WHERE id = ?').bind(nested.id).first('parent_id'), null)

    // Both moves fit in the original tree, but together they would put Leaf at depth four.
    const branch = await create('Branch')
    const leaf = await create('Leaf', branch.id)
    const destination = await create('Destination')
    const root = await create('Root')
    assertOneConflict(await Promise.allSettled([move(branch.id, destination.id), move(destination.id, root.id)]))
    const hierarchy = (await db.prepare(`WITH RECURSIVE tree AS (
      SELECT id, 1 AS depth FROM article_categories WHERE organization_id = 'category-org' AND parent_id IS NULL
      UNION ALL
      SELECT c.id, tree.depth + 1 FROM article_categories c JOIN tree ON c.parent_id = tree.id
    ) SELECT id, depth FROM tree`).all<{ id: string; depth: number }>()).results
    assert.equal(hierarchy.length, 6, 'every category remains reachable from a root')
    assert(hierarchy.every(row => row.depth <= 3))
    assert.equal(await db.prepare('SELECT parent_id FROM article_categories WHERE id = ?').bind(leaf.id).first('parent_id'), branch.id)

    await move(destination.id, null)
    await move(branch.id, destination.id)
    assert.equal(await db.prepare('SELECT parent_id FROM article_categories WHERE id = ?').bind(branch.id).first('parent_id'), destination.id)
    await assert.rejects(move(destination.id, root.id), (error: unknown) => error instanceof HTTPError && error.statusCode === 400)
    await assert.rejects(move(destination.id, leaf.id), (error: unknown) => error instanceof HTTPError && error.statusCode === 400)
    await updateArticleCategory(db, { organizationId: 'category-org', categoryId: branch.id, name: 'Renamed branch', actorId: 'category-author' })
    assert.deepEqual(await db.prepare('SELECT name, parent_id FROM article_categories WHERE id = ?').bind(branch.id).first(), { name: 'Renamed branch', parent_id: destination.id })
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0)
  } finally {
    await miniflare.dispose()
  }
})
