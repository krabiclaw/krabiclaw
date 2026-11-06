import { HTTPError, type H3Event } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { taskViewer } from '~/server/domain/tasks'

/** The organization a task or opportunity route names, and the caller as its domain reads them. */
export async function taskRouteContext(event: H3Event) {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organizationId is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'organizationId' } })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  return { db, env, principal, viewer: () => taskViewer(db, principal) }
}

export function routeId(event: H3Event, name: 'taskId' | 'opportunityId'): string {
  const id = getRouterParam(event, name)
  if (!id) throw new HTTPError({ statusCode: 400, message: `${name} is required`, data: { code: 'ID_REQUIRED', field: name } })
  return id
}
