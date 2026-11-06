import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { updateBusinessGoal } from '~/server/domain/business-progress'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId'), goalId = getRouterParam(event, 'goalId')
  if (!organizationId || !goalId) throw new HTTPError({ statusCode: 400, message: 'organizationId and goalId are required' })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const goal = await updateBusinessGoal(db, memberAccessPrincipal(organization.membership, { env, event }), goalId, await readRequiredBody(event))
  return jsonResponse({ goal })
})
