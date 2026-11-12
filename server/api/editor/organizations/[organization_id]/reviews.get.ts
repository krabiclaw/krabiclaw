import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { listOrganizationReviews } from '~/server/utils/organization-reviews'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireOrganizationAccess(event, organizationId)
  const locationId = getQuery(event).location_id
  return jsonResponse({ reviews: await listOrganizationReviews(db, organizationId, { locationId: typeof locationId === 'string' ? locationId : null }) })
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam } from 'nitro/h3';
