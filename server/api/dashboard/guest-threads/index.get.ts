import { jsonResponse } from '~/server/utils/api-response'
import { loadOrganizationGuestThreads, parseGuestThreadListQuery } from '~/server/utils/dashboard-guest-threads'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async (event) => {
  const payload = await loadOrganizationGuestThreads(event, parseGuestThreadListQuery(getQuery(event)))
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-organization-guest-threads', payload))
})
import { defineHandler } from 'nitro';
import { getQuery } from 'nitro/h3';
