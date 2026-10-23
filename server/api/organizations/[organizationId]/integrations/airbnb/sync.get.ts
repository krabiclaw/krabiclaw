import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { readAirbnbSync } from '~/server/integrations/channex/airbnb-sync'

// Where each listing this organization asked to sync or stop stands: queued, running (with its stage), done or failed.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required', code: 'VALIDATION_ERROR', field: 'organizationId' }, { status: 400 })
  const { env, organization } = await requireOrganizationAccess(event, organizationId)
  return jsonResponse({ listings: await readAirbnbSync(env.DB, organization.id) })
})
