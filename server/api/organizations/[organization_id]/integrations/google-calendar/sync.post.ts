import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { publishEvent } from '~/server/events'
import { syncCalendarOrganization } from '~/server/utils/google-calendar'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'organization_id')
  if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { env, organization } = await requireOrganizationAccess(event, id)
  const { checked, failed, remaining } = await syncCalendarOrganization(env, organization.id)
  if (remaining !== undefined) await publishEvent(env, { type: 'calendar.changed', organization_id: organization.id, booking_id: null })
  if (failed) return jsonResponse({ error: 'Your calendar could not be synced. Try again.', checked, failed, remaining }, { status: 502 })
  return jsonResponse({ success: true, checked, failed, remaining })
})
