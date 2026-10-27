import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readCalendarSync, setCalendarReschedules } from '~/server/utils/google-calendar-inbound'
import { requireOrganizationAccess } from '~/server/utils/location-access'

/** The one inbound choice: whether an event moved in Google moves its booking. Deletions are never applied. */
export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'organizationId')
  if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { env, organization } = await requireOrganizationAccess(event, id)
  const body = await readBody<{ reschedules?: unknown }>(event)
  if (typeof body?.reschedules !== 'boolean') return jsonResponse({ error: 'reschedules must be true or false' }, { status: 400 })
  await setCalendarReschedules(env.DB, organization.id, body.reschedules)
  return jsonResponse({ success: true, sync: await readCalendarSync(env.DB, organization.id) })
})
