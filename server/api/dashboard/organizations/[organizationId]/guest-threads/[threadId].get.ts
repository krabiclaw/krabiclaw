import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardGuestThread } from '~/server/utils/dashboard-guest-threads'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const threadId = getRouterParam(event, 'threadId')
  if (!organizationId || !threadId) return jsonResponse({ error: 'Missing params', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })

  const payload = await loadDashboardGuestThread(event, organizationId, threadId)
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-guest-thread', payload))
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
