import type { H3Event } from 'nitro'
import { cloudflareEnv } from '~/server/utils/api-response'
import { queryAll, type DbClient } from '~/server/db'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import { definePlugin } from 'nitro';

function pathFromLoc(input: unknown) {
  const loc = typeof input === 'string'
    ? input
    : input && typeof input === 'object' && 'loc' in input
      ? (input as { loc?: unknown }).loc
      : input && typeof input === 'object' && 'url' in input
        ? (input as { url?: unknown }).url
        : ''
  if (typeof loc !== 'string') return ''
  if (loc.startsWith('/')) return loc
  try {
    return new URL(loc).pathname
  } catch {
    return ''
  }
}

async function publishedTenantSitemapScope(db: DbClient | undefined, organizationId: string | undefined) {
  const paths = new Set<string>(), locales = new Set<string>()
  if (!db || !organizationId) return { paths, locales }
  const rows = await queryAll<{ path: string | null; locale: string; is_source: number }>(db, `
    SELECT l.locale, l.is_source, CASE WHEN l.is_source = 1 THEN d.path WHEN d.path = '/' THEN '/' || l.locale ELSE '/' || l.locale || d.path END AS path
      FROM organization_locales l LEFT JOIN content_documents d ON d.organization_id = l.organization_id AND d.locale = l.locale
        AND d.kind = 'page' AND d.row_role IN ('root','representation')
     WHERE l.organization_id = ? AND l.status = 'published'
  `, [organizationId])
  for (const row of rows) {
    if (!row.is_source) locales.add(row.locale)
    if (row.path) paths.add(row.path === '/' ? '/' : row.path.replace(/\/$/, ''))
  }
  return { paths, locales }
}

function isAllowedTenantPath(event: H3Event, path: string, scope: { paths: Set<string>; locales: Set<string> }) {
  const organization = event.context.organization as { theme?: string | null; vertical?: string | null } | undefined
  const template = resolvePublicTemplate({
    themeId: event.context.themeId as string | null | undefined,
    vertical: organization?.vertical,
  })
  const exactPaths = new Set(template.sitemap.exactPaths)
  const normalized = path === '/' ? '/' : path.replace(/\/$/, '')
  if (scope.paths.has(normalized)) return true
  const locale = normalized.split('/')[1] ?? ''
  const route = scope.locales.has(locale) ? normalized.slice(locale.length + 1) || '/' : normalized
  return exactPaths.has(route) || template.sitemap.dynamicPrefixes.some(prefix => route.startsWith(prefix))
}

export default definePlugin((nitroApp) => {
  const filterTenantUrls = async <T>(ctx: { event: H3Event; urls: T[] }) => {
    if (ctx.event.context.tenantType !== TENANT_TYPES.TENANT) return
    const env = cloudflareEnv(ctx.event)
    const scope = await publishedTenantSitemapScope(env.db, ctx.event.context.organizationId as string | undefined)
    ctx.urls = ctx.urls.filter((url) => isAllowedTenantPath(ctx.event, pathFromLoc(url), scope))
  }

  nitroApp.hooks.hook('sitemap:input', async (ctx) => {
    await filterTenantUrls(ctx)
  })

  nitroApp.hooks.hook('sitemap:resolved', async (ctx) => {
    await filterTenantUrls(ctx)
  })
})
