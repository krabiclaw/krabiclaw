import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'

import { disconnectCalendar } from '~/server/utils/google-calendar'
import { stopCalendarWatch } from '~/server/utils/google-calendar-inbound'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'organizationId')
  if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { env, organization } = await requireOrganizationAccess(event, id)
  await disconnectCalendar(env.DB, organization.id)
  await stopCalendarWatch(env, organization.id)
  return jsonResponse({ success: true, cleanup_pending: true })
})
