import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { messageText } from '~/server/domain/guest-message-schedule'
import { jsonResponse } from '~/server/utils/api-response'
import { loadOrganizationConversationUnread } from '~/server/utils/dashboard-guest-threads'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organization_id'), 'organization_id', 200)
  const unread = await loadOrganizationConversationUnread(event, organizationId)
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-conversation-unread', { unread }))
})
