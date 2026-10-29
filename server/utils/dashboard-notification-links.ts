import { accountActivityPath, isAccountActivityPath, type AccountActivityKind } from '~/shared/account-activity'
import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
import { REQUEST_CURRENT_BUYER_SQL } from '~/server/domain/requests'
import { queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { findOrganizationById } from '~/server/utils/member-access'

export interface DashboardNotificationLinkEnv {
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
}

export function getPlatformDomain(env: DashboardNotificationLinkEnv): string {
  const domain = env.NUXT_PUBLIC_PLATFORM_DOMAIN?.trim()
  if (!domain) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export interface DashboardSlugs {
  orgSlug: string
  locationSlug: string | null
}

// Thread deep links are scope-sensitive: organization-wide records go to the
// dashboard inbox, while location-assigned records go to that location's.
export async function resolveDashboardSlugs(
  env: CloudflareEnv,
  db: DbClient,
  opts: { organizationId: string; locationId?: string | null },
): Promise<DashboardSlugs | null> {
  const organization = await findOrganizationById(env, opts.organizationId)
  if (!organization) return null

  let locationSlug: string | null = null
  if (opts.locationId) {
    const location = await queryFirst<{ slug: string }>(db, `
        SELECT slug FROM business_locations WHERE id = ? AND organization_id = ? LIMIT 1
      `, [opts.locationId, opts.organizationId])
    locationSlug = location?.slug ?? null
    if (!locationSlug) return null
  }

  return { orgSlug: organization.slug, locationSlug }
}

export function platformOrigin(env: DashboardNotificationLinkEnv): string {
  const origin = new URL(env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '')
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN must be an HTTP or HTTPS URL')
  return origin.origin
}

/** An account activity link carries no guest capability; the ordinary session owns access. */
export function composeBuyerActivityUrl(env: DashboardNotificationLinkEnv, kind: AccountActivityKind, id: string): string {
  return new URL(accountActivityPath(kind, id), platformOrigin(env)).href
}

/** Omit account management for unowned/imported records; never guess a buyer or visit. */
export async function buildBuyerRequestActivityUrl(env: DashboardNotificationLinkEnv, db: DbClient, opts: { organizationId: string; threadId: string }): Promise<string | null> {
  const owner = await queryFirst<{ user_id: string }>(db, `SELECT r.user_id FROM requests r WHERE r.id=? AND r.organization_id=? AND r.kind IN ('booking','reservation','stay') AND ${REQUEST_CURRENT_BUYER_SQL}`, [opts.threadId, opts.organizationId])
  if (!owner) return null
  const path = await buyerRequestActivityPath(db, owner.user_id, opts.threadId)
  return isAccountActivityPath(path) ? new URL(path, platformOrigin(env)).href : null
}

export function dashboardOrigin(env: DashboardNotificationLinkEnv, slugs: DashboardSlugs): string {
  return `${platformOrigin(env)}/dashboard/${encodeURIComponent(slugs.orgSlug)}`
}

export function composeOwnerThreadInboxUrl(
  env: DashboardNotificationLinkEnv,
  slugs: DashboardSlugs,
  threadId: string,
): string {
  // One inbox per organization: a thread opens there whichever location it
  // belongs to.
  return `${dashboardOrigin(env, slugs)}/messages/${encodeURIComponent(threadId)}`
}

export async function buildOwnerThreadInboxUrl(
  env: DashboardNotificationLinkEnv & CloudflareEnv,
  db: DbClient,
  opts: { organizationId: string; locationId?: string | null; threadId: string },
): Promise<string | null> {
  const slugs = await resolveDashboardSlugs(env, db, opts)
  return slugs ? composeOwnerThreadInboxUrl(env, slugs, opts.threadId) : null
}
