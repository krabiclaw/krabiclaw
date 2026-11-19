import { HTTPError } from 'nitro'
import { accountActivityPath, isAccountActivityPath, type AccountActivityKind } from '~/shared/account-activity'
import { accountReservationPath } from '~/shared/messages-contract'
import { buyerRequestActivityPath } from '~/server/domain/payments/buyer'
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

/**
 * The organization's dashboard, which every member alert opens somewhere
 * inside. A destination that cannot be named fails the alert with the field
 * that is missing; an alert is never sent pointing somewhere generic instead.
 */
export async function resolveDashboardSlugs(
  env: CloudflareEnv,
  db: DbClient,
  opts: { organizationId: string; locationId?: string | null },
): Promise<DashboardSlugs> {
  const organization = await findOrganizationById(env, opts.organizationId)
  if (!organization) throw destinationUnavailable('organization_id', opts.organizationId)

  let locationSlug: string | null = null
  if (opts.locationId) {
    const location = await queryFirst<{ slug: string }>(db, `
        SELECT slug FROM business_locations WHERE id = ? AND organization_id = ? LIMIT 1
      `, [opts.locationId, opts.organizationId])
    if (!location?.slug) throw destinationUnavailable('location_id', opts.locationId)
    locationSlug = location.slug
  }

  return { orgSlug: organization.slug, locationSlug }
}

export function destinationUnavailable(field: string, value: string): HTTPError {
  return new HTTPError({ statusCode: 500, message: `The notification has no dashboard destination: ${field} ${value} cannot be resolved`, data: { code: 'NOTIFICATION_DESTINATION_UNAVAILABLE', field, value } })
}

export function platformOrigin(env: DashboardNotificationLinkEnv): string {
  const origin = new URL(env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '')
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN must be an HTTP or HTTPS URL')
  return origin.origin
}

/** Account links are authorized by the reader's ordinary session. */
export function composeBuyerActivityUrl(env: DashboardNotificationLinkEnv, kind: AccountActivityKind, id: string): string {
  const path = kind === 'booking' || kind === 'stay'
    ? accountReservationPath(id)
    : accountActivityPath(kind, id)
  return new URL(path, platformOrigin(env)).href
}

/** Omit account management for unowned/imported records; never guess a buyer or visit. */
export async function buildBuyerRequestActivityUrl(env: DashboardNotificationLinkEnv, db: DbClient, opts: { organizationId: string; threadId: string }): Promise<string | null> {
  const path = await buyerRequestActivityPath(db, { organizationId: opts.organizationId, conversationId: opts.threadId })
  return buyerRequestActivityUrl(env, path, opts.threadId)
}

export function buyerRequestActivityUrl(env: DashboardNotificationLinkEnv, path: string | null, threadId: string): string | null {
  if (path === accountActivityPath('booking', threadId)) return composeBuyerActivityUrl(env, 'booking', threadId)
  if (path === accountActivityPath('stay', threadId)) return composeBuyerActivityUrl(env, 'stay', threadId)
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
): Promise<string> {
  return composeOwnerThreadInboxUrl(env, await resolveDashboardSlugs(env, db, opts), opts.threadId)
}
