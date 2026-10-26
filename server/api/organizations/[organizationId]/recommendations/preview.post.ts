import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { previewRecommendations } from '~/server/domain/recommendation-preview'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organizationId is required' })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const preview = await previewRecommendations(db, memberAccessPrincipal(organization.membership, { env, event }), await readRequiredBody(event))
  return jsonResponse({ preview }, { headers: { 'cache-control': 'private, no-store' } })
})
