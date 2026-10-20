import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getQuery } from 'nitro/h3'
import { loadDashboardToday, parseTodayFeedQuery } from '~/server/utils/dashboard-today'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async (event) => {
  const today = await loadDashboardToday(event, parseTodayFeedQuery(getQuery(event)))
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-today', today), { headers: { 'cache-control': 'private, no-store' } })
})
