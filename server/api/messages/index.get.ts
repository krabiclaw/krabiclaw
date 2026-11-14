import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { messageSession } from '~/server/utils/conversation-request'
import { guestThreadListPage, loadOrganizationConversations, parseGuestThreadListQuery } from '~/server/utils/dashboard-guest-threads'
import { listConversations } from '~/server/domain/guest-threads/repository'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  const { organization_id: organizationId, ...filters } = getQuery(event)
  const query = parseGuestThreadListQuery(filters)
  if (organizationId !== undefined) {
    if (typeof organizationId !== 'string' || !organizationId.trim()) throw new HTTPError({ statusCode: 400, message: 'Invalid workspace', data: { code: 'INVALID_ORGANIZATION', field: 'organization_id' } })
    const payload = await loadOrganizationConversations(event, organizationId, query)
    return jsonResponse(finalizeRequestMetrics(event, 'messages-list', payload))
  }
  if (query.locationId) throw new HTTPError({ statusCode: 400, message: 'A location filter requires a workspace', data: { code: 'INVALID_GUEST_THREAD_FILTER', field: 'location_id' } })
  const { db, user } = await messageSession(event)
  const threads = await listConversations(db, null, { ...query, limit: (query.limit ?? 100) + 1, userId: user.id, buyerAudience: true })
  return jsonResponse(finalizeRequestMetrics(event, 'messages-list', guestThreadListPage(threads, query)))
})
