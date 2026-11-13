import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardGuestThread } from '~/server/utils/dashboard-guest-threads'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')!
  const threadId = getRouterParam(event, 'conversation_id')!
  const values = event.url.searchParams.getAll('before')
  const before = values.length ? Number(values[0]) : null
  if (values.length > 1 || (before !== null && (!/^\d+$/.test(values[0]!) || !Number.isSafeInteger(before) || before < 1))) {
    throw new HTTPError({ statusCode: 400, message: 'Invalid transcript cursor', data: { code: 'INVALID_TRANSCRIPT_CURSOR', field: 'before' } })
  }
  const payload = await loadDashboardGuestThread(event, organizationId, threadId, { before, limit: 40 })
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-guest-transcript', payload))
})
