import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { releaseIntegration } from '~/server/utils/integration-release'
import { requireOrganizationAccess } from '~/server/utils/location-access'

// Removes the webhook and its stored token; messages already in Discord stay.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { env, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{ revision?: string }>(event)
  const revision = body?.revision
  if (revision !== undefined && (typeof revision !== 'string' || !revision.trim())) {
    return jsonResponse({ error: 'Invalid connection revision' }, { status: 400 })
  }
  const result = await releaseIntegration(env, organization.id, 'discord', revision === undefined ? undefined : { revision })

  return jsonResponse({ success: true, ...result })
})
