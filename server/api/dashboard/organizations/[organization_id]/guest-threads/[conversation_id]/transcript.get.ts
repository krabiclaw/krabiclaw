import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { parseTranscriptWindow } from '~/server/domain/conversations'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardGuestThread } from '~/server/utils/dashboard-guest-threads'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')!
  const threadId = getRouterParam(event, 'conversation_id')!
  const payload = await loadDashboardGuestThread(event, organizationId, threadId, parseTranscriptWindow(event.url.searchParams))
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-guest-transcript', payload))
})
