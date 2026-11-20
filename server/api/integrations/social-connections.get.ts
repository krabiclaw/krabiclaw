import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardLocationQuery, dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { dashboardOrigin } from '~/server/utils/dashboard-notification-links'
import { prepareSocialConnections, presentSocialConnections } from '~/server/utils/social-publication'

export default defineHandler(async event => {
  const query = getQuery(event)
  if (query.organizationId !== undefined && (typeof query.organizationId !== 'string' || !query.organizationId.trim())
    || query.locationId !== undefined && typeof query.locationId !== 'string') throw new HTTPError({ statusCode: 400, message: 'Invalid publishing scope' })
  const slug = dashboardOrgQueryParam(event)
  const target = typeof query.organizationId === 'string' ? query.organizationId : slug ? { slug } : null
  if (!target) throw new HTTPError({ statusCode: 400, message: 'A workspace is required' })
  const locationId = typeof query.locationId === 'string' && query.locationId ? query.locationId : null
  const location = locationId ? dashboardLocationQuery({ id: locationId }, { sql: BATCH_VIEWER.organization }, BATCH_VIEWER) : null
  const scope = location ? { query: `SELECT organization_id, id AS location_id FROM (${location.query})`, params: location.params } : undefined
  const plan = prepareSocialConnections({ sql: BATCH_VIEWER.organization }, scope)
  const { env, db, organization, rows } = await readDashboardMemberResources(event, target, plan.queries)
  if (!locationId) await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  return jsonResponse(presentSocialConnections(organization.id,
    { dashboardBase: dashboardOrigin(env, { orgSlug: organization.slug, locationSlug: null }) }, plan.read(rows, organization.id)))
})
