import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { readBusinessProgressReference } from '~/server/utils/business-outcomes'
import { businessProgressReferenceSchema } from '~/shared/business-progress'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organizationId is required' })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const parsed = businessProgressReferenceSchema.safeParse(getQuery(event))
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'An explicit operation and subjectId are required', data: parsed.error.flatten() })
  const reference = await readBusinessProgressReference(db, memberAccessPrincipal(organization.membership, { env, event }), parsed.data)
  return jsonResponse({ reference })
})
