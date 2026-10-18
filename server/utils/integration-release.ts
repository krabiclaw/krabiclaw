import { createAuth, type CloudflareEnv } from '~/server/utils/auth'
import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { IntegrationProvider } from '~/shared/organization-settings'
import type { VerifiedMetaRequest } from './meta-graph'
import { deleteIntegration, integrationsThroughAccount } from './organization-integrations'
import { publicResourceCacheInvalidationQuery } from './public-resource-cache'
import { reconcileZarazAnalytics } from './zaraz-analytics'
import { requireRecordedManagedSpend } from '~/server/domain/payments/ad-spend'

/**
 * Removing an organization's integration, and what Meta's callbacks ask for.
 *
 * An integration is the organization's selection — a GA4 property, a Search
 * Console site, a Facebook Page, an Instagram account — and the Better Auth
 * linked account it was made through, or a Discord webhook the organization
 * holds itself. Disconnecting removes the selection, and with it a Discord
 * webhook's stored token, and stops channel management; website content, the
 * user's linked account and messages already in Discord stay.
 * A verified Meta data-deletion request erases that person's provider receipts
 * and linked identity. The organization's authored posts and media stay.
 */

export type IntegrationProduct =
  | 'google-analytics'
  | 'google-search-console'
  | 'google-ads'
  | 'facebook'
  | 'instagram'
  | 'discord'

export interface ReleaseIntegrationResult {
  product: IntegrationProduct
  /** False when there was nothing connected — the call still succeeded. */
  released: boolean
}

const PROVIDER: Record<IntegrationProduct, IntegrationProvider> = {
  'google-analytics': 'google_analytics',
  'google-search-console': 'google_search_console',
  'google-ads': 'google_ads',
  'facebook': 'facebook',
  'instagram': 'instagram',
  'discord': 'discord',
}

export async function releaseIntegration(
  env: CloudflareEnv,
  organizationId: string,
  product: IntegrationProduct,
): Promise<ReleaseIntegrationResult> {
  if (product === 'google-ads') await requireRecordedManagedSpend(env.DB, organizationId)
  const released = await deleteIntegration(env.DB, organizationId, PROVIDER[product])

  // Zaraz serves the measurement id of connected sites, so losing Analytics
  // has to withdraw the tag rather than keep collecting for a tenant who
  // disconnected. The disconnect has not taken effect until it has.
  if (product === 'google-analytics' && released) await reconcileZarazAnalytics(env, env.DB)

  return { product, released }
}

/**
 * Meta ended one person's authorization of one app. Every organization
 * connected through that person's linked account loses the selection, and the
 * dead linked account is removed — Meta has already revoked it. Content stays.
 */
export async function deauthorizeMetaSubject(env: CloudflareEnv, subject: VerifiedMetaRequest): Promise<ReleaseIntegrationResult[]> {
  const context = await createAuth(env).$context
  const account = await context.internalAdapter.findAccountByKey({ providerId: subject.channel, accountId: subject.providerSubjectId })
  if (!account) return []
  const results: ReleaseIntegrationResult[] = []
  for (const organizationId of await integrationsThroughAccount(env.DB, subject.channel, account.id)) results.push(await releaseIntegration(env, organizationId, subject.channel))
  await context.internalAdapter.deleteAccount(account.id)
  return results
}

export interface MetaErasureResult {
  detached_publications: number
  remaining: number
}

/** What still names this Meta person: provider identifiers and their linked account. */
export async function remainingMetaSubjectData(env: CloudflareEnv, subject: Pick<VerifiedMetaRequest, 'channel' | 'providerAppId' | 'providerSubjectId'>): Promise<number> {
  const row = await queryFirst<{ n: number }>(env.DB, 'SELECT count(*) AS n FROM post_publications WHERE channel = ? AND provider_app_id = ? AND provider_subject_id = ?',
    [subject.channel, subject.providerAppId, subject.providerSubjectId])
  const context = await createAuth(env).$context
  const account = await context.internalAdapter.findAccountByKey({ providerId: subject.channel, accountId: subject.providerSubjectId })
  return Number(row?.n ?? 0) + (account ? 1 : 0)
}

/** Erase provider receipts and linked identity; organization-authored content stays. */
export async function eraseMetaSubjectData(env: CloudflareEnv, subject: VerifiedMetaRequest): Promise<MetaErasureResult> {
  const db = env.DB as DbClient
  await deauthorizeMetaSubject(env, subject)
  const publications = await queryAll<{ organization_id: string }>(db, `SELECT organization_id FROM post_publications
    WHERE channel = ? AND provider_app_id = ? AND provider_subject_id = ?`,
  [subject.channel, subject.providerAppId, subject.providerSubjectId])
  if (publications.length) {
    await executeBatch(db, [
      { query: 'DELETE FROM post_publications WHERE channel = ? AND provider_app_id = ? AND provider_subject_id = ?', params: [subject.channel, subject.providerAppId, subject.providerSubjectId] },
      ...[...new Set(publications.map(item => item.organization_id))].map(organizationId => publicResourceCacheInvalidationQuery(organizationId, 'meta-data-deletion')),
    ])
  }
  const remaining = await remainingMetaSubjectData(env, subject)
  if (remaining !== 0) throw new Error(`Meta data deletion left ${remaining} record(s) naming ${subject.channel} subject ${subject.providerSubjectId}`)
  return { detached_publications: publications.length, remaining }
}
