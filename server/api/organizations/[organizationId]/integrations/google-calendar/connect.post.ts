import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { execute } from '~/server/db'
import { INTEGRATION_SCOPES } from '~/shared/organization-settings'
import { jsonResponse } from '~/server/utils/api-response'
import { linkedAccountAccessToken, requireIntegrationAccount } from '~/server/utils/auth'
import { CalendarSelectionConflict, connectCalendar, ensureCalendarWatch, readCalendarIntegration, syncCalendarOrganization } from '~/server/utils/google-calendar'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { requireOrganizationAccess } from '~/server/utils/location-access'
export default defineHandler(async event => {
 const id = getRouterParam(event, 'organizationId')
 if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
 const { env, session, organization } = await requireOrganizationAccess(event, id)
 const body = await readBody<{ account_id?: string }>(event)
 if (typeof body?.account_id !== 'string' || !body.account_id.trim()) return jsonResponse({ error: 'Connect your Google account.' }, { status: 400 })
 if (!await hasOrganizationEntitlement(env, organization.id, 'calendar_sync')) return jsonResponse({ error: 'Google Calendar sync comes with the Business plan', code: 'ENTITLEMENT_REQUIRED', entitlement: 'calendar_sync' }, { status: 403 })
 const current = await readCalendarIntegration(env.DB, organization.id)
 await requireIntegrationAccount(env, body.account_id, { userId: session.user.id, currentAccountId: current?.account_id, providerId: 'google', scopes: INTEGRATION_SCOPES['google-calendar'] })
 try {
  await connectCalendar(env.DB, organization.id, body.account_id, (await linkedAccountAccessToken(env, body.account_id)).accessToken)
  if(current?.status==='error' && current.account_id===body.account_id)await execute(env.DB,'UPDATE google_calendar_event_links SET next_attempt_at=NULL WHERE organization_id=?',[organization.id])
  const result = await syncCalendarOrganization(env, organization.id)
  if (result.failed) throw new Error('Your calendar is connected, but bookings could not be synced. Retry to finish syncing.')
  // Google tells us when the calendar changes from now on; its change list is read from here.
  await ensureCalendarWatch(env, organization.id)
  return jsonResponse({ success: true })
 } catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof CalendarSelectionConflict ? 409 : 502 }) }
})
