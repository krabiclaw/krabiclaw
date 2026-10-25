import type { CloudflareEnv } from '~/server/utils/auth'
import { isOrganizationWideRole, listUserOrganizations, resolveUserOrganization } from '~/server/utils/member-access'
import { buyerActivities } from '~/server/domain/payments/buyer'

export type PostLoginDestination = `/dashboard/${string}`

export interface PostLoginPrincipal {
  userId: string
  // Better Auth's session-wide active organization (organization plugin,
  // POST /organization/set-active). It is the only authority for which
  // organization a browser session is in.
  activeOrganizationId: string | null
}

/**
 * Where a signed-in session belongs, and whether Better Auth has to be told
 * first.
 *
 * `activate` is the one organization a session must be switched into before it
 * lands: the caller owns that side effect because it holds the request headers.
 * `choose` is every case where more than one organization could be meant —
 * nothing here picks for the person. Sorting the list by `createdAt` and taking
 * the first entry is what this replaces (#905): it read as a decision while
 * being an accident of insertion order.
 */
export type PostLoginRoute =
  | { kind: 'enter', destination: PostLoginDestination }
  | { kind: 'activate', organizationId: string, destination: PostLoginDestination }
  | { kind: 'choose', destination: '/dashboard/select-organization' }
  | { kind: 'onboard', destination: '/dashboard/onboarding' }

function organizationDestination(organization: { id: string; slug: string; role: string }): PostLoginDestination {
  return isOrganizationWideRole(organization.role)
    ? `/dashboard/${encodeURIComponent(organization.slug)}`
    : `/dashboard/account/profile/calendar?organization_id=${encodeURIComponent(organization.id)}`
}

export async function resolvePostLoginRoute(
  env: CloudflareEnv,
  { userId, activeOrganizationId }: PostLoginPrincipal,
): Promise<PostLoginRoute> {
  if (activeOrganizationId) {
    // Membership-checked: a stale active organization the user was removed from
    // must not route them into a dashboard they can no longer open. A stale one
    // is not an error — the membership list below answers again from scratch.
    const active = await resolveUserOrganization(env, { userId, organizationId: activeOrganizationId })
    if (active) return { kind: 'enter', destination: organizationDestination(active) }
  }

  const organizations = await listUserOrganizations(env, userId)
  if (organizations.length === 0) {
    if ((await buyerActivities(env.DB, userId)).activities.length) return { kind: 'enter', destination: '/dashboard/account' }
    return { kind: 'onboard', destination: '/dashboard/onboarding' }
  }
  if (organizations.length > 1) return { kind: 'choose', destination: '/dashboard/select-organization' }

  const only = organizations[0]!
  const membership = await resolveUserOrganization(env, { userId, organizationId: only.id })
  if (!membership) throw new Error('Organization membership changed during sign-in; retry')
  return { kind: 'activate', organizationId: only.id, destination: organizationDestination(membership) }
}
