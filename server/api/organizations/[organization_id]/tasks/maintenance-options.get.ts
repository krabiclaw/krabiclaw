import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { maintenanceOptions } from '~/server/domain/tasks'
import { organizationSession } from '~/server/utils/location-access'

/** Where a maintenance job can be sent and who can do it, for the sheet that creates one: one D1 round trip with the caller's membership. */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organization_id is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'organization_id' } })
  const { db, session } = await organizationSession(event)
  return jsonResponse(await maintenanceOptions(db, { organizationId, userId: session.user.id }), { headers: { 'cache-control': 'private, no-store' } })
})
