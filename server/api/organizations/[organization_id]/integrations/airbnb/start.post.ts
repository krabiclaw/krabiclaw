import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { ChannexConnection } from '~/server/integrations/channex/channel-connection'
import { platformOrigin } from '~/server/utils/dashboard-notification-links'
import { hasOrganizationEntitlement } from '~/server/utils/billing'

// A single-use Airbnb sign-in link for the person asking.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  if (!await hasOrganizationEntitlement(env, organization.id, 'channel_sync')) return jsonResponse({ error: 'Airbnb sync comes with the Business plan', code: 'ENTITLEMENT_REQUIRED', entitlement: 'channel_sync' }, { status: 403 })
  const connection = new ChannexConnection(env.DB, env, organization.id, session.user.id)
  const callback = getQuery(event).client === 'web'
    ? new URL(`/dashboard/${encodeURIComponent(organization.slug)}/integrations/airbnb`, platformOrigin(env)).href
    : undefined
  return jsonResponse(await connection.start(callback))
})
