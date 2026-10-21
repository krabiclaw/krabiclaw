import { execute, queryAll, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { purgeOrganizationKvCache } from '~/server/utils/edge-cache'
import { syncOrganizationSearchIndex } from '~/server/utils/public-search'
import { isNonProductionHost, normalizeHost } from '~/server/utils/tenant-hosts'

// KV read-through cache for public shell and page resource queries.
// Mirrors edge-cache.ts's HTML cache shape, but keyed by organizationId + resource
// params instead of host + pathname — public resources are looked up by organizationId
// directly, not by tenant hostname, so no hostname resolution is needed here.
//
// Cache key: public~<organizationId>~v13~<contract>~<page>~<location>~<datasets>~<blogSlug>~<locale>,
// each field percent-encoded (mirrors composables/usePublicPageRequest.ts's
// usePublicResourceKey() — cached entries are never preview/draft-authorized,
// see the preview authorization guard in the shell and page services).
// Raised from 60s to 300s once every bootstrap-relevant write path was confirmed to call
// purgePublicResourceCache/purgePublicResourceCacheNow (dashboard editor routes + MCP were already
// covered; location CRUD, onboarding setup/commit, and Google Places sync were a
// gap closed alongside this change — see those call sites for purgePublicResourceCacheNow).
export const PUBLIC_RESOURCE_CACHE_TTL_SECONDS = 300

const CACHE_INVALIDATION_RETRY_AFTER_MS = 5 * 60 * 1000
const CACHE_INVALIDATION_MAX_ATTEMPTS = 5
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
): BatchQuery {
  const values = [crypto.randomUUID(), organizationId, reason, new Date().toISOString()]
  return {
    query: `INSERT INTO public_resource_cache_invalidations
      (id, organization_id, reason, status, attempt_count, created_at)
      VALUES (?, ?, ?, 'pending', 0, ?)`,
    params: values,
  }
}

export type OrganizationChangeDrainEnv = Pick<CloudflareEnv, 'AI_SEARCH' | 'AI_SEARCH_INSTANCE_ID' | 'NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN' | 'NUXT_PUBLIC_PLATFORM_DOMAIN'>

