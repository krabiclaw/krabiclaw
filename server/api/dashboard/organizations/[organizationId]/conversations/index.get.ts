import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { loadOrganizationConversations, parseGuestThreadListQuery } from '~/server/utils/dashboard-guest-threads'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { messageText } from '~/server/domain/guest-message-schedule'

/** Every conversation the member sees (guests, Airbnb Support, the team), newest first, with the unread counts of each kind. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const payload = await loadOrganizationConversations(event, organizationId, parseGuestThreadListQuery(getQuery(event)))
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-conversations', payload))
})
