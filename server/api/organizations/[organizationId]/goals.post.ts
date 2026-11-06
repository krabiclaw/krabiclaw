import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createBusinessGoal } from '~/server/domain/business-progress'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organizationId is required' })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const goal = await createBusinessGoal(db, memberAccessPrincipal(organization.membership, { env, event }), await readRequiredBody(event))
  return jsonResponse({ goal }, { status: 201 })
})
