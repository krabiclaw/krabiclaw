import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readGoogleCalendarSettings } from '~/server/utils/google-calendar'
export default defineHandler(async event => {
 const id = getRouterParam(event, 'organization_id')
 if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
 return jsonResponse(await readGoogleCalendarSettings(event, id, getQuery(event).coverage === '1'))
})
