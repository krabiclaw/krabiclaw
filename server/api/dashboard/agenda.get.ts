import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readDashboardAgenda } from '~/server/utils/dashboard-agenda-reader'

export default defineHandler(async event => jsonResponse(await readDashboardAgenda(event, getQuery(event))))
