// One-time backfill of canonical recipe pages (/qa and /reviews) for existing
// organizations created before recipe pages were seeded as document records.
//
// Usage:
//   yarn db:recipe-pages --staging --dry-run
//   yarn db:recipe-pages --staging
//   yarn db:recipe-pages --production --dry-run
//   yarn db:recipe-pages --production
import { parseArgs } from 'node:util'
import { Miniflare } from 'miniflare'
import { startRemoteProxySession, unstable_readConfig } from 'wrangler'
import { queryAll, type DbClient } from '../server/db/index.ts'
import { createTenantPagesBatch } from '../server/utils/content/pages.ts'
import { getPersistedSourceLocale } from '../server/utils/localization.ts'
import { platformLocale } from '../shared/platform-locales.ts'
import type { OrganizationVertical } from '../utils/vertical-copy.ts'

const { values } = parseArgs({
  options: {
    staging: { type: 'boolean', default: false },
    production: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
})

if (values.staging === values.production) throw new Error('Pass exactly one of --staging or --production.')
const dryRun = values['dry-run']

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

async function backfill(db: DbClient, env: CloudflareEnv) {
  const orgs = await queryAll<{ id: string; name: string; vertical: OrganizationVertical }>(
    db,
    "SELECT id, name, vertical FROM organization WHERE id <> 'platform' ORDER BY id",
  )

  const report: Array<{ organizationId: string; name: string; addedPages: string[] }> = []

  for (const org of orgs) {
    const existing = await queryAll<{ path: string }>(
      db,
      "SELECT path FROM content_documents WHERE organization_id = ? AND kind = 'page' AND row_role = 'root'",
      [org.id],
    )
    const existingPaths = new Set(existing.map(p => p.path))

    const source = await getPersistedSourceLocale(db, org.id)
    const catalog = platformLocale(source.locale)
    if (!catalog) continue

    const pageTitle = (key: string) => catalog.messages[`site_pages.${key}`] || key

    const recipeDefs: Array<{ path: string; title: string; recipe: string; blockType: string; blockTitle: string }> = [
      { path: '/qa', title: pageTitle('qa'), recipe: 'qa', blockType: 'faq', blockTitle: 'Q&A' },
      { path: '/reviews', title: pageTitle('reviews'), recipe: 'reviews', blockType: 'testimonial_grid', blockTitle: 'Reviews' },
    ]

    const pagesToCreate: Array<{
      data: {
        locale: string
        path: string
        title: string
        page_type: 'recipe'
        recipe: string
        blocks: Array<{ id: string; type: string; position: number; data: Record<string, unknown> }>
      }
      trustedSystemPage: boolean
    }> = []

    const added: string[] = []

    for (const def of recipeDefs) {
      if (existingPaths.has(def.path)) continue
      added.push(def.path)
      pagesToCreate.push({
        trustedSystemPage: true,
        data: {
          locale: source.locale,
          path: def.path,
          title: def.title,
          page_type: 'recipe',
          recipe: def.recipe,
          blocks: [
            {
              id: uid('block'),
              type: 'hero',
              position: 0,
              data: { title: def.title, subtitle: null },
            },
            {
              id: uid('block'),
              type: def.blockType,
              position: 1,
              data: def.blockType === 'faq'
                ? { title: def.blockTitle, source: 'organization_qa' }
                : { title: def.blockTitle },
            },
          ],
        },
      })
    }

    if (pagesToCreate.length > 0) {
      report.push({ organizationId: org.id, name: org.name, addedPages: added })
      if (!dryRun) {
        await createTenantPagesBatch(db, {
          env,
          organizationId: org.id,
          pages: pagesToCreate,
        })
      }
    }
  }

  return {
    totalOrganizations: orgs.length,
    organizationsUpdated: report.length,
    details: report,
  }
}

const envName = values.staging ? 'staging' : undefined
const config = unstable_readConfig({ config: 'wrangler.toml', env: envName }, { hideWarnings: true })
const database = config.d1_databases.find((b: { binding: string }) => b.binding === 'DB')
if (!database?.database_id) throw new Error(`wrangler.toml has no DB database_id for ${envName ?? 'production'}`)

const session = await startRemoteProxySession({ DB: { type: 'd1', database_id: database.database_id } })
const runtime = new Miniflare({
  workers: [{
    dev: { remoteProxyConnectionString: session.remoteProxyConnectionString },
    config: {
      name: 'backfill-recipe-pages',
      compatibilityDate: config.compatibility_date ?? '2024-11-01',
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
      env: { DB: { type: 'd1', id: database.database_id, dev: { remote: true } } },
    },
  }],
})
try {
  const db = await runtime.getD1Database('DB')
  const env = { DB: db } as unknown as CloudflareEnv
  const result = await backfill(db as unknown as DbClient, env)
  console.log(`Recipe pages on ${database.database_name}${dryRun ? ' (dry run, nothing written)' : ''}:\n`, JSON.stringify(result, null, 2))
} finally {
  await runtime.dispose()
  await session.dispose()
}
