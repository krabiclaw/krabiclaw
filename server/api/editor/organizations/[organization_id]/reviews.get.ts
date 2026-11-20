import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { prepareOrganizationReviews } from '~/server/utils/organization-reviews'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'Organization ID required' })
  const locationId = getQuery(event).location_id
  if (locationId !== undefined && typeof locationId !== 'string') throw new HTTPError({ statusCode: 400, message: 'Invalid location scope' })
  const plan = prepareOrganizationReviews({ sql: BATCH_VIEWER.organization }, { locationId: typeof locationId === 'string' ? locationId.trim() : null })
  const { db, env, organization, rows } = await readDashboardMemberResources(event, organizationId, plan.queries)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  return jsonResponse({ reviews: plan.read(rows, organization.id) })
})
