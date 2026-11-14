import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardCatalog } from '~/server/utils/dashboard-catalog'

export default defineHandler(async event => jsonResponse(await loadDashboardCatalog(event)))
