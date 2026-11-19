import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { purgeOrganizationKvCache } from '~/server/utils/edge-cache'
import { normalizeHost, type TenantHostEnv } from '~/server/utils/tenant-hosts'
import { PLATFORM_THEME_ID } from '~/utils/site-routing'
import { publishBusinessInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import { publishEvent, type EventsEnv } from '~/server/events'
import { advanceOrganizationSocialCardRefresh, SOCIAL_CARD_REFRESH_LEASE_SECONDS, SOCIAL_CARD_REFRESH_PREFIX, type SocialCardEnv } from '~/server/utils/social-card'

// Shell and payment methods share the tenant prefix and publishing invalidation.
export const PUBLIC_RESOURCE_CACHE_TTL_SECONDS = 300

export const CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS = 7

/**
 * "This site changed." One row per write, in the write's own batch, so the
 * record is atomic with the change. The drainer clears the site caches.
 */
export function publicResourceCacheInvalidationQuery(
  organizationId: string,
  reason: string,
  guard: BatchQuery = { query: '1', params: [] },
): BatchQuery {
  const id = crypto.randomUUID()
  return {
    query: `INSERT INTO public_resource_cache_invalidations
      (id, organization_id, reason, status, created_at)
      SELECT ?, ?, ?, 'pending', ? WHERE (${guard.query})`,
    params: [id, organizationId, reason, new Date().toISOString(), ...guard.params!],
    event: { type: 'site.cache_changed', organization_id: organizationId, invalidation_id: id },
  }
}

export type OrganizationChangeDrainEnv = SocialCardEnv & EventsEnv & Pick<CloudflareEnv, 'NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN' | 'NUXT_PUBLIC_PLATFORM_DOMAIN'>

/**
 * Drain one site's committed changes. On redelivery include the failed row
 * that woke the consumer. Older rows without a message are enrolled at cutover.
 */
export async function drainPublicResourceCacheInvalidations(
  db: DbClient,
  kv: KVNamespace,
  env: OrganizationChangeDrainEnv,
  options: { organizationId: string; invalidationId: string | null; now?: Date },
): Promise<number> {
  const freeOrganizationDomain = normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
  if (!freeOrganizationDomain) throw new Error('NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required')
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()
  const { organizationId, invalidationId } = options
  const socialCardReason = `${SOCIAL_CARD_REFRESH_PREFIX}%`
  const eligible = "organization_id = ? AND reason NOT LIKE ? AND (status = 'pending' OR (status = 'failed' AND (? IS NULL OR id = ?)))"
  const scope = [organizationId, socialCardReason, invalidationId, invalidationId]
  const work = await queryFirst<{ latest: number | null; social_card_id: string | null }>(db, `
    SELECT (SELECT MAX(rowid) FROM public_resource_cache_invalidations WHERE ${eligible}) AS latest,
           (SELECT id FROM public_resource_cache_invalidations WHERE organization_id = ? AND reason LIKE ?
             AND (? IS NULL OR id = ?) AND status IN ('pending', 'processing')
             ORDER BY rowid DESC LIMIT 1) AS social_card_id
  `, [...scope, organizationId, socialCardReason, invalidationId, invalidationId])
  let processed = 0
  if (work?.latest != null) {
    const finish = (status: 'processed' | 'failed', error: string | null): BatchQuery => ({
      query: `UPDATE public_resource_cache_invalidations SET status = ?, processed_at = ?, last_error = ?
         WHERE ${eligible} AND rowid <= ?`,
      params: [status, nowIso, error, ...scope, work.latest],
    })
    try {
      await purgeOrganizationCaches(db, kv, organizationId, env)
    } catch (error) {
      await executeBatch(db, [finish('failed', (error instanceof Error ? error.message : String(error)).slice(0, 2000))])
      throw error
    }
    const [finalized] = await executeBatch(db, [finish('processed', null)], { operation: 'Finish public site changes' })
    processed = Number(finalized?.meta.changes ?? 0)
  }
  if (work?.social_card_id) {
    const id = work.social_card_id
    const { refresh, next_cursor } = await advanceOrganizationSocialCardRefresh({ db, env, organizationId, id })
    if (refresh?.id === id && refresh.status === 'failed' && refresh.error) throw new Error(refresh.error)
    if (refresh?.id === id && refresh.status === 'pending' && next_cursor === null) {
      // A redelivery can find a render still claimed. Recheck after its lease can expire.
      await publishEvent(env, { type: 'site.cache_changed', organization_id: organizationId, invalidation_id: id }, { delaySeconds: SOCIAL_CARD_REFRESH_LEASE_SECONDS + 1 })
    }
  }
  return processed
}

// encodeURIComponent doesn't escape "~", so we replace it explicitly to avoid
// delimiter collisions (mirrors composables/usePublicPageRequest.ts).
const encodeKeyField = (value: string | null | undefined): string =>
  encodeURIComponent(value ?? '').replace(/~/g, '%7E')

/** The site's accepted payment methods, under the site's prefix so its purge clears them. */
export function buildPublicPaymentMethodsCacheKey(organizationId: string): string {
  return ['public', encodeKeyField(organizationId), 'v20', 'payment-methods'].join('~')
}

export function buildPublicShellCacheKey(organizationId: string, locale: string | undefined, revision: string | null): string {
  return ['public', encodeKeyField(organizationId), 'v25', encodeKeyField(revision), 'shell', encodeKeyField(locale)].join('~')
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
export async function purgeOrganizationCaches(db: DbClient, kv: KVNamespace, organizationId: string, env: TenantHostEnv): Promise<void> {
  const freeOrganizationDomain = normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
  const [domains, sites] = await executeBatch(db, [
    { query: "SELECT domain FROM organization_domains WHERE organization_id = ? AND status = 'active'", params: [organizationId] },
    { query: 'SELECT subdomain, theme_id FROM organization WHERE id = ? LIMIT 1', params: [organizationId] },
  ], { operation: 'Read the changed site and its domains' })
  const hostnames = new Set((domains!.results as Array<{ domain: string }>).map(domain => domain.domain))
  const organization = sites!.results[0] as { subdomain: string | null; theme_id: string } | undefined
  if (organization?.subdomain && freeOrganizationDomain) hostnames.add(`${organization.subdomain}.${freeOrganizationDomain}`)
  if (organization?.theme_id === PLATFORM_THEME_ID) {
    // The platform's configured apex can move without changing the hosted
    // domain rows that keep the original address and native APIs routable.
    const platformHost = normalizeHost(env.NUXT_PUBLIC_PLATFORM_DOMAIN)
    if (!platformHost) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required to purge platform HTML')
    hostnames.add(platformHost)
  }
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
  const maybeEnv = env as GuestInboxPublicationEnv & TenantHostEnv & {
    DB?: DbClient
    ORGANIZATION_CACHE?: KVNamespace
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
  // queued row also marks the site for search indexing.
  await Promise.all([
    executeBatch(db, [publicResourceCacheInvalidationQuery(organizationId, 'write-through-purge')]),
    purgeOrganizationCaches(db, kv, organizationId, maybeEnv),
  ])
  await publishBusinessInvalidation(maybeEnv, organizationId)
}
