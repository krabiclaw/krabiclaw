import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardGuestThreads, parseGuestThreadListQuery } from '~/server/utils/dashboard-guest-threads'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const payload = await loadDashboardGuestThreads(event, organizationId, parseGuestThreadListQuery(getQuery(event)))
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-guest-threads', payload))
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
