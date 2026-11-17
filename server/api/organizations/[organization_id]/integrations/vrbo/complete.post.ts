import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { vrboEnabled } from '~/server/integrations/channex/hosted-channel'
import { ChannexConnection } from '~/server/integrations/channex/channel-connection'
import { jsonResponse } from '~/server/utils/api-response'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'Organization ID is required' })
  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)
  if (!vrboEnabled(env)) {
    throw new HTTPError({ statusCode: 404, message: 'Vrbo setup is unavailable', data: { code: 'VRBO_UNAVAILABLE' } })
  }
  if (!await hasOrganizationEntitlement(env, organization.id, 'channel_sync')) {
    throw new HTTPError({ statusCode: 403, message: 'Vrbo sync comes with the Business plan', data: { code: 'ENTITLEMENT_REQUIRED', entitlement: 'channel_sync' } })
  }
  const body = await readBody<{ product_id?: unknown }>(event)
  if (typeof body?.product_id !== 'string' || !body.product_id.trim()) {
    throw new HTTPError({ statusCode: 422, message: 'Select a home to connect', data: { code: 'VALIDATION_ERROR', field: 'product_id' } })
  }
  await new ChannexConnection(db, env, organization.id, session.user.id).finishHostedProperty(body.product_id)
  return jsonResponse({ success: true })
})
