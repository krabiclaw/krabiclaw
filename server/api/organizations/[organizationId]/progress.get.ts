import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { readBusinessProgress } from '~/server/domain/business-progress'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organizationId is required' })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const query = getQuery(event)
  return jsonResponse(await readBusinessProgress(db, memberAccessPrincipal(organization.membership, { env, event }), {
    limit: query.limit === undefined ? undefined : Number(query.limit),
    offset: query.offset === undefined ? undefined : Number(query.offset),
  }))
})
