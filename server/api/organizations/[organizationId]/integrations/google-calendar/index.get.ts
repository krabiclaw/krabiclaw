import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { readCalendarIntegration } from '~/server/utils/google-calendar'
import { requireOrganizationAccess } from '~/server/utils/location-access'
export default defineHandler(async event => {
 const id = getRouterParam(event, 'organizationId')
 if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
 const { env, organization } = await requireOrganizationAccess(event, id)
 const calendar=await readCalendarIntegration(env.DB,organization.id)
 const pending=calendar?.status==='disabled'?await queryFirst<{n:number}>(env.DB,"SELECT count(*) n FROM google_calendar_event_links WHERE organization_id=? AND state<>'deleted'",[organization.id]):null
 return jsonResponse({calendar,cleanup_pending:Boolean(pending?.n)})
})
