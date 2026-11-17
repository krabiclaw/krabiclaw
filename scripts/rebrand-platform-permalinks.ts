// Run after deploying the platform Worker, then use adopt-pending-work.mjs to
// process the cache and search invalidation. Run with --dry-run first.
import { parseArgs } from 'node:util'
import { Miniflare } from 'miniflare'
import { startRemoteProxySession, unstable_readConfig } from 'wrangler'
import { executeBatch, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import { listBlocksForDocument, prepareContentDocumentUpdate, type ContentDocumentRow } from '~/server/utils/content/documents'
import { getPersistedSourceLocale } from '~/server/utils/localization'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { collectionArticlePath, type ArticleCollection } from '~/utils/article-collections'

const platformId = 'platform'
const inventory = {
  docs: [
    'connect-krabiclaw-to-claude',
    'create-your-krabiclaw-account',
    'connect-facebook-to-krabiclaw',
    'connect-instagram-to-krabiclaw',
    'connect-your-google-account-to-krabiclaw',
    'refresh-krabiclaw-tools-in-chatgpt',
    'connect-your-accounts-to-krabiclaw',
  ],
  blog: [
    'airbnb-vrbo-and-direct-bookings-grow-your-rental-business-with-krabiclaw',
    'what-s-new-in-krabiclaw-smoother-bookings-thai-seo-claude-more',
    'krabiclaw-is-coming-to-the-chatgpt-store-why-we-built-a-website-manager-you-talk-to',
    'new-in-krabiclaw-better-analytics-guest-messaging-ai-and-business-listing-updates',
  ],
} satisfies Record<ArticleCollection, string[]>
const stagingMissing = new Set([
  inventory.docs[0],
  inventory.blog[0],
])

type Document = ContentDocumentRow & { slug: string | null; path: string | null; collection: string | null; status: string | null }
type Alias = { from_path: string; to_path: string; owner_type: string | null; owner_id: string | null; behavior: string; status_code: number }

async function planRepair(db: DbClient, staging: boolean) {
  const locale = (await getPersistedSourceLocale(db, platformId)).locale
  const documents = await queryAll<Document>(db, `SELECT id, organization_id, kind, row_role, root_id, locale,
    created_at, updated_at, slug, path, status, metadata_json ->> '$.collection' AS collection
    FROM content_documents WHERE organization_id = ? AND kind IN ('article', 'page')`, [platformId])
  const aliases = await queryAll<Alias>(db, `SELECT from_path, to_path, owner_type, owner_id, behavior, status_code
    FROM organization_redirects WHERE organization_id = ? AND locale = ?`, [platformId, locale])
  const renames = new Map<string, { slug: string; redirects: BatchQuery[] }>()
  const paths = new Map<string, string>()
  const inventoryStatus: Array<{ from: string; to: string; action: 'rename' | 'verified' | 'absent on staging' }> = []

  for (const [collection, slugs] of Object.entries(inventory) as Array<[ArticleCollection, string[]]>) {
    for (const oldSlug of slugs) {
      const slug = oldSlug.replace('krabiclaw', 'blawby')
      const from = collectionArticlePath(collection, oldSlug)
      const to = collectionArticlePath(collection, slug)
      const candidates = documents.filter(doc => doc.kind === 'article' && doc.locale === locale && (doc.slug === oldSlug || doc.slug === slug))
      if (staging && stagingMissing.has(oldSlug) && candidates.length === 0) {
        inventoryStatus.push({ from, to, action: 'absent on staging' })
        continue
      }
      const [doc] = candidates
      if (candidates.length !== 1 || !doc || doc.row_role !== 'root' || doc.collection !== collection || doc.status !== 'published' || doc.path !== null) {
        throw new Error(`Expected one published source article for ${from}, with no slug collision`)
      }
      const mirror = (value: string) => value.replace(`/${collection}/`, `/${collection}-md/`) + '.md'
      const articlePaths = [[from, to], [mirror(from), mirror(to)]] as const
      const redirectQueries: BatchQuery[] = []
      for (const [source, target] of articlePaths) {
        paths.set(source, target)
        const alias = aliases.find(entry => entry.from_path === source)
        if (aliases.some(entry => entry.from_path === target) || documents.some(entry => entry.locale === locale && (entry.path === source || entry.path === target))) {
          throw new Error(`An existing page or redirect claims ${source} or ${target}`)
        }
        if (doc.slug === slug) {
          if (alias?.to_path !== target || alias.owner_type !== 'content_document' || alias.owner_id !== doc.id || alias.behavior !== 'redirect' || alias.status_code !== 301) {
            throw new Error(`The moved article has no matching permanent redirect at ${source}`)
          }
        } else {
          if (alias) throw new Error(`The historical URL already has a redirect at ${source}`)
          redirectQueries.push({
            query: `INSERT INTO organization_redirects (id, organization_id, locale, owner_type, owner_id, from_path, to_path)
              VALUES (?, ?, ?, 'content_document', ?, ?, ?)`,
            params: [crypto.randomUUID(), platformId, locale, doc.id, source, target],
          })
        }
      }
      if (doc.slug === oldSlug) renames.set(doc.id, { slug, redirects: redirectQueries })
      inventoryStatus.push({ from, to, action: doc.slug === oldSlug ? 'rename' : 'verified' })
    }
  }

  const repairPaths = (data: string) => data.replace(
    /(https?:\/\/[^\/\s"<>]+)?(\/(?:docs|blog)(?:-md)?\/[a-z0-9./-]+)/g,
    (match, origin: string | undefined, path: string) => {
      const target = paths.get(path)
      if (!target || (origin && !['https://blawby.com', 'https://krabiclaw.com'].includes(origin))) return match
      return `${origin === 'https://blawby.com' ? origin : ''}${target}`
    },
  )
  const candidateBlocks = await queryAll<{ document_id: string; data_json: string }>(db, `SELECT b.document_id, b.data_json
    FROM content_blocks b JOIN content_documents d ON d.id = b.document_id
    WHERE d.organization_id = ? AND d.kind IN ('article', 'page') AND b.data_json LIKE '%krabiclaw%'`, [platformId])
  const linkDocuments = new Set(candidateBlocks.filter(row => repairPaths(row.data_json) !== row.data_json).map(row => row.document_id))
  const queries: BatchQuery[] = []
  for (const doc of documents) {
    const rename = renames.get(doc.id)
    const editsLinks = linkDocuments.has(doc.id)
    if (!rename && !editsLinks) continue
    const originalBlocks = editsLinks ? await listBlocksForDocument(db, doc.id) : undefined
    const blocks = originalBlocks?.map(block => ({ ...block, data: JSON.parse(repairPaths(block.data_json)) as Record<string, unknown> }))
    const write = prepareContentDocumentUpdate(doc, {
      updated_at: doc.updated_at,
      blocks,
      changes: rename ? { slug: rename.slug } : undefined,
      additionalQueriesAfter: rename?.redirects,
    })
    // The editor validates blocks. This repair should change link strings only.
    if (blocks && write.blocks.some((block, index) => JSON.stringify(block.data) !== JSON.stringify(blocks[index]!.data))) {
      throw new Error(`The editor normalized unrelated block data in ${doc.slug ?? doc.path}`)
    }
    queries.push(...write.queries)
  }
  if (queries.length) queries.push(publicResourceCacheInvalidationQuery(platformId, 'platform-permalink-rebrand'))
  return { queries, inventoryStatus, linkDocuments: linkDocuments.size }
}

const { values } = parseArgs({ options: {
  staging: { type: 'boolean', default: false },
  production: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
}, strict: true })
if (values.staging === values.production) throw new Error('Pass exactly one of --staging or --production.')
const envName = values.staging ? 'staging' : undefined
const config = unstable_readConfig({ config: 'wrangler.toml', env: envName }, { hideWarnings: true })
const database = config.d1_databases.find(binding => binding.binding === 'DB')
if (!database?.database_id) throw new Error(`Missing Wrangler DB binding for ${envName ?? 'production'}`)

const session = await startRemoteProxySession({ DB: { type: 'd1', database_id: database.database_id } })
const runtime = new Miniflare({ workers: [{
  dev: { remoteProxyConnectionString: session.remoteProxyConnectionString },
  config: {
    name: 'rebrand-platform-permalinks',
    compatibilityDate: config.compatibility_date ?? '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1', id: database.database_id, dev: { remote: true } } },
  },
}] })
try {
  const db = await runtime.getD1Database('DB') as unknown as DbClient
  const plan = await planRepair(db, values.staging ?? false)
  if (!values['dry-run'] && plan.queries.length) {
    await executeBatch(db, plan.queries, { operation: 'rebrand platform article permalinks' })
    const verified = await planRepair(db, values.staging ?? false)
    if (verified.queries.length) throw new Error('Platform permalink repair did not verify after commit')
  }
  console.log(JSON.stringify({ database: database.database_name, dryRun: values['dry-run'],
    articles: plan.inventoryStatus, linkDocuments: plan.linkDocuments, statements: plan.queries.length }, null, 2))
} finally {
  await runtime.dispose()
  await session.dispose()
}
