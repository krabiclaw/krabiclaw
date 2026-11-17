import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { vrboEnabled, vrboHomes } from '~/server/integrations/channex/hosted-channel'
import { jsonResponse } from '~/server/utils/api-response'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'Organization ID is required' })
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  if (!vrboEnabled(env)) {
    throw new HTTPError({ statusCode: 404, message: 'Vrbo setup is unavailable', data: { code: 'VRBO_UNAVAILABLE' } })
  }
  if (!await hasOrganizationEntitlement(env, organization.id, 'channel_sync')) {
    return jsonResponse({ entitled: false, homes: [] })
  }
  return jsonResponse({ entitled: true, homes: await vrboHomes(db, env, organization.id) })
})
