import { retainPaymentsForTenantDeletion } from '~/server/domain/payments/retention'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import type { CloudflareEnv } from '~/server/utils/auth'
import { deleteImage } from '~/server/utils/cloudflare-images'
import { deleteOrganizationCustomDomains } from '~/server/utils/domains'
import { stageCalendarOrganizationCleanup } from '~/server/utils/google-calendar'
import { organizationAdapter, resolveOrganizationMembership } from '~/server/utils/member-access'

/**
 * Cloudflare Images this organization is the last holder of. An image id shared
 * with another organization (an import can reuse one) stays.
 */
async function ownedImageIds(db: DbClient, organizationId: string): Promise<string[]> {
  const owned = await queryAll<{ cloudflare_image_id: string }>(db, `
    SELECT DISTINCT cloudflare_image_id FROM media_assets
    WHERE organization_id = ? AND cloudflare_image_id IS NOT NULL
  `, [organizationId])
  const imageIds = (owned || []).map(row => row.cloudflare_image_id)
  if (imageIds.length === 0) return []

  const shared = await queryAll<{ cloudflare_image_id: string }>(db, `
    SELECT DISTINCT cloudflare_image_id FROM media_assets
    WHERE organization_id <> ?
      AND cloudflare_image_id IN (SELECT value FROM json_each(?))
  `, [organizationId, d1JsonStringSet(imageIds)])
  const sharedIds = new Set((shared || []).map(row => row.cloudflare_image_id))
  return imageIds.filter(imageId => !sharedIds.has(imageId))
}

/**
 * KrabiClaw-specific cleanup Better Auth cannot perform.
 *
 * The Better Auth organization lifecycle owns authorization, subscription
 * gating and the organization/member deletion itself. This function only
 * releases the Channex and Cloudflare resources D1 cannot cascade to. The organization's
 * rows, including its integration selections and imported content, go with the
 * organization through the schema's ON DELETE CASCADE. Provider credentials are
 * the user's Better Auth linked accounts and are not the organization's to
 * release. Any cleanup failure propagates and aborts the Better Auth deletion.
 */
export async function cleanupOrganizationBeforeDelete(
  env: CloudflareEnv,
  organizationId: string,
  userId: string,
): Promise<void> {
  const db = env.DB
  await retainPaymentsForTenantDeletion(db, organizationId)
  // Its Airbnb channel, Channex properties and group go first: a failure there
  // keeps the organization, so nothing in Channex outlives it unowned.
  const { AirbnbConnection } = await import('~/server/integrations/channex/airbnb-connection')
  await new AirbnbConnection(db, env, organizationId, userId).deleteForOrganization()
  await stageCalendarOrganizationCleanup(db, organizationId)
  await deleteOrganizationCustomDomains(env, db, organizationId)

  for (const imageId of await ownedImageIds(db, organizationId)) {
    await deleteImage(env, imageId)
  }
}

/**
 * What the draft claimed, and therefore what abandoning it has to give back:
 * `nothing` when the draft never got as far as creating either.
 */
export type AbandonedDraftTenantOutcome =
  | { removed: 'organization' | 'nothing' }
  | { refused: 'organization_is_live' | 'not_owner' | 'delete_incomplete' | 'draft_changed' }

/**
 * Abandoning an onboarding draft is an internal token-scoped cleanup rather
 * than the signed-in organization-delete product action. It still reuses the
 * same KrabiClaw resource cleanup before removing the Better Auth organization.
 */
export async function deleteAbandonedDraftTenant(
  env: CloudflareEnv,
  claim: { draftId: string; updatedAt: string; organizationId: string; subdomain: string; userId: string },
): Promise<AbandonedDraftTenantOutcome> {
  const db = env.DB
  const { organizationId, subdomain, userId } = claim

  const draft = await queryFirst<{ id: string; subdomain: string | null; onboarding_status: string }>(db, 'SELECT id, subdomain, onboarding_status FROM organization WHERE id = ? LIMIT 1', [organizationId])
  if (!draft) return { removed: 'nothing' }
  if (draft.subdomain !== null && draft.subdomain !== subdomain) return { refused: 'draft_changed' }
  if (draft.onboarding_status === 'active') return { refused: 'organization_is_live' }
  if (!['pending', 'failed'].includes(draft.onboarding_status)) return { refused: 'draft_changed' }
  const membership = await resolveOrganizationMembership(env, { organizationId, userId })
  if (membership?.role !== 'owner') return { refused: 'not_owner' }
  const abandoned = await queryFirst<{ id: string }>(db, "SELECT id FROM onboarding_drafts WHERE id = ? AND user_id = ? AND organization_id = ? AND subdomain_candidate = ? AND status = 'abandoned' AND updated_at = ?", [claim.draftId, userId, organizationId, subdomain, claim.updatedAt])
  if (!abandoned) return { refused: 'draft_changed' }

  await cleanupOrganizationBeforeDelete(env, organizationId, userId)
  const current = await queryFirst<{ id: string }>(db, "SELECT d.id FROM onboarding_drafts d JOIN organization o ON o.id = d.organization_id WHERE d.id = ? AND d.user_id = ? AND d.organization_id = ? AND d.status = 'abandoned' AND d.updated_at = ? AND o.onboarding_status IN ('pending', 'failed')", [claim.draftId, userId, organizationId, claim.updatedAt])
  if (!current) return { refused: 'draft_changed' }
  const adapter = await organizationAdapter(env)
  await adapter.deleteOrganization(organizationId)

  const survivor = await queryFirst<{ id: string }>(db, 'SELECT id FROM organization WHERE id = ? LIMIT 1', [organizationId])
  if (survivor) {
    console.error('tenant_deletion_draft_cascade_incomplete', { organizationId })
    return { refused: 'delete_incomplete' }
  }
  return { removed: 'organization' }
}
