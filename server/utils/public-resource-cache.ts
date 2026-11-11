import { execute, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { purgeOrganizationKvCache } from '~/server/utils/edge-cache'
import { syncOrganizationSearchIndex } from '~/server/utils/public-search'
import { isNonProductionHost, normalizeHost } from '~/server/utils/tenant-hosts'
import { publishBusinessInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'

// KV read-through cache for public shell and page resource queries.
// Mirrors edge-cache.ts's HTML cache shape, but keyed by organizationId + resource
// params instead of host + pathname — public resources are looked up by organizationId
// directly, not by tenant hostname, so no hostname resolution is needed here.
//
// Cache key: public~<organizationId>~v21~<revision>~<contract>~<page>~<location>~<datasets>~<blogSlug>~<locale>,
// each field percent-encoded (mirrors composables/usePublicPageRequest.ts's
// usePublicResourceKey() — cached entries are never preview/draft-authorized,
// see the preview authorization guard in the shell and page services).
// Raised from 60s to 300s once every bootstrap-relevant write path was confirmed to call
// purgePublicResourceCache/purgePublicResourceCacheNow (dashboard editor routes + MCP were already
// covered; location CRUD, onboarding setup/commit, and Google Places sync were a
// gap closed alongside this change — see those call sites for purgePublicResourceCacheNow).
export const PUBLIC_RESOURCE_CACHE_TTL_SECONDS = 300

const SEARCH_SYNC_CONTINUE = 'search-sync-continue'
const CACHE_INVALIDATION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * "This site changed." One row per write, in the write's own batch, so the
 * record is atomic with the change. The drainer turns each row into whatever
 * has to follow a change to the site: its caches are cleared and its slice of
 * the search index is brought up to date.
 */
export function publicResourceCacheInvalidationQuery(
  organizationId: string,
  reason: string,
  guard: BatchQuery = { query: '1', params: [] },
): BatchQuery {
  const values = [crypto.randomUUID(), organizationId, reason, new Date().toISOString()]
  return {
    query: `INSERT INTO public_resource_cache_invalidations
      (id, organization_id, reason, status, created_at)
      SELECT ?, ?, ?, 'pending', ? WHERE (${guard.query})`,
    params: [...values, ...guard.params!],
  }
}

export type OrganizationChangeDrainEnv = Pick<CloudflareEnv, 'AI_SEARCH' | 'AI_SEARCH_INSTANCE_ID' | 'NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN' | 'NUXT_PUBLIC_PLATFORM_DOMAIN'>

/**
 * The scheduled drainer. A write purges its site's caches itself and records
 * the change; this brings each changed site's slice of the search index up to
 * date afterwards, so no write waits on AI Search. A row is processed, or it
 * failed with its reason, and the failure is reported by the task.
 */
export async function drainPublicResourceCacheInvalidations(
  db: DbClient,
  kv: KVNamespace,
  env: OrganizationChangeDrainEnv,
  options: { limit?: number; now?: Date } = {},
): Promise<number> {
  const freeOrganizationDomain = normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
  if (!freeOrganizationDomain) throw new Error('NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required')
  const productionSearch = !import.meta.dev && !isNonProductionHost(normalizeHost(env.NUXT_PUBLIC_PLATFORM_DOMAIN))
  if (productionSearch && !env.AI_SEARCH) throw new Error('Cloudflare AI Search binding is required to drain site changes')
  if (productionSearch && !env.AI_SEARCH_INSTANCE_ID?.trim()) throw new Error('AI_SEARCH_INSTANCE_ID is required to drain site changes')
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()
  const terminalRetentionCutoff = new Date(now.getTime() - CACHE_INVALIDATION_TERMINAL_RETENTION_MS).toISOString()
  // A row is processed after it is created, so the created_at bound removes
  // nothing the processed_at one keeps; it lets the status index range-scan
  // instead of reading every retained row on each two-minute run.
  await execute(db, `
    DELETE FROM public_resource_cache_invalidations
     WHERE status IN ('processed', 'failed') AND created_at < ? AND processed_at < ?
  `, [terminalRetentionCutoff, terminalRetentionCutoff])
  const rows = await queryAll<{ id: string; organization_id: string }>(db, `
    SELECT id, organization_id FROM public_resource_cache_invalidations
     WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
  `, [options.limit ?? 50])
  let processed = 0
  const failures: Error[] = []
  const failedOrganizations = new Map<string, string>()
  // Several rows for one site in one drain are one change to converge on: the
  // site's slice is listed and diffed once, and the rest of its rows ride along.
  const drainedOrganizations = new Set<string>()
  const finish = async (id: string, status: 'processed' | 'failed', error: string | null) => {
    const finalized = await execute(db, `
      UPDATE public_resource_cache_invalidations SET status = ?, processed_at = ?, last_error = ?
       WHERE id = ? AND status = 'pending'
    `, [status, nowIso, error, id])
    if (status === 'processed' && Number(finalized.meta?.changes ?? 0) === 1) processed += 1
  }
  for (const row of rows) {
    const earlier = failedOrganizations.get(row.organization_id)
    if (earlier !== undefined) {
      // The same site's change failed a moment ago in this drain; this row is that change.
      await finish(row.id, 'failed', earlier)
      continue
    }
    try {
      const firstForOrganization = !drainedOrganizations.has(row.organization_id)
      if (firstForOrganization) await purgeOrganizationCaches(db, kv, row.organization_id, freeOrganizationDomain)
      if (productionSearch && firstForOrganization) {
        const synced = await syncOrganizationSearchIndex(env as CloudflareEnv, db, row.organization_id)
        // A bounded run that left uploads behind is more of the same change, so it goes back on the queue as a new row.
        if (synced.pending > 0) {
          const more = publicResourceCacheInvalidationQuery(row.organization_id, SEARCH_SYNC_CONTINUE)
          await execute(db, more.query, more.params ?? [])
        }
      }
      drainedOrganizations.add(row.organization_id)
      await finish(row.id, 'processed', null)
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      await finish(row.id, 'failed', message)
      failures.push(error instanceof Error ? error : new Error(String(error)))
      failedOrganizations.set(row.organization_id, message)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to drain site changes for ${failedOrganizations.size} organization(s): ${failures.map(error => error.message).join('; ')}`)
  }
  return processed
}

export interface PublicResourceCacheParams {
  contract: 'shell' | 'page'
  page: string | null
  location: string | null
  datasets: readonly string[]
  blogSlug: string | null
  locale: string | undefined
}

// encodeURIComponent doesn't escape "~", so we replace it explicitly to avoid
// delimiter collisions (mirrors composables/usePublicPageRequest.ts).
const encodeKeyField = (value: string | null | undefined): string =>
  encodeURIComponent(value ?? '').replace(/~/g, '%7E')

/** The site's accepted payment methods, under the site's prefix so its purge clears them. */
export function buildPublicPaymentMethodsCacheKey(organizationId: string): string {
  return ['public', encodeKeyField(organizationId), 'v20', 'payment-methods'].join('~')
}

export function buildPublicResourceCacheKey(organizationId: string, params: PublicResourceCacheParams, revision: string | null): string {
  return [
    'public',
    encodeKeyField(organizationId),
    // v21: lodging publishes homes, with no branch aliases in the public shell.
    'v21',
    encodeKeyField(revision),
    params.contract,
    encodeKeyField(params.page),
    encodeKeyField(params.location),
    encodeKeyField([...params.datasets].sort().join(',')),
    encodeKeyField(params.blogSlug),
    encodeKeyField(params.locale),
  ].join('~')
}

export async function getPublicResourceCache(kv: KVNamespace, key: string): Promise<string | null> {
  return await kv.get(key, 'text')
}

export async function putPublicResourceCache(
  kv: KVNamespace,
  key: string,
  body: string,
  ttlSeconds: number = PUBLIC_RESOURCE_CACHE_TTL_SECONDS,
): Promise<void> {
  await kv.put(key, body, { expirationTtl: ttlSeconds })
}

/**
 * Purge all cached public resource entries for a site.
 */
/**
 * Clear both caches this site is served from: its public resource entries and
 * the HTML entries under every hostname it answers on.
 *
 * This is the purge itself, with none of the queue's bookkeeping around it —
 * the drainer wraps it in claiming and retries, and a write path calls it
 * directly so what it just wrote cannot be read back stale.
 */
export async function purgeOrganizationCaches(db: DbClient, kv: KVNamespace, organizationId: string, freeOrganizationDomainInput?: string | null): Promise<void> {
  const freeOrganizationDomain = normalizeHost(freeOrganizationDomainInput)
  const [domains, organizations] = await Promise.all([
    queryAll<{ domain: string }>(db, "SELECT domain FROM organization_domains WHERE organization_id = ? AND status = 'active'", [organizationId]),
    queryAll<{ subdomain: string | null }>(db, 'SELECT subdomain FROM organization WHERE id = ? LIMIT 1', [organizationId]),
  ])
  const hostnames = new Set<string>(domains.map(domain => domain.domain))
  const subdomain = organizations[0]?.subdomain
  if (subdomain && freeOrganizationDomain) hostnames.add(`${subdomain}.${freeOrganizationDomain}`)
  await Promise.all([purgePublicResourceCache(kv, organizationId), purgeOrganizationKvCache(kv, [...hostnames])])
}

export async function purgePublicResourceCache(kv: KVNamespace, organizationId: string): Promise<void> {
  const prefix = `public~${encodeKeyField(organizationId)}~`
  const deletions: Promise<void>[] = []
  let cursor: string | undefined
  do {
    const list: KVNamespaceListResult<unknown, string> = await kv.list({ prefix, cursor, limit: 100 })
    for (const key of list.keys) {
      deletions.push(kv.delete(key.name))
    }
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)
  await Promise.all(deletions)
}

/**
 * Convenience wrapper for call sites outside /api/editor/organizations/** and mcp.ts.
 * Records a durable invalidation before purging. The caller waits for the purge
 * so a successful write cannot be read back through a stale public cache.
 */
export async function purgePublicResourceCacheNow(
  env: unknown,
  organizationId: string,
): Promise<void> {
  const maybeEnv = env as GuestInboxPublicationEnv & {
    DB?: DbClient
    ORGANIZATION_CACHE?: KVNamespace
    NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN?: string
  } | null | undefined
  // ORGANIZATION_CACHE is bound in every environment in wrangler.toml. Returning quietly
  // when it is missing meant a deployment that had lost the binding purged
  // nothing and reported that it had, so every edit went on serving stale.
  const kv = maybeEnv?.ORGANIZATION_CACHE
  if (!kv) throw new Error('ORGANIZATION_CACHE is not bound; the public resource cache cannot be purged')
  const db = maybeEnv?.DB
  if (!db) throw new Error('DB is not bound; the public resource cache cannot be purged')

  // This request clears its own site's entries, so nothing it wrote can be
  // read back stale. Everything else — the retention sweep, retry bookkeeping,
  // claiming, the domain and site reads — belongs to the drainer, which runs
  // on its own schedule rather than inside a mutation's response time. The
  // queued row is what makes every other worker converge.
  const invalidation = publicResourceCacheInvalidationQuery(organizationId, 'write-through-purge')
  await Promise.all([
    execute(db, invalidation.query, invalidation.params),
    purgeOrganizationCaches(db, kv, organizationId, maybeEnv.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN),
  ])
  await publishBusinessInvalidation(maybeEnv, organizationId)
}
