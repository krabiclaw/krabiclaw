
import { HTTPError, type H3Event } from 'nitro'
import { queryFirst, type DbClient } from '~/server/db'
import { oncePerRequest } from '~/server/utils/request-scope'
import { getEventContext, type HTTPEvent } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { hostnameOf, isNonProductionHost } from '~/server/utils/tenant-hosts'
import { isNonIndexableHost } from '~/server/utils/seo-policy'

export const PUBLIC_CACHE_REVISION_SQL = '(SELECT id FROM public_resource_cache_invalidations WHERE organization_id = o.id ORDER BY rowid DESC LIMIT 1)'

/** The committed change ledger owns cache generations; keep the first read for this request's writes too. */
export function publicCacheRevision(event: H3Event | HTTPEvent, db: DbClient, organizationId: string, committedRevision?: string | null): Promise<string | null> {
  return oncePerRequest(event, `public-cache-revision:${organizationId}`, async () => {
    if (committedRevision !== undefined) return committedRevision
    const row = await queryFirst<{ revision: string | null }>(db, `
      SELECT ${PUBLIC_CACHE_REVISION_SQL} AS revision
        FROM organization o WHERE o.id = ?
    `, [organizationId])
    if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
    return row.revision
  })
}

/**
 * Cached HTML references the `/_nuxt/` asset hashes of the build that rendered
 * it. Those files are replaced wholesale by the next deploy, so HTML from the
 * previous build names scripts the Assets binding no longer has — the browser
 * gets a page whose every module 400s and never hydrates.
 *
 * The build id is therefore part of the key, not a property of the value: a new
 * deploy simply misses, and no HTML can outlive the assets it points at.
 * Private non-production hosts use the same policy as public-html-cache: no
 * shared HTML entry may be read or written for them.
 */
export async function buildHtmlCacheKey(event: H3Event | HTTPEvent): Promise<string | null> {

  const request = event.req
  const cfRequest = request
  const host = cfRequest?.headers.get('host')
    ?? cfRequest?.headers.get('x-forwarded-host')
    ?? request.headers.get('host')
    ?? request.headers.get('x-forwarded-host')
  if (!host) return null
  const hostname = hostnameOf(host)
  if (isNonProductionHost(hostname) || isNonIndexableHost(hostname)) return null
  const buildId = useRuntimeConfig().app?.buildId
  if (!buildId) return null
  const path = 'path' in event ? event.path : new URL(request.url).pathname
  const organizationId = getEventContext(event).organizationId
  if (typeof organizationId !== 'string' || !organizationId) return null
  const db = (request.runtime?.cloudflare?.env as { DB?: DbClient } | undefined)?.DB
  if (!db) throw new Error('DB is not bound; the public cache revision cannot be read')
  const revision = await publicCacheRevision(event, db, organizationId)
  return `html:${host}:${buildId}:${encodeURIComponent(revision ?? '')}:${path}`
}

/**
 * Purge all KV-cached HTML entries for the given site hostnames.
 * Called after any mutating MCP tool call so the next browser load gets
 * fresh SSR HTML with the correct /_nuxt/ asset hashes.
 *
 * KV keys are structured as: html:<host>:<build id>:<revision>:<pathname>
 * We list by prefix html:<host>: and delete all matches, so a purge clears the
 * host's entries for every build id.
 */
export async function purgeOrganizationKvCache(
  kv: KVNamespace,
  hostnames: string[],
): Promise<void> {
  const deletions: Promise<void>[] = []
  for (const hostname of hostnames) {
    const prefix = `html:${hostname}:`
    let cursor: string | undefined
    do {
      const list: KVNamespaceListResult<unknown, string> = await kv.list({ prefix, cursor, limit: 100 })
      for (const key of list.keys) {
        deletions.push(kv.delete(key.name))
      }
      cursor = list.list_complete ? undefined : list.cursor
    } while (cursor)
  }
  await Promise.all(deletions)
}
