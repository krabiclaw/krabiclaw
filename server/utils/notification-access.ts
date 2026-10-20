import { HTTPError, type H3Event } from 'nitro'
import { getQuery } from 'nitro/h3'
import { assignedBookingSql, isOrganizationWideRole } from '~/server/utils/member-access'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'

export interface NotificationVisibilityPrincipal {
  userId: string
  platformAdmin: boolean
  organization: {
    id: string
    role: string
  } | null
}

export function buildNotificationVisibilityFilter(principal: NotificationVisibilityPrincipal) {
  const clauses = [
    "n.kind = 'notification'",
    `(n.target_user_id IS NULL OR n.target_user_id = ?)`,
  ]
  const params: unknown[] = [principal.userId]
  const visibilityClauses: string[] = []

  // scope_kind is the column the CHECK constrains, so it is the only place a
  // notification's scope is read from.
  if (principal.platformAdmin && !principal.organization) visibilityClauses.push(`n.scope_kind = 'global' AND n.target_user_id IS NULL`)
  if (!principal.organization) visibilityClauses.push(`(n.scope_kind = 'global' AND n.target_user_id = ?)`)
  if (!principal.organization) params.push(principal.userId)

  if (principal.organization) {
    if (isOrganizationWideRole(principal.organization.role)) {
      visibilityClauses.push(`(n.scope_kind = 'organization' AND n.organization_id = ?)`)
      params.push(principal.organization.id)
    } else if (principal.organization.role === 'member') {
      visibilityClauses.push(`(n.scope_kind = 'organization' AND n.organization_id = ? AND n.target_user_id = ?
        AND EXISTS (SELECT 1 FROM activity_entries source JOIN bookings b ON b.request_id = source.request_id
          WHERE source.id = n.parent_id AND b.organization_id = n.organization_id AND (${assignedBookingSql('b')})))`)
      params.push(principal.organization.id, principal.userId, principal.userId)
    }
  }

  clauses.push(visibilityClauses.length > 0 ? `(${visibilityClauses.join(' OR ')})` : '0 = 1')

  return {
    whereSql: clauses.join(' AND '),
    whereParams: params,
  }
}

export async function getNotificationAccess(event: H3Event) {
  const context = await getDashboardMemberContext(event, { requireOrganization: false })
  const scope = getQuery(event).scope
  if (scope !== undefined && scope !== 'personal') throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid notification scope' })
  const personal = scope === 'personal'
  const organization = personal ? null : context.organization
  const platformAdmin = !personal && await hasPlatformEventPermission(event, context.env, { platform: ['access'] })
  const filter = buildNotificationVisibilityFilter({
    userId: context.userId,
    platformAdmin,
    organization,
  })

  return {
    ...context,
    organization,
    ...filter,
  }
}
