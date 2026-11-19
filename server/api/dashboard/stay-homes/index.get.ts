import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readDashboardStayHomes } from '~/server/utils/dashboard-stay-homes'

export default defineHandler(async event => jsonResponse(await readDashboardStayHomes(event, undefined, getQuery(event).view === 'calendar')))