/**
 * The scheduled drainer. A write purges its site's caches itself and records
 * the change; this brings each changed site's slice of the search index up to
 * date afterwards, so no write waits on AI Search.
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
  const staleClaimCutoff = new Date(now.getTime() - CACHE_INVALIDATION_RETRY_AFTER_MS).toISOString()
  const terminalRetentionCutoff = new Date(now.getTime() - CACHE_INVALIDATION_TERMINAL_RETENTION_MS).toISOString()
  // A row is processed after it is created, so the created_at bound removes
  // nothing the processed_at one keeps; it lets the status index range-scan
  // instead of reading every retained row on each two-minute run.
  await execute(db, `
    DELETE FROM public_resource_cache_invalidations
     WHERE status IN ('processed', 'failed') AND created_at < ? AND processed_at < ?
  `, [terminalRetentionCutoff, terminalRetentionCutoff])
  await execute(db, `
    UPDATE public_resource_cache_invalidations
       SET status = 'failed', claimed_at = NULL, processed_at = ?,
           last_error = COALESCE(last_error, 'Retry limit reached')
     WHERE attempt_count >= ?
       AND (status = 'pending' OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at < ?)))
  `, [nowIso, CACHE_INVALIDATION_MAX_ATTEMPTS, staleClaimCutoff])
  const rows = await queryAll<{ id: string; organization_id: string; attempt_count: number }>(db, `
    SELECT id, organization_id, attempt_count
      FROM public_resource_cache_invalidations
     WHERE attempt_count < ?
       AND (status = 'pending' OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at < ?)))
     ORDER BY created_at ASC
     LIMIT ?
  `, [CACHE_INVALIDATION_MAX_ATTEMPTS, staleClaimCutoff, options.limit ?? 50])
  let processed = 0
  const failures: Error[] = []
  const failedOrganizations = new Set<string>()
  // Several rows for one site in one drain are one change to converge on: the
  // site's slice is listed and diffed once, and the rest of its rows ride along.
  const syncedOrganizations = new Set<string>()
  for (const row of rows) {
    if (failedOrganizations.has(row.organization_id)) continue
    // An overlapping drain holding this site's claim keeps it; the next run
    // picks up whatever that one leaves.
    const claim = await execute(db, `
      UPDATE public_resource_cache_invalidations AS current
         SET status = 'processing', claimed_at = ?, attempt_count = attempt_count + 1
       WHERE id = ? AND attempt_count = ? AND attempt_count < ?
         AND (status = 'pending' OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at < ?)))
         AND NOT EXISTS (
           SELECT 1 FROM public_resource_cache_invalidations AS other
            WHERE other.organization_id = current.organization_id AND other.id <> current.id
              AND other.status = 'processing' AND other.claimed_at >= ?
         )
    `, [nowIso, row.id, row.attempt_count, CACHE_INVALIDATION_MAX_ATTEMPTS, staleClaimCutoff, staleClaimCutoff])
    if (Number(claim.meta?.changes ?? 0) !== 1) continue
    const claimedAttemptCount = row.attempt_count + 1
    try {
      await purgeOrganizationCaches(db, kv, row.organization_id, freeOrganizationDomain)
      // Off production a row's whole work is the purge that just succeeded, so
      // the site has converged. In production it converges when a search sync
      // has uploaded everything that changed.
      let converged = !productionSearch
      if (productionSearch && !syncedOrganizations.has(row.organization_id)) {
        const synced = await syncOrganizationSearchIndex(env as CloudflareEnv, db, row.organization_id)
        syncedOrganizations.add(row.organization_id)
        // A bounded run that left uploads behind is not a failure to retry; it
        // is more of the same change, so it goes back on the queue as a new row.
        if (synced.pending > 0) {
          const more = publicResourceCacheInvalidationQuery(row.organization_id, SEARCH_SYNC_CONTINUE)
          await execute(db, more.query, more.params ?? [])
          // The new continuation carries on what an earlier, failed one could
          // not finish, so that failure is superseded rather than outstanding.
          await execute(db, `
            UPDATE public_resource_cache_invalidations
               SET status = 'processed', processed_at = ?, last_error = NULL
             WHERE organization_id = ? AND status = 'failed' AND reason = ? AND created_at < ?
          `, [nowIso, row.organization_id, SEARCH_SYNC_CONTINUE, nowIso])
        } else {
          converged = true
        }
      }
      if (converged) {
        // A converged site has done the work behind older terminal rows, which
        // the retry selector can no longer claim. Do not clear a failure created
        // after this drain began or one belonging to another site.
        await execute(db, `
          UPDATE public_resource_cache_invalidations
             SET status = 'processed', processed_at = ?, last_error = NULL
           WHERE organization_id = ? AND status = 'failed' AND created_at < ?
        `, [nowIso, row.organization_id, nowIso])
      }
      const finalized = await execute(db, `
        UPDATE public_resource_cache_invalidations
           SET status = 'processed', processed_at = ?, last_error = NULL
         WHERE id = ? AND status = 'processing' AND claimed_at = ? AND attempt_count = ?
      `, [nowIso, row.id, nowIso, claimedAttemptCount])
      if (Number(finalized.meta?.changes ?? 0) === 1) processed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = claimedAttemptCount >= CACHE_INVALIDATION_MAX_ATTEMPTS
      await execute(db, `
        UPDATE public_resource_cache_invalidations
           SET status = ?, claimed_at = NULL, processed_at = ?, last_error = ?
         WHERE id = ? AND status = 'processing' AND claimed_at = ? AND attempt_count = ?
      `, [failed ? 'failed' : 'pending', failed ? nowIso : null, message.slice(0, 2000), row.id, nowIso, claimedAttemptCount])
      failures.push(error instanceof Error ? error : new Error(String(error)))
      failedOrganizations.add(row.organization_id)
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
  return ['public', encodeKeyField(organizationId), 'v13', 'payment-methods'].join('~')
}

export function buildPublicResourceCacheKey(organizationId: string, params: PublicResourceCacheParams): string {
  return [
    'public',
    encodeKeyField(organizationId),
    // v13: payloads name the site's template as tenant or platform.
    'v13',
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
  const maybeEnv = env as {
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
}
